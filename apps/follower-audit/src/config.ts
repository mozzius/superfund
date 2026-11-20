import { RateLimiter, type Upstream } from "./sources.ts";

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
    sampleSize: num("FOLLOWER_SAMPLE_SIZE", 1000),
    minFollowers: num("MIN_FOLLOWERS", 50),
    minCounted: num("MIN_COUNTED", 50),
    reevaluateMs: num("REEVALUATE_DAYS", 14) * DAY_MS,
    labelExpiryMs: num("LABEL_EXPIRY_DAYS", 30) * DAY_MS,
    activeTtlMs: num("ACTIVE_STATUS_TTL_DAYS", 7) * DAY_MS,
    inactiveTtlMs: num("INACTIVE_STATUS_TTL_DAYS", 30) * DAY_MS,
    maxQueue: num("MAX_QUEUE", 5000),
    concurrency: num("WORKER_CONCURRENCY", 2),
    constellation: upstream("CONSTELLATION_URL", "https://constellation.microcosm.blue", "CONSTELLATION_RPS", 2),
    appview: upstream("APPVIEW_URL", "https://public.api.bsky.app", "APPVIEW_RPS", 5),
    relay: upstream("RELAY_URL", "https://relay1.us-east.bsky.network", "RELAY_RPS", 10),
  };

  function upstream(urlVar: string, url: string, rpsVar: string, rps: number): Upstream {
    return { baseUrl: process.env[urlVar] ?? url, limiter: new RateLimiter(num(rpsVar, rps)) };
  }
}

export type Config = ReturnType<typeof loadConfig>;
