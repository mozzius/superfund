import { Jetstream } from "@skyware/jetstream";
import { createLabellerClient } from "labeller-client";
import { createRedis } from "./redis.ts";
import { claimedRoot, isFuckedUpReply } from "./classify.ts";
import { CursorTracker } from "./cursor-tracker.ts";
import { createPostStore } from "./post-store.ts";

const labellerUrl = process.env.LABELLER_URL;
const internalApiKey = process.env.INTERNAL_API_KEY;
const redisUrl = process.env.REDIS_URL;
if (!labellerUrl || !internalApiKey) {
  throw new Error("LABELLER_URL and INTERNAL_API_KEY must be set");
}

const postCacheTtlSeconds = Number(process.env.POST_CACHE_TTL_DAYS ?? 7) * 86_400;
const accountLabelMs = 30 * 86_400 * 1000;
const volumePath = process.env.RAILWAY_VOLUME_MOUNT_PATH;
const postStorePath =
  process.env.POST_STORE_PATH ?? (volumePath ? `${volumePath}/posts.db` : "./posts.db");

const labeller = createLabellerClient({ url: labellerUrl, apiKey: internalApiKey });
let legacyRedis: Awaited<ReturnType<typeof createRedis>> | undefined;
if (redisUrl) {
  try {
    legacyRedis = await createRedis(redisUrl);
  } catch (err) {
    console.warn("legacy Redis unavailable; continuing with SQLite only", err);
  }
}
const redisFallback = legacyRedis;
let redisFallbackWarningLogged = false;
const legacyGetClaimedRoot = redisFallback
  ? async (uri: string): Promise<string | null> => {
      if (!redisFallback.isReady) return null;
      try {
        const root = await redisFallback.get(`post:${uri}`);
        redisFallbackWarningLogged = false;
        return root;
      } catch (err) {
        if (!redisFallbackWarningLogged) {
          console.warn("legacy Redis lookup failed; treating it as a cache miss", err);
          redisFallbackWarningLogged = true;
        }
        return null;
      }
    }
  : undefined;

const posts = createPostStore({
  dbPath: postStorePath,
  ttlMs: postCacheTtlSeconds * 1000,
  legacyGetClaimedRoot,
});
const cursor = new CursorTracker(posts);

if (posts.loadCursor() === undefined && legacyRedis) {
  try {
    const rawCursor = legacyRedis.isReady
      ? await legacyRedis.get("ingester:cursor")
      : null;
    const legacyCursor = Number(rawCursor);
    if (rawCursor && Number.isFinite(legacyCursor)) {
      posts.updateCursor(legacyCursor);
      posts.flush();
      console.log("migrated Jetstream cursor from Redis to SQLite");
    }
  } catch (err) {
    console.warn(
      "legacy Redis cursor migration failed; continuing with SQLite only",
      err,
    );
  }
}
console.log(
  `post store ready path=${postStorePath} legacyRedisFallback=${Boolean(legacyRedis)}`,
);

