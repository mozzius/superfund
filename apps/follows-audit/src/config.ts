import { HostLimiters, RateLimiter, type Upstream } from "./sources.ts";

const DAY_MS = 86_400_000;
const num = (name: string, fallback: number) => {
  const raw = process.env[name];
  const value = raw === undefined || raw === "" ? fallback : Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number`);
  return value;
};

export function loadConfig() {
  const volumePath = process.env.RAILWAY_VOLUME_MOUNT_PATH;
  return {
    dbPath:
      process.env.AUDIT_DB_PATH ?? (volumePath ? `${volumePath}/audit.db` : "./audit.db"),

    /** How many of an account's most recent follows to check. */
    sampleSize: num("FOLLOWS_SAMPLE_SIZE", 1000),
    /** Need at least this many countable accounts in the sample. */
    minCounted: num("MIN_COUNTED", 50),

    /** How many of a taken-down account's most recent followers get a hit. */
    takedownFanout: num("TAKEDOWN_FANOUT", 1000),
    /** Evaluate a candidate once it follows this many freshly taken-down accounts. */
    minHits: num("MIN_HITS", 3),
    /** Don't re-evaluate the same account more often than this. */
    cooldownMs: num("COOLDOWN_HOURS", 24) * 3_600_000,
    /** Re-check labelled accounts this often so their labels don't lapse. */
    relabelMs: num("RELABEL_DAYS", 14) * DAY_MS,
    labelExpiryMs: num("LABEL_EXPIRY_DAYS", 30) * DAY_MS,
    candidateTtlMs: num("CANDIDATE_TTL_DAYS", 14) * DAY_MS,
    maxPendingTakedowns: num("MAX_PENDING_TAKEDOWNS", 50_000),

    activeTtlMs: num("ACTIVE_STATUS_TTL_DAYS", 7) * DAY_MS,
    inactiveTtlMs: num("INACTIVE_STATUS_TTL_DAYS", 30) * DAY_MS,
    concurrency: num("WORKER_CONCURRENCY", 2),

    constellation: upstream("CONSTELLATION_URL", "https://constellation.microcosm.blue", "CONSTELLATION_RPS", 2),
    appview: upstream("APPVIEW_URL", "https://public.api.bsky.app", "APPVIEW_RPS", 5),
    relay: upstream("RELAY_URL", "https://relay1.us-east.bsky.network", "RELAY_RPS", 10),
    plc: upstream("PLC_URL", "https://plc.directory", "PLC_RPS", 5),
    /** Limits each PDS host separately. */
    pdsHosts: new HostLimiters(num("PDS_RPS", 5)),
  };

  function upstream(urlVar: string, url: string, rpsVar: string, rps: number): Upstream {
    return { baseUrl: process.env[urlVar] ?? url, limiter: new RateLimiter(num(rpsVar, rps)) };
  }
}

export type Config = ReturnType<typeof loadConfig>;
