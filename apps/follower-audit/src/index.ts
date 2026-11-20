import { Jetstream } from "@skyware/jetstream";
import { createLabellerClient, FOLLOWER_TAKEDOWN_LABEL_VALUES } from "labeller-client";
import { evaluateAccount, type AuditDeps } from "./audit.ts";
import { loadConfig } from "./config.ts";
import {
  fetchFollowerSample,
  fetchRepoStatus,
  fetchVisibleProfiles,
  requestStats,
} from "./sources.ts";
import { AuditStore } from "./store.ts";

const labellerUrl = process.env.LABELLER_URL;
const internalApiKey = process.env.INTERNAL_API_KEY;
if (!labellerUrl || !internalApiKey) {
  throw new Error("LABELLER_URL and INTERNAL_API_KEY must be set");
}

const config = loadConfig();
const labeller = createLabellerClient({ url: labellerUrl, apiKey: internalApiKey });
const store = new AuditStore({
  dbPath: config.dbPath,
  activeTtlMs: config.activeTtlMs,
  inactiveTtlMs: config.inactiveTtlMs,
  evaluationTtlMs: config.labelExpiryMs,
  maxQueue: config.maxQueue,
});
console.log(`audit store ready path=${config.dbPath} queued=${store.queueSize}`);

const deps: AuditDeps = {
  store,
  followerSample: (did, limit) => fetchFollowerSample(config.constellation, did, limit),
  visibleProfiles: (dids) => fetchVisibleProfiles(config.appview, dids),
  repoStatus: (did) => fetchRepoStatus(config.relay, did),
  setLabel: async (did, label) => {
    await labeller.setLabelGroup({
      subject: { uri: did },
      group: FOLLOWER_TAKEDOWN_LABEL_VALUES,
      val: label,
      expiresInMs: config.labelExpiryMs,
    });
  },
};

const makeStats = () => ({
  posts: 0,
  accountEvents: 0,
  takedownEvents: 0,
  enqueued: 0,
  evaluated: 0,
  skipped: 0,
  labelled: 0,
  cleared: 0,
  errors: 0,
  cacheHits: 0,
  relayLookups: 0,
});
let stats = makeStats();

// --- Jetstream: posts give us candidates, #account events keep the status cache fresh.

const recentlySeen = new Set<string>();
let latestCursor = store.loadCursor();
let savedCursor = latestCursor;
let lastEventAt = Date.now();

const cursorFlush = setInterval(() => {
  if (latestCursor !== undefined && latestCursor !== savedCursor) {
    store.saveCursor(latestCursor);
    savedCursor = latestCursor;
  }
}, 5_000);
cursorFlush.unref();

function connect() {
  const jetstream = new Jetstream({
    wantedCollections: ["app.bsky.feed.post"],
    endpoint: process.env.JETSTREAM_ENDPOINT,
    cursor: latestCursor,
  });
  let retired = false;
  const reconnect = (reason: string) => {
    if (retired) return;
    retired = true;
    clearInterval(watchdog);
    try {
      jetstream.close();
    } catch (err) {
      console.error("[jetstream] close failed", err);
    }
    console.warn(`[jetstream] reconnecting (${reason})`);
    setTimeout(connect, 3000);
  };
  lastEventAt = Date.now();
  const watchdog = setInterval(() => {
    if (Date.now() - lastEventAt > 60_000) reconnect("no events for 60s");
  }, 15_000);
  watchdog.unref();

  jetstream.onCreate("app.bsky.feed.post", (event) => {
    if (retired) return;
    lastEventAt = Date.now();
    latestCursor = event.time_us;
    stats.posts++;
    if (recentlySeen.has(event.did)) return;
    if (recentlySeen.size > 200_000) recentlySeen.clear();
    recentlySeen.add(event.did);
    try {
      if (store.enqueueIfDue(event.did, config.reevaluateMs)) stats.enqueued++;
    } catch (err) {
      console.error("[enqueue] failed", err);
    }
  });

  jetstream.on("account", (event) => {
    if (retired) return;
    latestCursor = event.time_us;
    stats.accountEvents++;
    const { did, active, status } = event.account;
    if (status === "takendown") stats.takedownEvents++;
    try {
      store.applyAccountEvent(did, active, status);
    } catch (err) {
      console.error("[account] failed to record status", err);
    }
  });

  jetstream.on("open", () => console.log("[jetstream] connected"));
  jetstream.on("close", () => reconnect("closed"));
  jetstream.on("error", (err) => console.error("[jetstream] error", err));
  jetstream.start();
}

