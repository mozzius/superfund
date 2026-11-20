import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateAccount, type AuditDeps } from "./audit.ts";
import { AuditStore } from "./store.ts";

const DAY = 86_400_000;
const opts = { sampleSize: 1000, minFollowers: 50, minCounted: 50 };

function setup(followers: Record<string, string>, total = Object.keys(followers).length) {
  const store = new AuditStore({
    dbPath: ":memory:",
    activeTtlMs: 7 * DAY,
    inactiveTtlMs: 30 * DAY,
    evaluationTtlMs: 30 * DAY,
    maxQueue: 100,
  });
  const calls = { profiles: 0, relay: 0, labels: [] as (string | null)[] };
  const deps: AuditDeps = {
    store,
    followerSample: async () => ({ total, dids: Object.keys(followers) }),
    visibleProfiles: async (dids) => {
      calls.profiles++;
      return new Set(dids.filter((d) => followers[d] === "active"));
    },
    repoStatus: async (did) => {
      calls.relay++;
      const s = followers[did]!;
      if (s === "boom") throw new Error("relay down");
      return s;
    },
    setLabel: async (_did, label) => {
      calls.labels.push(label);
    },
  };
  return { store, deps, calls };
}

function makeFollowers(counts: Record<string, number>) {
  const out: Record<string, string> = {};
  let i = 0;
  for (const [status, n] of Object.entries(counts)) {
    for (let j = 0; j < n; j++) out[`did:plc:f${i++}`] = status;
  }
  return out;
}

test("computes the takendown share, excluding deleted accounts", async () => {
  const { deps, calls } = setup(
    makeFollowers({ active: 70, takendown: 25, deactivated: 5, deleted: 50 }),
  );
  const r = await evaluateAccount("did:plc:target", deps, opts);
  assert.equal(r.counted, 100);
  assert.equal(r.takendown, 25);
  assert.equal(r.percent, 25);
  assert.equal(r.bucket, 20);
  assert.equal(r.label, "followers-takendown-twenty");
  assert.deepEqual(calls.labels, ["followers-takendown-twenty"]);
  assert.equal(calls.profiles, 6, "150 followers in batches of 25");
  assert.equal(calls.relay, 80, "only hidden accounts hit the relay");
});

test("reuses cached statuses on the next evaluation", async () => {
  const { deps, calls } = setup(makeFollowers({ active: 80, takendown: 20 }));
  await evaluateAccount("did:plc:target", deps, opts);
  const before = { ...calls };
  const r = await evaluateAccount("did:plc:target", deps, opts);
  assert.equal(r.cacheHits, 100);
  assert.equal(calls.profiles, before.profiles);
  assert.equal(calls.relay, before.relay);
});

test("skips accounts with too few followers, without labelling", async () => {
  const { deps, calls } = setup(makeFollowers({ takendown: 30 }));
  const r = await evaluateAccount("did:plc:target", deps, opts);
  assert.equal(r.skipped, "few-followers");
  assert.equal(r.bucket, 0);
  assert.deepEqual(calls.labels, []);
  assert.equal(calls.profiles, 0);
});

test("clears the label when an account drops below 10%", async () => {
  const followers = makeFollowers({ active: 70, takendown: 30 });
  const { deps, calls, store } = setup(followers);
  await evaluateAccount("did:plc:target", deps, opts);
  assert.equal(store.getEvaluation("did:plc:target")?.bucket, 30);

  // Takedowns reversed.
  store.setStatuses(Object.keys(followers).map((d) => [d, "active"]));
  const r = await evaluateAccount("did:plc:target", deps, opts);
  assert.equal(r.bucket, 0);
  assert.equal(r.labelCall, "clear");
  assert.deepEqual(calls.labels, ["followers-takendown-thirty", null]);
});

test("relay failures are left out rather than counted or cached", async () => {
  const { deps, store } = setup(makeFollowers({ active: 90, takendown: 10, boom: 5 }));
  const r = await evaluateAccount("did:plc:target", deps, opts);
  assert.equal(r.counted, 100);
  assert.equal(r.percent, 10);
  assert.equal(store.getStatuses(["did:plc:f100"]).size, 0);
});
