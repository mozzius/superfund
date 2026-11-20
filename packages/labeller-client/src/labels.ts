/**
 * Account labels for "share of recent followers that have been taken down".
 * Label values may only contain [a-z-], hence the spelled-out numbers.
 * Ordered by threshold; an account carries at most one of these at a time.
 */
export const FOLLOWER_TAKEDOWN_LABELS = [
  { minPercent: 10, val: "followers-takendown-ten" },
  { minPercent: 20, val: "followers-takendown-twenty" },
  { minPercent: 30, val: "followers-takendown-thirty" },
  { minPercent: 40, val: "followers-takendown-forty" },
  { minPercent: 50, val: "followers-takendown-fifty" },
] as const;

export type FollowerTakedownLabel = (typeof FOLLOWER_TAKEDOWN_LABELS)[number]["val"];

export const FOLLOWER_TAKEDOWN_LABEL_VALUES: FollowerTakedownLabel[] =
  FOLLOWER_TAKEDOWN_LABELS.map((l) => l.val);