// --- Workers: drain the queue, rate limited per upstream.

let stopping = false;
async function worker(id: number) {
  while (!stopping) {
    const did = store.dequeue();
    if (!did) {
      await new Promise((r) => setTimeout(r, 5_000));
      continue;
    }
    try {
      const r = await evaluateAccount(did, deps, config);
      stats.evaluated++;
      stats.cacheHits += r.cacheHits;
      stats.relayLookups += r.relayLookups;
      if (r.skipped) stats.skipped++;
      if (r.labelCall === "set") stats.labelled++;
      if (r.labelCall === "clear") stats.cleared++;
      if (!r.skipped) {
        console.log(
          `[audit w${id}] did=${did} followers=${r.followers} sampled=${r.sampled} ` +
            `counted=${r.counted} takendown=${r.takendown} pct=${r.percent?.toFixed(1)} ` +
            `bucket=${r.previousBucket ?? "-"}->${r.bucket} label=${r.label ?? "-"} ` +
            `cacheHits=${r.cacheHits} relay=${r.relayLookups}`,
        );
      }
    } catch (err) {
      stats.errors++;
      console.error(`[audit w${id}] failed did=${did}`, err);
    }
  }
}

// --- Housekeeping.

const STATS_MS = 60_000;
let lastHeartbeatAt = Date.now();
const heartbeat = setInterval(() => {
  lastHeartbeatAt = Date.now();
  const s = stats;
  stats = makeStats();
  const reqs = Object.entries(requestStats.requests)
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");
  requestStats.requests = {};
  const mem = process.memoryUsage();
  console.log(
    `[stats 60s] posts=${s.posts} accountEvents=${s.accountEvents} takedowns=${s.takedownEvents} ` +
      `enqueued=${s.enqueued} queue=${store.queueSize} evaluated=${s.evaluated} skipped=${s.skipped} ` +
      `labelled=${s.labelled} cleared=${s.cleared} errors=${s.errors} cacheHits=${s.cacheHits} ` +
      `relayLookups=${s.relayLookups} reqs[${reqs}] retries=${requestStats.retries} ` +
      `rss=${(mem.rss / 1048576).toFixed(1)}MB uptimeSec=${Math.round(process.uptime())}`,
  );
}, STATS_MS);
heartbeat.unref();

const stallWatchdog = setInterval(() => {
  if (Date.now() - lastHeartbeatAt > STATS_MS * 3) {
    console.error("[watchdog] heartbeat stalled — exiting");
    process.exit(1);
  }
}, STATS_MS);
stallWatchdog.unref();

const pruneTimer = setInterval(() => {
  try {
    const startedAt = Date.now();
    const deleted = store.prune();
    console.log(`[prune] deleted=${deleted} durMs=${Date.now() - startedAt}`);
  } catch (err) {
    console.error("[prune] failed", err);
  }
}, 60 * 60_000);
pruneTimer.unref();

process.on("uncaughtException", (err) => console.error("[fatal] uncaughtException", err));
process.on("unhandledRejection", (reason) => console.error("[fatal] unhandledRejection", reason));

const shutdown = () => {
  stopping = true;
  if (latestCursor !== undefined) store.saveCursor(latestCursor);
  store.close();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

connect();
for (let i = 0; i < config.concurrency; i++) void worker(i);
