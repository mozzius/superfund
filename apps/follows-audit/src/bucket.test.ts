import { test } from "node:test";
import assert from "node:assert/strict";
import { FOLLOWER_TAKEDOWN_LABELS, FOLLOWS_TAKEDOWN_LABELS } from "labeller-client";
import { chooseBucket, labelForBucket, margin, rawBucket } from "./bucket.ts";

const follows = FOLLOWS_TAKEDOWN_LABELS;
const followers = FOLLOWER_TAKEDOWN_LABELS;
const N = 1000;

test("rawBucket floors to the family's thresholds", () => {
  assert.equal(rawBucket(follows, 0.6), 0);
  assert.equal(rawBucket(follows, 1), 1);
  assert.equal(rawBucket(follows, 4.99), 1);
  assert.equal(rawBucket(follows, 5), 5);
  assert.equal(rawBucket(follows, 10), 10);
  assert.equal(rawBucket(follows, 29.9), 20);
  assert.equal(rawBucket(follows, 97), 50);
  assert.equal(rawBucket(followers, 15), 0, "followers start at 20%");
  assert.equal(rawBucket(followers, 20), 20);
});

test("margin scales with the threshold and shrinks with sample size", () => {
  assert.ok(Math.abs(margin(1, N) - 0.47) < 0.01);
  assert.ok(Math.abs(margin(5, N) - 1.03) < 0.01);
  assert.ok(Math.abs(margin(50, N) - 2.37) < 0.01);
  assert.ok(margin(1, 60) > margin(1, N));
});

test("a first label has to clear the margin too", () => {
  assert.equal(chooseBucket(follows, 1.2, null, N), 0);
  assert.equal(chooseBucket(follows, 1.5, null, N), 1);
  assert.equal(chooseBucket(follows, 5.5, null, N), 1, "not past 5% + margin yet");
  assert.equal(chooseBucket(follows, 6.1, null, N), 5);
  assert.equal(chooseBucket(follows, 0.3, null, N), 0);
});

test("needs to clear the next threshold by its margin to move up", () => {
  assert.equal(chooseBucket(follows, 5.9, 1, N), 1);
  assert.equal(chooseBucket(follows, 6.1, 1, N), 5);
  assert.equal(chooseBucket(follows, 21.5, 10, N), 10);
  assert.equal(chooseBucket(follows, 22, 10, N), 20);
  assert.equal(chooseBucket(followers, 21.5, 0, N), 0);
  assert.equal(chooseBucket(followers, 22, 0, N), 20);
});

test("needs to fall below the current threshold by its margin to move down", () => {
  assert.equal(chooseBucket(follows, 0.6, 1, N), 1);
  assert.equal(chooseBucket(follows, 0.5, 1, N), 0);
  assert.equal(chooseBucket(follows, 4.1, 5, N), 5);
  assert.equal(chooseBucket(follows, 3.9, 5, N), 1);
  assert.equal(chooseBucket(follows, 18.5, 20, N), 20);
  assert.equal(chooseBucket(follows, 17.9, 20, N), 10);
  assert.equal(chooseBucket(followers, 17.9, 20, N), 0, "no lower bucket for followers");
});

test("big jumps skip straight to the right bucket", () => {
  assert.equal(chooseBucket(follows, 45, 1, N), 40);
  assert.equal(chooseBucket(follows, 0.1, 50, N), 0);
});

test("small samples need a bigger lead", () => {
  // 1 of 60 followed accounts taken down is 1.7% — not enough on its own.
  assert.equal(chooseBucket(follows, 100 / 60, null, 60), 0);
  assert.equal(chooseBucket(follows, 200 / 60, null, 60), 1);
});

test("labelForBucket maps thresholds to label values", () => {
  assert.equal(labelForBucket(follows, 0), null);
  assert.equal(labelForBucket(follows, 1), "follows-takendown-one");
  assert.equal(labelForBucket(follows, 5), "follows-takendown-five");
  assert.equal(labelForBucket(followers, 10), null);
  assert.equal(labelForBucket(followers, 50), "followers-takendown-fifty");
});
