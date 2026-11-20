import { test } from "node:test";
import assert from "node:assert/strict";
import { AuditStore, type AuditStoreOptions } from "./store.ts";

const DAY = 86_400_000;

function makeStore(overrides: Partial<AuditStoreOptions> = {}) {
  let now = 1_000 * DAY;
  const store = new AuditStore({
    dbPath: ":memory:",
    activeTtlMs: 7 * DAY,
    inactiveTtlMs: 30 * DAY,
    evaluationTtlMs: 30 * DAY,
    maxQueue: 3,
    now: () => now,
    ...overrides,
  });
  return { store, advance: (ms: number) => (now += ms) };
}

test("status cache expires active entries sooner than inactive ones", () => {
  const { store, advance } = makeStore();
  store.setStatuses([
    ["did:a", "active"],
    ["did:t", "takendown"],
  ]);
  assert.deepEqual([...store.getStatuses(["did:a", "did:t", "did:x"])].sort(), [
    ["did:a", "active"],
    ["did:t", "takendown"],
  ]);
  advance(8 * DAY);
  assert.deepEqual([...store.getStatuses(["did:a", "did:t"])], [["did:t", "takendown"]]);
  advance(30 * DAY);
  assert.equal(store.getStatuses(["did:t"]).size, 0);
});

test("account events record takedowns but only update known DIDs on reactivation", () => {
  const { store } = makeStore();
  store.applyAccountEvent("did:new", true, undefined);
  assert.equal(store.getStatuses(["did:new"]).size, 0);

  store.applyAccountEvent("did:bad", false, "takendown");
  assert.equal(store.getStatuses(["did:bad"]).get("did:bad"), "takendown");

  store.applyAccountEvent("did:bad", true, undefined);
  assert.equal(store.getStatuses(["did:bad"]).get("did:bad"), "active");
});

test("queue dedups, respects capacity and the re-evaluation window", () => {
  const { store, advance } = makeStore();
  assert.equal(store.enqueueIfDue("did:1", 14 * DAY), true);
  assert.equal(store.enqueueIfDue("did:1", 14 * DAY), false);
  advance(1);
  store.enqueueIfDue("did:2", 14 * DAY);
  advance(1);
  store.enqueueIfDue("did:3", 14 * DAY);
  assert.equal(store.enqueueIfDue("did:4", 14 * DAY), false, "full");
  assert.equal(store.queueSize, 3);

  assert.equal(store.dequeue(), "did:1");
  store.saveEvaluation({ did: "did:1", followers: 100, counted: 90, takendown: 9, bucket: 10 });
  assert.equal(store.enqueueIfDue("did:1", 14 * DAY), false, "recently evaluated");
  advance(15 * DAY);
  assert.equal(store.enqueueIfDue("did:1", 14 * DAY), true);
  assert.equal(store.dequeue(), "did:2");
});

test("evaluations are forgotten after their TTL", () => {
  const { store, advance } = makeStore();
  store.saveEvaluation({ did: "did:1", followers: 100, counted: 90, takendown: 30, bucket: 30 });
  assert.equal(store.getEvaluation("did:1")?.bucket, 30);
  advance(31 * DAY);
  assert.equal(store.getEvaluation("did:1"), undefined);
  assert.ok(store.prune() >= 1);
});

test("cursor round-trips", () => {
  const { store } = makeStore();
  assert.equal(store.loadCursor(), undefined);
  store.saveCursor(12345);
  assert.equal(store.loadCursor(), 12345);
});
