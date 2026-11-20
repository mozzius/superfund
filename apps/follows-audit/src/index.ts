/**
 * Labels accounts by the share of the accounts they follow, and of their
 * followers, that have been taken down (or suspended).
 *
 * Discovery runs off takedowns, not posts: when the firehose says an account
 * was taken down or suspended, or Bluesky's mod service labels it `!takedown`
 * / `!suspend` (which also covers appview-only takedowns the firehose never
 * sees), Constellation's backlinks give us who followed it, and each of those
 * followers gets a "hit". Accounts that follow lots of freshly taken-down
 * accounts float to the top of the candidate list and get a full audit of
 * their follows.
 */
import { Jetstream } from "@skyware/jetstream";
import { createLabellerClient, TAKEDOWN_LABEL_FAMILIES, type AuditDirection } from "labeller-client";
import { evaluateAccount, TAKEDOWN_STATUSES, type AuditDeps } from "./audit.ts";
import { loadConfig } from "./config.ts";
import { createDataServer } from "./data-server.ts";
import {
  isAccountTakedownLabel,
  isExpired,
  MOD_TAKEDOWN_LABELS,
  subscribeLabelStream,
} from "./mod-labels.ts";
import {
  fetchFollowerSample,
  fetchFollowsSample,
  fetchModTakedowns,
  fetchRepoStatus,
  fetchVisibleProfiles,
  requestStats,
} from "./sources.ts";
import { AuditStore, type TakedownQueueResult } from "./store.ts";

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
  candidateTtlMs: config.candidateTtlMs,
  maxPendingTakedowns: config.maxPendingTakedowns,
  takedownDedupMs: config.takedownDedupMs,
});
console.log(
  `audit store ready path=${config.dbPath} pendingTakedowns=${store.pendingTakedowns}`,
);

const deps: AuditDeps = {
  store,
  sample: (direction, did, limit) =>
    direction === "follows"
      ? fetchFollowsSample(config.plc, config.pdsHosts, did, limit)
      : fetchFollowerSample(config.constellation, did, limit),
  visibleProfiles: (dids) => fetchVisibleProfiles(config.appview, dids),
  modTakedowns: (dids) => fetchModTakedowns(config.modService, config.modServiceDid, dids),
  repoStatus: (did) => fetchRepoStatus(config.relay, did),
  setLabel: async (did, direction, label) => {
    await labeller.setLabelGroup({
      subject: { uri: did },
      group: TAKEDOWN_LABEL_FAMILIES[direction].map((l) => l.val),
      val: label,
      expiresInMs: config.labelExpiryMs,
    });
  },
};

const makeStats = () => ({
  accountEvents: 0,
  /** Takedowns/suspensions reported by the firehose. */
  takedowns: 0,
  modLabelFrames: 0,
  /** Takedowns/suspensions reported by the mod label stream. */
  labelTakedowns: 0,
  /** Already queued from the other source (or an earlier event) within the dedup window. */
  takedownsDuplicate: 0,
  takedownsDropped: 0,
  fannedOut: 0,
  hits: 0,
  evaluated: 0,
  relabelled: 0,
  skipped: 0,
  labelled: 0,
  cleared: 0,
  errors: 0,
  cacheHits: 0,
  modLabelled: 0,
  relayLookups: 0,
});
let stats = makeStats();
let lastStats: Record<string, unknown> = {};
let stopping = false;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function countQueued(result: TakedownQueueResult) {
  if (result === "duplicate") stats.takedownsDuplicate++;
  if (result === "dropped") stats.takedownsDropped++;
}

// --- Jetstream: only #account events matter. Jetstream always sends those;
// the wanted collection is just a near-silent one so we don't get every record.

const MOD_LABELS_CURSOR_KEY = "mod_labels_cursor";
let latestCursor = store.loadCursor();
let savedCursor = latestCursor;
let modCursor = store.loadCursor(MOD_LABELS_CURSOR_KEY);
let savedModCursor = modCursor;
let lastEventAt = Date.now();

function flushCursors() {
  if (latestCursor !== undefined && latestCursor !== savedCursor) {
    store.saveCursor(latestCursor);
    savedCursor = latestCursor;
  }
  if (modCursor !== undefined && modCursor !== savedModCursor) {
    store.saveCursor(modCursor, MOD_LABELS_CURSOR_KEY);
    savedModCursor = modCursor;
  }
}
const cursorFlush = setInterval(flushCursors, 5_000);
cursorFlush.unref();

function connect() {
  const jetstream = new Jetstream({
    wantedCollections: ["app.bsky.labeler.service"],
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
    if (Date.now() - lastEventAt > 120_000) reconnect("no events for 120s");
  }, 15_000);
  watchdog.unref();

  jetstream.on("account", (event) => {
    if (retired) return;
    lastEventAt = Date.now();
    latestCursor = event.time_us;
    stats.accountEvents++;
    const { did, active, status } = event.account;
    try {
      store.applyAccountEvent(did, active, status);
      if (!active && status && TAKEDOWN_STATUSES.has(status)) {
        stats.takedowns++;
        countQueued(store.addPendingTakedown(did));
      }
    } catch (err) {
      console.error("[account] failed to record status", err);
    }
  });

  jetstream.on("identity", (event) => {
    if (retired) return;
    lastEventAt = Date.now();
    latestCursor = event.time_us;
  });

  jetstream.on("open", () => console.log("[jetstream] connected"));
  jetstream.on("close", () => reconnect("closed"));
  jetstream.on("error", (err) => console.error("[jetstream] error", err));
  jetstream.start();
}

// --- Bluesky's mod label stream: account !takedown / !suspend labels. Most of
// these takedowns also reach the firehose (the store dedups them); the rest are
// appview-only takedowns of accounts on other PDSes.

