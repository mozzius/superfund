import { test } from "node:test";
import assert from "node:assert/strict";
import type { AuditDirection } from "labeller-client";
import { evaluateAccount, type AuditDeps } from "./audit.ts";
import { AuditStore } from "./store.ts";

const DAY = 86_400_000;
const opts = { sampleSize: 1000, minCounted: 50 };

/**
 * `accounts` maps DID -> status. "active" accounts are visible on the AppView;
 * the rest are hidden and the relay returns their status, except
 * "label:<status>" ones: the relay says active (an appview-only takedown) and
 * only the mod label knows.
 */
function setup(accounts: Record<string, string>, { modDown = false } = {}) {
  const store = new AuditStore({
    dbPath: ":memory:",
    activeTtlMs: 7 * DAY,
    inactiveTtlMs: 30 * DAY,
    evaluationTtlMs: 30 * DAY,
    candidateTtlMs: 14 * DAY,
    maxPendingTakedowns: 100,
    takedownDedupMs: 30 * DAY,
  });
  const calls = {
    profiles: 0,
    mod: 0,
    relay: 0,
    samples: [] as AuditDirection[],
    labels: [] as [AuditDirection, string | null][],
  };
  const deps: AuditDeps = {
    store,
    sample: async (direction) => {
      calls.samples.push(direction);
      const dids = Object.keys(accounts);
      return { total: dids.length, dids };
    },
    visibleProfiles: async (dids) => {
      calls.profiles++;
      return new Set(dids.filter((d) => accounts[d] === "active"));
    },
    modTakedowns: async (dids) => {
      calls.mod++;
      assert.ok(dids.length <= 25);
      if (modDown) throw new Error("mod service down");
      const out = new Map<string, string>();
      for (const d of dids) {
        const s = accounts[d]!;
        if (s.startsWith("label:")) out.set(d, s.slice("label:".length));
      }
      return out;
    },
    repoStatus: async (did) => {
      calls.relay++;
      const s = accounts[did]!;
      if (s === "boom") throw new Error("relay down");
      return s.startsWith("label:") ? "active" : s;
    },
    setLabel: async (_did, direction, label) => {
      calls.labels.push([direction, label]);
    },
  };
  return { store, deps, calls };
}

function makeAccounts(counts: Record<string, number>) {
  const out: Record<string, string> = {};
  let i = 0;
  for (const [status, n] of Object.entries(counts)) {
    for (let j = 0; j < n; j++) out[`did:plc:f${i++}`] = status;
  }
  return out;
}

test("computes the takendown share, excluding deleted accounts", async () => {
  const { deps, calls } = setup(
    makeAccounts({ active: 700, takendown: 250, deactivated: 50, deleted: 500 }),
  );
  const r = await evaluateAccount("did:plc:target", "follows", deps, opts);
  assert.equal(r.counted, 1000);
  assert.equal(r.takendown, 250);
  assert.equal(r.percent, 25);
  assert.equal(r.bucket, 20);
  assert.equal(r.label, "follows-takendown-twenty");
  assert.deepEqual(calls.labels, [["follows", "follows-takendown-twenty"]]);
  assert.equal(calls.profiles, 60, "1500 accounts in batches of 25");
  assert.equal(calls.mod, 32, "one label lookup per batch with hidden accounts");
  assert.equal(calls.relay, 800, "only hidden accounts hit the relay");
});

test("suspended accounts count as taken down", async () => {
  const { deps } = setup(makeAccounts({ active: 850, takendown: 100, suspended: 50 }));
  const r = await evaluateAccount("did:plc:target", "follows", deps, opts);
  assert.equal(r.counted, 1000);
  assert.equal(r.takendown, 150);
});

test("mod labels catch appview-only takedowns and skip the relay for them", async () => {
  const { deps, calls, store } = setup(
    makeAccounts({ active: 800, takendown: 50, "label:takendown": 100, "label:suspended": 50 }),
  );
  const r = await evaluateAccount("did:plc:target", "follows", deps, opts);
  assert.equal(r.counted, 1000);
  assert.equal(r.takendown, 200);
  assert.equal(r.modLabelled, 150);
  assert.equal(r.relayLookups, 50);
  assert.equal(calls.relay, 50);
  assert.equal(store.getStatuses(["did:plc:f850"]).get("did:plc:f850"), "takendown", "cached");
});

test("a mod label outage falls back to the relay", async () => {
  const { deps, calls } = setup(makeAccounts({ active: 800, takendown: 100, "label:takendown": 100 }), {
    modDown: true,
  });
  const r = await evaluateAccount("did:plc:target", "follows", deps, opts);
  assert.equal(r.counted, 1000);
  assert.equal(r.takendown, 100, "appview-only takedowns look active to the relay");
  assert.equal(r.modLabelled, 0);
  assert.equal(calls.relay, 200);
});

test("uses the family for the direction", async () => {
  const accounts = makeAccounts({ active: 880, takendown: 120 });
  const follows = await evaluateAccount("did:plc:target", "follows", setup(accounts).deps, opts);
  const followers = await evaluateAccount("did:plc:target", "followers", setup(accounts).deps, opts);
  assert.equal(follows.label, "follows-takendown-ten");
  assert.equal(followers.label, null, "followers family starts at 20%");
});

test("reuses cached statuses on the next evaluation", async () => {
  const { deps, calls } = setup(makeAccounts({ active: 80, takendown: 20 }));
  await evaluateAccount("did:plc:target", "follows", deps, opts);
  const before = { ...calls };
  const r = await evaluateAccount("did:plc:target", "follows", deps, opts);
  assert.equal(r.cacheHits, 100);
  assert.equal(calls.profiles, before.profiles);
  assert.equal(calls.relay, before.relay);
});

test("skips accounts with too small a sample, without labelling", async () => {
  const { deps, calls } = setup(makeAccounts({ takendown: 30 }));
  const r = await evaluateAccount("did:plc:target", "follows", deps, opts);
  assert.equal(r.skipped, "small-sample");
  assert.equal(r.bucket, 0);
  assert.deepEqual(calls.labels, []);
  assert.equal(calls.profiles, 0);
});

test("clears the label when an account drops out of every bucket", async () => {
  const accounts = makeAccounts({ active: 670, takendown: 330 });
  const { deps, calls, store } = setup(accounts);
  await evaluateAccount("did:plc:target", "follows", deps, opts);
  assert.equal(store.getEvaluation("did:plc:target", "follows")?.bucket, 30);

  // Takedowns reversed.
  store.setStatuses(Object.keys(accounts).map((d) => [d, "active"]));
  const r = await evaluateAccount("did:plc:target", "follows", deps, opts);
  assert.equal(r.bucket, 0);
  assert.equal(r.labelCall, "clear");
  assert.deepEqual(calls.labels, [
    ["follows", "follows-takendown-thirty"],
    ["follows", null],
  ]);
});

test("relay failures are left out rather than counted or cached", async () => {
  const { deps, store } = setup(makeAccounts({ active: 900, takendown: 100, boom: 5 }));
  const r = await evaluateAccount("did:plc:target", "follows", deps, opts);
  assert.equal(r.counted, 1000);
  assert.equal(r.percent, 10);
  assert.equal(store.getStatuses(["did:plc:f1000"]).size, 0);
});
