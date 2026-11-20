import { TAKEDOWN_LABEL_FAMILIES, type AuditDirection } from "labeller-client";
import { chooseBucket, labelForBucket } from "./bucket.ts";
import type { GraphSample } from "./sources.ts";
import type { AccountStatus, AuditStore } from "./store.ts";

/** Statuses counted as "taken down". Add "suspended" here to include temporary suspensions. */
export const TAKEDOWN_STATUSES: ReadonlySet<string> = new Set(["takendown"]);

/**
 * Statuses left out of the denominator: these aren't really in the graph any
 * more (or we couldn't tell). Deactivated accounts stay in — they're real
 * accounts that stepped away.
 */
const UNCOUNTED_STATUSES: ReadonlySet<string> = new Set(["deleted", "not-found", "unknown"]);

export interface AuditDeps {
  store: Pick<AuditStore, "getStatuses" | "setStatuses" | "getEvaluation" | "saveEvaluation">;
  /** Most recent follows (or followers) of `did`, up to `limit`. */
  sample(direction: AuditDirection, did: string, limit: number): Promise<GraphSample>;
  visibleProfiles(dids: string[]): Promise<Set<string>>;
  repoStatus(did: string): Promise<AccountStatus>;
  /** Make `label` the only active label of this direction's family (null clears it). */
  setLabel(did: string, direction: AuditDirection, label: string | null): Promise<void>;
}

export interface AuditOptions {
  sampleSize: number;
  /** Need at least this many countable accounts in the sample (percentages are noise below). */
  minCounted: number;
}

export interface AuditResult {
  did: string;
  direction: AuditDirection;
  total: number;
  sampled: number;
  counted: number;
  takendown: number;
  percent: number | null;
  previousBucket: number | null;
  bucket: number;
  label: string | null;
  labelCall: "set" | "clear" | "none";
  cacheHits: number;
  relayLookups: number;
  skipped?: "small-sample";
}

export async function evaluateAccount(
  did: string,
  direction: AuditDirection,
  deps: AuditDeps,
  opts: AuditOptions,
): Promise<AuditResult> {
  const previous = deps.store.getEvaluation(did, direction);
  const previousBucket = previous ? previous.bucket : null;

  const sample = await deps.sample(direction, did, opts.sampleSize);
  const base = { did, direction, total: sample.total, sampled: sample.dids.length, previousBucket };

  if (sample.dids.length < opts.minCounted) {
    return finish(deps, base, { counted: 0, takendown: 0, percent: null, cacheHits: 0, relayLookups: 0 }, "small-sample");
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

  const counts = { counted, takendown, cacheHits, relayLookups };
  if (counted < opts.minCounted) {
    return finish(deps, base, { ...counts, percent: null }, "small-sample");
  }
  return finish(deps, base, { ...counts, percent: (takendown / counted) * 100 });
}

async function finish(
  deps: AuditDeps,
  base: Pick<AuditResult, "did" | "direction" | "total" | "sampled" | "previousBucket">,
  counts: Pick<AuditResult, "counted" | "takendown" | "percent" | "cacheHits" | "relayLookups">,
  skipped?: AuditResult["skipped"],
): Promise<AuditResult> {
  const family = TAKEDOWN_LABEL_FAMILIES[base.direction];
  const bucket =
    counts.percent === null
      ? 0
      : chooseBucket(family, counts.percent, base.previousBucket, counts.counted);
  const label = labelForBucket(family, bucket);

  // Re-send an active label every time (the labeller only re-issues it when the
  // expiry needs pushing out); only send a clear if we previously labelled.
  let labelCall: AuditResult["labelCall"] = "none";
  if (label) labelCall = "set";
  else if (base.previousBucket) labelCall = "clear";
  if (labelCall !== "none") await deps.setLabel(base.did, base.direction, label);

  deps.store.saveEvaluation({
    did: base.did,
    direction: base.direction,
    total: base.total,
    counted: counts.counted,
    takendown: counts.takendown,
    bucket,
  });
  return { ...base, ...counts, bucket, label, labelCall, ...(skipped ? { skipped } : {}) };
}