const makeStats = () => ({
  posts: 0,
  replies: 0,
  matched: 0,
  labelled: 0,
  errors: 0,
  skipped: 0,
  labellerCalls: 0,
  labellerErrors: 0,
  labellerTotalMs: 0,
  labellerMaxMs: 0,
});
let stats = makeStats();
const totals = makeStats();
const fmtMB = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)}MB`;
const HEARTBEAT_MS = 10_000;
let lastHeartbeatAt = Date.now();
const heartbeat = setInterval(() => {
  lastHeartbeatAt = Date.now();
  const window = stats;
  stats = makeStats();
  const mem = process.memoryUsage();
  const avgCallMs = window.labellerCalls
    ? Math.round(window.labellerTotalMs / window.labellerCalls)
    : 0;
  const postsPerSec = (window.posts / (HEARTBEAT_MS / 1000)).toFixed(1);
  console.log(
    `[stats 10s] posts=${window.posts} (${postsPerSec}/s) replies=${window.replies} ` +
      `matched=${window.matched} labelled=${window.labelled} errors=${window.errors} ` +
      `skipped=${window.skipped} ` +
      `labellerCalls=${window.labellerCalls} labellerErrors=${window.labellerErrors} ` +
      `avgCallMs=${avgCallMs} maxCallMs=${window.labellerMaxMs} ` +
      `rss=${fmtMB(mem.rss)} heap=${fmtMB(mem.heapUsed)}/${fmtMB(mem.heapTotal)} ` +
      `totalPosts=${totals.posts} totalLabelled=${totals.labelled} totalErrors=${totals.errors} ` +
      `uptimeSec=${Math.round(process.uptime())}`,
  );
}, HEARTBEAT_MS);
heartbeat.unref();

// Watchdog: if the heartbeat hasn't run in ~3 intervals the event loop is
// likely stalled (not just jetstream silence — a blocked loop would prevent
// the stats interval from firing too). Exit so Railway restarts us.
const STALL_THRESHOLD_MS = HEARTBEAT_MS * 3;
const stallWatchdog = setInterval(() => {
  const sinceMs = Date.now() - lastHeartbeatAt;
  if (sinceMs > STALL_THRESHOLD_MS) {
    console.error(
      `[watchdog] heartbeat stalled for ${Math.round(sinceMs / 1000)}s — exiting`,
    );
    process.exit(1);
  }
}, HEARTBEAT_MS);
stallWatchdog.unref();

const bump = (key: keyof ReturnType<typeof makeStats>, by = 1) => {
  stats[key] += by;
  totals[key] += by;
};

const timeLabellerCall = async <T>(label: string, fn: () => Promise<T>): Promise<T> => {
  const startedAt = Date.now();
  bump("labellerCalls");
  try {
    const result = await fn();
    const durMs = Date.now() - startedAt;
    bump("labellerTotalMs", durMs);
    if (durMs > stats.labellerMaxMs) stats.labellerMaxMs = durMs;
    if (durMs > totals.labellerMaxMs) totals.labellerMaxMs = durMs;
    return result;
  } catch (err) {
    const durMs = Date.now() - startedAt;
    bump("labellerErrors");
    bump("labellerTotalMs", durMs);
    if (durMs > stats.labellerMaxMs) stats.labellerMaxMs = durMs;
    if (durMs > totals.labellerMaxMs) totals.labellerMaxMs = durMs;
    console.error(`[labeller-call] ${label} failed after ${durMs}ms`, err);
    throw err;
  }
};

const RETRY_ATTEMPTS = 3;
const withRetry = async <T>(fn: () => Promise<T>): Promise<T> => {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= RETRY_ATTEMPTS) throw err;
      const backoffMs = 1000 * 2 ** (attempt - 1);
      console.warn(`[retry] attempt ${attempt}/${RETRY_ATTEMPTS} failed, retrying in ${backoffMs}ms`, err);
      await new Promise((r) => setTimeout(r, backoffMs));
    }
  }
};

process.on("uncaughtException", (err) => {
  console.error("[fatal] uncaughtException", err);
});
process.on("unhandledRejection", (reason) => {
  console.error("[fatal] unhandledRejection", reason);
});

// Watchdog: jetstream sometimes goes silent without firing 'close', leaving
// the WS half-open and the process stuck at 0 events. If we haven't seen a
// post in WATCHDOG_STALL_MS, force-close so the existing reconnect path runs.
const WATCHDOG_STALL_MS = 60_000;
const WATCHDOG_INTERVAL_MS = 15_000;
let lastEventAt = Date.now();

// Backpressure: @skyware/jetstream emits events synchronously via tiny-emitter
// and does not await the async listener, so without a limit we'd have unbounded
// concurrent processing. Cap in-flight events; excess events are dropped.
const MAX_INFLIGHT = 100;
let inFlight = 0;

async function connect() {
  const jetstream = new Jetstream({
    wantedCollections: ["app.bsky.feed.post"],
    endpoint: process.env.JETSTREAM_ENDPOINT,
    cursor: posts.loadCursor(),
  });

  lastEventAt = Date.now();
  let reconnectScheduled = false;
  const scheduleReconnect = (reason: string) => {
    if (reconnectScheduled) return;
    reconnectScheduled = true;
    clearInterval(watchdog);
    console.warn(`[ingester] reconnecting (${reason})`);
    setTimeout(() => void connect(), 3000);
  };
  const watchdog = setInterval(() => {
    const sinceMs = Date.now() - lastEventAt;
    if (sinceMs > WATCHDOG_STALL_MS) {
      console.warn(
        `[watchdog] no jetstream events for ${Math.round(sinceMs / 1000)}s, forcing reconnect`,
      );
      try {
        jetstream.close();
      } catch (err) {
        console.error("[watchdog] close failed", err);
      }
      scheduleReconnect("watchdog stall");
    }
  }, WATCHDOG_INTERVAL_MS);
  watchdog.unref();

  jetstream.onCreate("app.bsky.feed.post", async (event) => {
    lastEventAt = Date.now();

    if (inFlight >= MAX_INFLIGHT) {
      bump("skipped");
      console.warn(`[backpressure] inFlight=${inFlight}, skipping ${event.time_us}`);
      cursor.skip(event.time_us);
      return;
    }
    inFlight++;
    const completeCursor = cursor.begin(event.time_us);

    const did = event.did;
    const uri = `at://${did}/app.bsky.feed.post/${event.commit.rkey}`;
    const record = event.commit.record;
    bump("posts");
    if (record.reply) bump("replies");

    try {
      posts.setPost(uri, claimedRoot(uri, record));

      if (await isFuckedUpReply(record, posts)) {
        bump("matched");
        console.log(`[match] fucked-up-replyref uri=${uri} did=${did}`);
        await Promise.all([
          timeLabellerCall("createLabels", () =>
            withRetry(() =>
              labeller.createLabels({
                subject: { uri, cid: event.commit.cid },
                create: ["fucked-up-replyref"],
              }),
            ),
          ),
          timeLabellerCall("upsertLabel", () =>
            withRetry(() =>
              labeller.upsertLabel({
                subject: { uri: did },
                val: "doesnt-know-how-replyrefs-work",
                expiresInMs: accountLabelMs,
              }),
            ),
          ),
        ]);
        bump("labelled");
        console.log(`[labelled] ${uri}`);
      }
    } catch (err) {
      bump("errors");
      console.error(`failed to process ${uri}`, err);
    } finally {
      inFlight--;
      // Advance only through the contiguous prefix of completed handlers so a
      // crash cannot checkpoint past older work that is still in flight.
      completeCursor();
    }
  });

  jetstream.on("open", () => console.log("jetstream connected"));
  jetstream.on("close", () => scheduleReconnect("jetstream closed"));
  jetstream.on("error", (err) => console.error("jetstream error", err));

  jetstream.start();
}

const shutdown = async () => {
  posts.close();
  await legacyRedis?.quit();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

await connect();
