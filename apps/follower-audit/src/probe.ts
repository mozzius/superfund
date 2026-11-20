/**
 * Dry run against the live services: evaluates the given accounts and prints
 * what label they'd get, without touching the labeller or the real DB.
 *
 *   pnpm -F follower-audit probe did:plc:... someone.bsky.social
 */
import { evaluateAccount } from "./audit.ts";
import { loadConfig } from "./config.ts";
import { fetchFollowerSample, fetchRepoStatus, fetchVisibleProfiles, getJson, requestStats } from "./sources.ts";
import { AuditStore } from "./store.ts";

const config = loadConfig();
const store = new AuditStore({
  dbPath: ":memory:",
  activeTtlMs: config.activeTtlMs,
  inactiveTtlMs: config.inactiveTtlMs,
  evaluationTtlMs: config.labelExpiryMs,
  maxQueue: 1,
});

const targets = process.argv.slice(2);
if (targets.length === 0) throw new Error("usage: probe <did-or-handle> [...]");

for (const target of targets) {
  const did = target.startsWith("did:")
    ? target
    : (
        await getJson<{ did: string }>(
          config.appview,
          "/xrpc/com.atproto.identity.resolveHandle",
          new URLSearchParams({ handle: target }),
          "appview",
        )
      ).did;
  const startedAt = Date.now();
  const r = await evaluateAccount(
    did,
    {
      store,
      followerSample: (d, limit) => fetchFollowerSample(config.constellation, d, limit),
      visibleProfiles: (dids) => fetchVisibleProfiles(config.appview, dids),
      repoStatus: (d) => fetchRepoStatus(config.relay, d),
      setLabel: async () => {},
    },
    config,
  );
  console.log(
    `${target}: ${r.skipped ? `skipped (${r.skipped}) ` : ""}followers=${r.followers} ` +
      `sampled=${r.sampled} counted=${r.counted} takendown=${r.takendown} ` +
      `pct=${r.percent?.toFixed(1) ?? "-"} label=${r.label ?? "none"} ` +
      `relayLookups=${r.relayLookups} in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`,
  );
}
console.log("requests:", requestStats.requests);
store.close();
