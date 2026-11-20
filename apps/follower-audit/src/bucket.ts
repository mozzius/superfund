import { FOLLOWER_TAKEDOWN_LABELS, type FollowerTakedownLabel } from "labeller-client";

/** Highest label threshold `percent` reaches, or 0 for "no label". */
export function rawBucket(percent: number): number {
  let bucket = 0;
  for (const { minPercent } of FOLLOWER_TAKEDOWN_LABELS) {
    if (percent >= minPercent) bucket = minPercent;
  }
  return bucket;
}

/**
 * Bucket with hysteresis: an account only moves off its previous bucket once
 * it is `margin` points past the boundary, so a 19.8% / 20.3% / 19.9% run of
 * samples doesn't flip the label every evaluation.
 */
export function chooseBucket(percent: number, previous: number | null, margin = 2): number {
  if (previous === null) return rawBucket(percent);
  const up = rawBucket(percent - margin);
  if (up > previous) return up;
  const down = rawBucket(percent + margin);
  if (down < previous) return down;
  return previous;
}

export function labelForBucket(bucket: number): FollowerTakedownLabel | null {
  return FOLLOWER_TAKEDOWN_LABELS.find((l) => l.minPercent === bucket)?.val ?? null;
}
