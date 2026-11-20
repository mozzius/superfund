/**
 * Account labels for "share of an account's follow graph that has been taken
 * down". Label values may only contain [a-z-], hence the spelled-out numbers.
 * Each family is ordered by threshold, and an account carries at most one
 * label per family at a time.
 */

/** Which side of the follow graph a family measures. */
export type AuditDirection = "follows" | "followers";

export interface TakedownLabel {
  minPercent: number;
  val: string;
}

/**
 * Accounts this account follows. Ordinary accounts we sampled sat at 0–0.6%,
 * so 1% is already above the background and 5%+ is well clear of it.
 */
export const FOLLOWS_TAKEDOWN_LABELS = [
  { minPercent: 1, val: "follows-takendown-one" },
  { minPercent: 5, val: "follows-takendown-five" },
  { minPercent: 10, val: "follows-takendown-ten" },
  { minPercent: 20, val: "follows-takendown-twenty" },
  { minPercent: 30, val: "follows-takendown-thirty" },
  { minPercent: 40, val: "follows-takendown-forty" },
  { minPercent: 50, val: "follows-takendown-fifty" },
] as const satisfies readonly TakedownLabel[];

/**
 * Accounts following this account. Big accounts pick up 8–12% from spam bots
 * following them unprompted, so this family starts at 20%.
 */
export const FOLLOWER_TAKEDOWN_LABELS = [
  { minPercent: 20, val: "followers-takendown-twenty" },
  { minPercent: 30, val: "followers-takendown-thirty" },
  { minPercent: 40, val: "followers-takendown-forty" },
  { minPercent: 50, val: "followers-takendown-fifty" },
] as const satisfies readonly TakedownLabel[];

export const TAKEDOWN_LABEL_FAMILIES: Record<AuditDirection, readonly TakedownLabel[]> = {
  follows: FOLLOWS_TAKEDOWN_LABELS,
  followers: FOLLOWER_TAKEDOWN_LABELS,
};

export type TakedownLabelValue =
  | (typeof FOLLOWS_TAKEDOWN_LABELS)[number]["val"]
  | (typeof FOLLOWER_TAKEDOWN_LABELS)[number]["val"];
