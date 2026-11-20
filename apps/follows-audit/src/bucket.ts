import type { TakedownLabel } from "labeller-client";

/** Highest label threshold `percent` reaches, or 0 for "no label". */
export function rawBucket(family: readonly TakedownLabel[], percent: number): number {
  let bucket = 0;
  for (const { minPercent } of family) {
    if (percent >= minPercent) bucket = minPercent;
  }
  return bucket;
}

/**
 * Hysteresis margin around a threshold, in percentage points: `z` standard
 * errors of a sampled proportion at that threshold. Scales with the bucket
 * (0.47pp at 1%, 2.4pp at 50% for a 1,000-account sample) and widens for
 * small samples, where one account swings the percentage a lot.
 */
export function margin(thresholdPercent: number, sampleSize: number, z = 1.5): number {
  const p = thresholdPercent / 100;
  return z * Math.sqrt((p * (1 - p)) / Math.max(sampleSize, 1)) * 100;
}

/**
 * Bucket with hysteresis. Moving up to a threshold (including getting a first
 * label) needs `percent` to clear it by its margin; moving down needs
 * `percent` to fall below the current threshold by its margin. So a
 * 0.9% / 1.1% / 1.0% run of samples doesn't flip the label every time.
 */
export function chooseBucket(
  family: readonly TakedownLabel[],
  percent: number,
  previous: number | null,
  sampleSize: number,
): number {
  const current = previous ?? 0;
  const raw = rawBucket(family, percent);

  if (raw > current) {
    let best = current;
    for (const { minPercent } of family) {
      if (minPercent > current && percent >= minPercent + margin(minPercent, sampleSize)) {
        best = minPercent;
      }
    }
    return best;
  }
  if (raw < current && percent < current - margin(current, sampleSize)) {
    return raw;
  }
  return current;
}

export function labelForBucket(family: readonly TakedownLabel[], bucket: number): string | null {
  return family.find((l) => l.minPercent === bucket)?.val ?? null;
}
