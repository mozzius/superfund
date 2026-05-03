import { Jetstream } from "@skyware/jetstream";
import { createLabellerClient } from "labeller-client";
import { createRedis } from "./redis.ts";
import { claimedRoot, isFuckedUpReply } from "./classify.ts";
import { createCursorStore } from "./cursor.ts";

const labellerUrl = process.env.LABELLER_URL;
const internalApiKey = process.env.INTERNAL_API_KEY;
const redisUrl = process.env.REDIS_URL;
if (!labellerUrl || !internalApiKey || !redisUrl) {
  throw new Error("LABELLER_URL, INTERNAL_API_KEY, and REDIS_URL must be set");
}

const postCacheTtlSeconds = Number(process.env.POST_CACHE_TTL_DAYS ?? 7) * 86_400;
const accountLabelMs = 30 * 86_400 * 1000;

const labeller = createLabellerClient({ url: labellerUrl, apiKey: internalApiKey });
const redis = await createRedis(redisUrl);
const cursor = createCursorStore(redis);

const makeStats = () => ({
  posts: 0,
  replies: 0,
  matched: 0,
  labelled: 0,
  errors: 0,
  labellerCalls: 0,
  labellerErrors: 0,
  labellerTotalMs: 0,
  labellerMaxMs: 0,
});
let stats = makeStats();
const totals = makeStats();
const fmtMB = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)}MB`;
const HEARTBEAT_MS = 10_000;
const heartbeat = setInterval(() => {
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
      `labellerCalls=${window.labellerCalls} labellerErrors=${window.labellerErrors} ` +
      `avgCallMs=${avgCallMs} maxCallMs=${window.labellerMaxMs} ` +
      `rss=${fmtMB(mem.rss)} heap=${fmtMB(mem.heapUsed)}/${fmtMB(mem.heapTotal)} ` +
      `totalPosts=${totals.posts} totalLabelled=${totals.labelled} totalErrors=${totals.errors} ` +
      `uptimeSec=${Math.round(process.uptime())}`,
  );
}, HEARTBEAT_MS);
heartbeat.unref();

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

process.on("uncaughtException", (err) => {
  console.error("[fatal] uncaughtException", err);
});
process.on("unhandledRejection", (reason) => {
  console.error("[fatal] unhandledRejection", reason);
});

async function connect() {
  const jetstream = new Jetstream({
    wantedCollections: ["app.bsky.feed.post"],
    endpoint: process.env.JETSTREAM_ENDPOINT,
    cursor: await cursor.load(),
  });

  jetstream.onCreate("app.bsky.feed.post", async (event) => {
    cursor.update(event.time_us);
    const did = event.did;
    const uri = `at://${did}/app.bsky.feed.post/${event.commit.rkey}`;
    const record = event.commit.record;
    bump("posts");
    if (record.reply) bump("replies");

    try {
      await redis.set(`post:${uri}`, claimedRoot(uri, record), { EX: postCacheTtlSeconds });

      if (await isFuckedUpReply(record, redis)) {
        bump("matched");
        console.log(`[match] fucked-up-replyref uri=${uri} did=${did}`);
        await Promise.all([
          timeLabellerCall("createLabels", () =>
            labeller.createLabels({
              subject: { uri, cid: event.commit.cid },
              create: ["fucked-up-replyref"],
            }),
          ),
          timeLabellerCall("upsertLabel", () =>
            labeller.upsertLabel({
              subject: { uri: did },
              val: "doesnt-know-how-replyrefs-work",
              expiresInMs: accountLabelMs,
            }),
          ),
        ]);
        bump("labelled");
        console.log(`[labelled] ${uri}`);
      }
    } catch (err) {
      bump("errors");
      console.error(`failed to process ${uri}`, err);
    }
  });

  jetstream.on("open", () => console.log("jetstream connected"));
  jetstream.on("close", () => {
    console.warn("jetstream closed, reconnecting in 3s");
    setTimeout(() => void connect(), 3000);
  });
  jetstream.on("error", (err) => console.error("jetstream error", err));

  jetstream.start();
}

const shutdown = async () => {
  await cursor.flush();
  await redis.quit();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

await connect();