function startModLabelStream() {
  subscribeLabelStream({
    serviceUrl: config.modService.baseUrl,
    cursor: () => modCursor,
    onLabels: (seq, labels) => {
      modCursor = seq;
      stats.modLabelFrames++;
      const now = Date.now();
      for (const label of labels) {
        if (!isAccountTakedownLabel(label, config.modServiceDid)) continue;
        const did = label.uri;
        if (label.neg) {
          // Reversed (or swapped for the other kind): look it up fresh next time.
          store.forgetStatus(did);
          continue;
        }
        if (isExpired(label, now)) continue;
        store.setStatuses([[did, MOD_TAKEDOWN_LABELS[label.val]!]]);
        stats.labelTakedowns++;
        countQueued(store.addPendingTakedown(did));
      }
    },
    onErrorFrame: (error) => {
      // Our cursor is ahead of the service (its sequence was reset): tail live.
      if (error === "FutureCursor") modCursor = undefined;
    },
  });
}

// --- Fan-out: each takedown gives a hit to its most recent followers.

async function fanOutWorker() {
  while (!stopping) {
    const did = store.takePendingTakedown();
    if (!did) {
      await sleep(5_000);
      continue;
    }
    try {
      const { dids } = await fetchFollowerSample(config.constellation, did, config.takedownFanout);
      store.addHits(dids);
      stats.fannedOut++;
      stats.hits += dids.length;
    } catch (err) {
      stats.errors++;
      console.error(`[fanout] failed did=${did}`, err);
    }
  }
}

// --- Audit: labelled accounts due a refresh first, then the top candidates.
// A candidate gets both checks: its follows (the main signal) and its
// followers. A taken-down account's own follow list can't be read any more,
// so there's no direct way to find who the bots were following; accounts
// near takedowns are where bot networks cluster, so they're the pool for both.

const DIRECTIONS: readonly AuditDirection[] = ["follows", "followers"];

interface Job {
  did: string;
  why: string;
  directions: readonly AuditDirection[];
}

function nextJob(): Job | undefined {
  for (const direction of DIRECTIONS) {
    const did = store.dueForRelabel(direction, config.relabelMs);
    if (did) return { did, why: "relabel", directions: [direction] };
  }
  while (true) {
    const candidate = store.takeCandidate(config.minHits, config.cooldownMs);
    if (!candidate) return undefined;
    // Followers that were themselves taken down / deleted can't be audited.
    const status = store.getStatuses([candidate.did]).get(candidate.did);
    if (status && status !== "active") continue;
    return { did: candidate.did, why: `hits=${candidate.hits}`, directions: DIRECTIONS };
  }
}

async function auditWorker(id: number) {
  while (!stopping) {
    const job = nextJob();
    if (!job) {
      await sleep(5_000);
      continue;
    }
    const { did, why } = job;
    for (const direction of job.directions) {
      try {
        const r = await evaluateAccount(did, direction, deps, config);
        stats.evaluated++;
        if (why === "relabel") stats.relabelled++;
        stats.cacheHits += r.cacheHits;
        stats.modLabelled += r.modLabelled;
        stats.relayLookups += r.relayLookups;
        if (r.skipped) stats.skipped++;
        if (r.labelCall === "set") stats.labelled++;
        if (r.labelCall === "clear") stats.cleared++;
        if (!r.skipped) {
          console.log(
            `[audit w${id}] did=${did} ${direction} ${why} sampled=${r.sampled} counted=${r.counted} ` +
              `takendown=${r.takendown} pct=${r.percent?.toFixed(2)} ` +
              `bucket=${r.previousBucket ?? "-"}->${r.bucket} label=${r.label ?? "-"} ` +
              `cacheHits=${r.cacheHits} mod=${r.modLabelled} relay=${r.relayLookups}`,
          );
        }
      } catch (err) {
        stats.errors++;
        // Don't spin on an account we can't read (PDS down, repo gone, ...).
        if (why === "relabel") store.touchEvaluation(did, direction);
        console.error(`[audit w${id}] failed did=${did} ${direction} ${why}`, err);
      }
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
  lastStats = { ...s, pendingTakedowns: store.pendingTakedowns, windowSec: STATS_MS / 1000 };
  const reqs = Object.entries(requestStats.requests)
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");
  requestStats.requests = {};
  const mem = process.memoryUsage();
  console.log(
    `[stats 60s] accountEvents=${s.accountEvents} takedowns=${s.takedowns} ` +
      `modLabelFrames=${s.modLabelFrames} labelTakedowns=${s.labelTakedowns} ` +
      `duplicate=${s.takedownsDuplicate} dropped=${s.takedownsDropped} ` +
      `pendingTakedowns=${store.pendingTakedowns} ` +
      `fannedOut=${s.fannedOut} hits=${s.hits} evaluated=${s.evaluated} relabelled=${s.relabelled} ` +
      `skipped=${s.skipped} labelled=${s.labelled} cleared=${s.cleared} errors=${s.errors} ` +
      `cacheHits=${s.cacheHits} modLabelled=${s.modLabelled} relayLookups=${s.relayLookups} ` +
      `reqs[${reqs}] ` +
      `retries=${requestStats.retries} rss=${(mem.rss / 1048576).toFixed(1)}MB ` +
      `uptimeSec=${Math.round(process.uptime())}`,
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
  dataServer.close();
  flushCursors();
  store.close();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

const port = Number(process.env.PORT ?? 14833);
const dataServer = createDataServer(store, internalApiKey, () => lastStats);
dataServer.listen(port, "::", () => console.log(`data server listening on :${port}`));

connect();
startModLabelStream();
void fanOutWorker();
for (let i = 0; i < config.concurrency; i++) void auditWorker(i);
