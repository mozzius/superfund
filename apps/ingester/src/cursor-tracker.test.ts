import assert from "node:assert/strict";
import { test } from "node:test";
import { CursorTracker } from "./cursor-tracker.ts";

function setup() {
  const cursors: number[] = [];
  return {
    cursors,
    tracker: new CursorTracker({ updateCursor: (cursor) => cursors.push(cursor) }),
  };
}

test("does not advance past an older event that is still running", () => {
  const { tracker, cursors } = setup();
  const completeFirst = tracker.begin(100);
  const completeSecond = tracker.begin(200);

  completeSecond();
  assert.deepEqual(cursors, []);
  completeFirst();
  assert.deepEqual(cursors, [200]);
});

test("advances to the completed prefix while a newer event is running", () => {
  const { tracker, cursors } = setup();
  const completeFirst = tracker.begin(100);
  tracker.begin(200);

  completeFirst();
  assert.deepEqual(cursors, [100]);
});

test("coalesces skipped events behind in-flight work without losing them", () => {
  const { tracker, cursors } = setup();
  const complete = tracker.begin(100);
  tracker.skip(200);
  tracker.skip(300);

  assert.deepEqual(cursors, []);
  complete();
  assert.deepEqual(cursors, [300]);
});

test("advances skipped events immediately when no work is in flight", () => {
  const { tracker, cursors } = setup();
  tracker.skip(100);
  tracker.skip(200);
  assert.deepEqual(cursors, [100, 200]);
});

test("completion callbacks are idempotent", () => {
  const { tracker, cursors } = setup();
  const complete = tracker.begin(100);
  complete();
  complete();
  assert.deepEqual(cursors, [100]);
});
