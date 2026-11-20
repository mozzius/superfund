import { test } from "node:test";
import assert from "node:assert/strict";
import { chooseBucket, labelForBucket, rawBucket } from "./bucket.ts";

test("rawBucket floors to the label thresholds", () => {
  assert.equal(rawBucket(0), 0);
  assert.equal(rawBucket(9.99), 0);
  assert.equal(rawBucket(10), 10);
  assert.equal(rawBucket(29.9), 20);
  assert.equal(rawBucket(50), 50);
  assert.equal(rawBucket(97), 50);
});

test("first evaluation uses the raw bucket", () => {
  assert.equal(chooseBucket(20.5, null), 20);
  assert.equal(chooseBucket(5, null), 0);
});

test("needs to clear the boundary by the margin to move up", () => {
  assert.equal(chooseBucket(21.9, 10), 10);
  assert.equal(chooseBucket(22, 10), 20);
  assert.equal(chooseBucket(11, 0), 0);
  assert.equal(chooseBucket(12, 0), 10);
});

test("needs to clear the boundary by the margin to move down", () => {
  assert.equal(chooseBucket(18.1, 20), 20);
  assert.equal(chooseBucket(17.9, 20), 10);
  assert.equal(chooseBucket(8.5, 10), 10);
  assert.equal(chooseBucket(7, 10), 0);
});

test("big jumps skip straight to the right bucket", () => {
  assert.equal(chooseBucket(45, 10), 40);
  assert.equal(chooseBucket(3, 50), 0);
});

test("labelForBucket maps thresholds to label values", () => {
  assert.equal(labelForBucket(0), null);
  assert.equal(labelForBucket(10), "followers-takendown-ten");
  assert.equal(labelForBucket(50), "followers-takendown-fifty");
});
