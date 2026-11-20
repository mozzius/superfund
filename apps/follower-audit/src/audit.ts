import type { FollowerTakedownLabel } from "labeller-client";
import { chooseBucket, labelForBucket } from "./bucket.ts";
import type { FollowerSample } from "./sources.ts";
import type { AccountStatus, AuditStore } from "./store.ts";

/** Statuses counted as "taken down". Add "suspended" here to include temporary suspensions. */
export const TAKEDOWN_STATUSES: ReadonlySet<string> = new Set(["takendown"]);

/**
 * Statuses left out of the denominator: these aren't really followers any
 * more (or we couldn't tell). Deactivated accounts stay in — they're real
 * followers who stepped away.
 */
const UNCOUNTED_STATUSES: ReadonlySet<string> = new Set(["deleted", "not-found", "unknown"]);

export interface AuditDeps {
  store: Pick<AuditStore, "getStatuses" | "setStatuses" | "getEvaluation" | "saveEvaluation">;
  followerSample(did: string, limit: number): Promise<FollowerSample>;
  visibleProfiles(dids: string[]): Promise<Set<string>>;
  repoStatus(did: string): Promise<AccountStatus>;
  setLabel(did: string, label: FollowerTakedownLabel | null): Promise<void>;
}

export interface AuditOptions {
  sampleSize: number;
  /** Skip accounts with fewer followers than this (percentages are noise). */
  minFollowers: number;
  /** Need at least this many countable followers in the sample. */
  minCounted: number;
}

export interface AuditResult {
  did: string;
  followers: number;
  sampled: number;
  counted: number;
  takendown: number;
  percent: number | null;
  previousBucket: number | null;
  bucket: number;
  label: FollowerTakedownLabel | null;
  labelCall: "set" | "clear" | "none";
  cacheHits: number;
  relayLookups: number;
  skipped?: "few-followers" | "small-sample";
}

export async function evaluateAccount(
  did: string,
  deps: AuditDeps,
  opts: AuditOptions,
): Promise<AuditResult> {
  const previous = deps.store.getEvaluation(did);
  const previousBucket = previous ? previous.bucket : null;

  const sample = await deps.followerSample(did, opts.sampleSize);
  const base = {
    did,
    followers: sample.total,
    sampled: sample.dids.length,
    previousBucket,
  };

  if (sample.total < opts.minFollowers || sample.dids.length < opts.minCounted) {
    return finish(deps, base, { counted: 0, takendown: 0, percent: null, cacheHits: 0, relayLookups: 0 }, "few-followers");
  }

  const statuses = deps.store.getStatuses(sample.dids);
  const cacheHits = statuses.size;
  const unknown = sample.dids.filter((d) => !statuses.has(d));

  let relayLookups = 0;
  for (let i = 0; i < unknown.length; i += 25) {
    const chunk = unknown.slice(i, i + 25);
    const visible = await deps.visibleProfiles(chunk);
    const resolved: [string, AccountStatus][] = [];
    const hidden = chunk.filter((d) => {
      if (!visible.has(d)) return true;
      resolved.push([d, "active"]);
      return false;
    });
    relayLookups += hidden.length;
    const hiddenStatuses = await Promise.all(
      hidden.map(async (d): Promise<[string, AccountStatus]> => {
        try {
          return [d, await deps.repoStatus(d)];
        } catch (err) {
          console.warn(`[audit] relay status failed did=${d}`, err);
          return [d, "unknown"];
        }
      }),
    );
    resolved.push(...hiddenStatuses);
    for (const [d, s] of resolved) statuses.set(d, s);
    deps.store.setStatuses(resolved.filter(([, s]) => s !== "unknown"));
  }

  let counted = 0;
  let takendown = 0;
  for (const d of sample.dids) {
    const status = statuses.get(d) ?? "unknown";
    if (UNCOUNTED_STATUSES.has(status)) continue;
    counted++;
    if (TAKEDOWN_STATUSES.has(status)) takendown++;
  }

  if (counted < opts.minCounted) {
    return finish(deps, base, { counted, takendown, percent: null, cacheHits, relayLookups }, "small-sample");
  }
  return finish(deps, base, {
    counted,
    takendown,
    percent: (takendown / counted) * 100,
    cacheHits,
    relayLookups,
  });
}

async function finish(
  deps: AuditDeps,
  base: Pick<AuditResult, "did" | "followers" | "sampled" | "previousBucket">,
  counts: Pick<AuditResult, "counted" | "takendown" | "percent" | "cacheHits" | "relayLookups">,
  skipped?: AuditResult["skipped"],
): Promise<AuditResult> {
  const bucket =
    counts.percent === null ? 0 : chooseBucket(counts.percent, base.previousBucket);
  const label = labelForBucket(bucket);

  // Re-send an active label every time (the labeller only re-issues it when the
  // expiry needs pushing out); only send a clear if we previously labelled.
  let labelCall: AuditResult["labelCall"] = "none";
  if (label) labelCall = "set";
  else if (base.previousBucket) labelCall = "clear";
  if (labelCall !== "none") await deps.setLabel(base.did, label);

  deps.store.saveEvaluation({
    did: base.did,
    followers: base.followers,
    counted: counts.counted,
    takendown: counts.takendown,
    bucket,
  });
  return { ...base, ...counts, bucket, label, labelCall, ...(skipped ? { skipped } : {}) };
}
