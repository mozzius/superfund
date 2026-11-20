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
    candidateTtlMs: 7 * DAY,
    maxPendingTakedowns: 2,
    now: () => now,
    ...overrides,
  });
  return { store, advance: (ms: number) => (now += ms) };
}

const evaluation = (did: string, bucket = 0) => ({
  did,
  direction: "follows" as const,
  total: 100,
  counted: 90,
  takendown: 9,
  bucket,
});

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

test("pending takedowns dedup, cap, and come out oldest first", () => {
  const { store, advance } = makeStore();
  assert.equal(store.addPendingTakedown("did:t1"), true);
  assert.equal(store.addPendingTakedown("did:t1"), false);
  advance(1);
  store.addPendingTakedown("did:t2");
  assert.equal(store.addPendingTakedown("did:t3"), false, "full");
  assert.equal(store.pendingTakedowns, 2);
  assert.equal(store.takePendingTakedown(), "did:t1");
  assert.equal(store.takePendingTakedown(), "did:t2");
  assert.equal(store.takePendingTakedown(), undefined);
  assert.equal(store.pendingTakedowns, 0);
});

test("candidates come out highest-hits first, once they reach the threshold", () => {
  const { store } = makeStore();
  store.addHits(["did:a", "did:b"]);
  store.addHits(["did:b", "did:c"]);
  store.addHits(["did:b", "did:c"]);
  assert.deepEqual(store.takeCandidate(2, DAY), { did: "did:b", hits: 3 });
  assert.deepEqual(store.takeCandidate(2, DAY), { did: "did:c", hits: 2 });
  assert.equal(store.takeCandidate(2, DAY), undefined, "did:a only has 1 hit");
});

test("taking a candidate resets its score", () => {
  const { store } = makeStore();
  store.addHits(["did:a"]);
  store.addHits(["did:a"]);
  assert.equal(store.takeCandidate(2, DAY)?.did, "did:a");
  store.addHits(["did:a"]);
  assert.equal(store.takeCandidate(2, DAY), undefined);
});

test("recently evaluated candidates wait out the cooldown", () => {
  const { store, advance } = makeStore();
  store.saveEvaluation(evaluation("did:a"));
  store.addHits(["did:a", "did:b"]);
  store.addHits(["did:a", "did:b"]);
  store.addHits(["did:a"]);
  assert.equal(store.takeCandidate(2, DAY)?.did, "did:b", "did:a is cooling down");
  assert.equal(store.takeCandidate(2, DAY), undefined);
  advance(DAY + 1);
  assert.equal(store.takeCandidate(2, DAY)?.did, "did:a");
});

test("evaluations are tracked per direction and forgotten after their TTL", () => {
  const { store, advance } = makeStore();
  store.saveEvaluation(evaluation("did:1", 30));
  assert.equal(store.getEvaluation("did:1", "follows")?.bucket, 30);
  assert.equal(store.getEvaluation("did:1", "followers"), undefined);
  advance(31 * DAY);
  assert.equal(store.getEvaluation("did:1", "follows"), undefined);
  assert.ok(store.prune() >= 1);
});

test("prune drops candidates that went cold", () => {
  const { store, advance } = makeStore();
  store.addHits(["did:a"]);
  advance(8 * DAY);
  store.addHits(["did:b"]);
  assert.equal(store.prune(), 1);
  store.addHits(["did:b"]);
  assert.equal(store.takeCandidate(2, DAY)?.did, "did:b");
});

test("labelled accounts come back for a refresh before the label lapses", () => {
  const { store, advance } = makeStore();
  store.saveEvaluation(evaluation("did:unlabelled", 0));
  store.saveEvaluation(evaluation("did:labelled", 5));
  assert.equal(store.dueForRelabel("follows", 14 * DAY), undefined);
  advance(15 * DAY);
  assert.equal(store.dueForRelabel("follows", 14 * DAY), "did:labelled");
  store.touchEvaluation("did:labelled", "follows");
  assert.equal(store.dueForRelabel("follows", 14 * DAY), undefined);
  assert.equal(store.getEvaluation("did:labelled", "follows")?.bucket, 5);
});

test("dashboard queries rank by share taken down", () => {
  const { store } = makeStore();
  store.saveEvaluation({ ...evaluation("did:low"), counted: 1000, takendown: 10, bucket: 1 });
  store.saveEvaluation({ ...evaluation("did:high"), counted: 100, takendown: 40, bucket: 30 });
  store.saveEvaluation({ ...evaluation("did:none"), counted: 1000, takendown: 0, bucket: 0 });
  assert.deepEqual(
    store.topEvaluations("follows", 2).map((e) => e.did),
    ["did:high", "did:low"],
  );
  assert.deepEqual(store.bucketCounts("follows"), { 0: 1, 1: 1, 30: 1 });
});

test("cursor round-trips", () => {
  const { store } = makeStore();
  assert.equal(store.loadCursor(), undefined);
  store.saveCursor(12345);
  assert.equal(store.loadCursor(), 12345);
});
