/**
 * Dry run against the live services: evaluates the given accounts and prints
 * what label they'd get, without touching the labeller or the real DB.
 *
 *   pnpm -F follows-audit probe samuel.fm did:plc:...
 *   pnpm -F follows-audit probe --followers bsky.app   # the followers side instead
 */
import type { AuditDirection } from "labeller-client";
import { evaluateAccount } from "./audit.ts";
import { loadConfig } from "./config.ts";
import {
  fetchFollowerSample,
  fetchFollowsSample,
  fetchModTakedowns,
  fetchRepoStatus,
  fetchVisibleProfiles,
  getJson,
  requestStats,
} from "./sources.ts";
import { AuditStore } from "./store.ts";

const config = loadConfig();
const store = new AuditStore({
  dbPath: ":memory:",
  activeTtlMs: config.activeTtlMs,
  inactiveTtlMs: config.inactiveTtlMs,
  evaluationTtlMs: config.labelExpiryMs,
  candidateTtlMs: config.candidateTtlMs,
  maxPendingTakedowns: 1,
  takedownDedupMs: config.takedownDedupMs,
});

const args = process.argv.slice(2);
const direction: AuditDirection = args.includes("--followers") ? "followers" : "follows";
const targets = args.filter((a) => !a.startsWith("--"));
if (targets.length === 0) throw new Error("usage: probe [--followers] <did-or-handle> [...]");

for (const target of targets) {
  try {
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
      direction,
      {
        store,
        sample: (dir, d, limit) =>
          dir === "follows"
            ? fetchFollowsSample(config.plc, config.pdsHosts, d, limit)
            : fetchFollowerSample(config.constellation, d, limit),
        visibleProfiles: (dids) => fetchVisibleProfiles(config.appview, dids),
        modTakedowns: (dids) => fetchModTakedowns(config.modService, config.modServiceDid, dids),
        repoStatus: (d) => fetchRepoStatus(config.relay, d),
        setLabel: async () => {},
      },
      config,
    );
    console.log(
      `${target} [${direction}]: ${r.skipped ? `skipped (${r.skipped}) ` : ""}` +
        `total=${r.total} sampled=${r.sampled} counted=${r.counted} takendown=${r.takendown} ` +
        `pct=${r.percent?.toFixed(2) ?? "-"} label=${r.label ?? "none"} ` +
        `modLabelled=${r.modLabelled} relayLookups=${r.relayLookups} in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`,
    );
  } catch (err) {
    console.log(`${target} [${direction}]: failed — ${String(err).slice(0, 160)}`);
  }
}
console.log("requests:", requestStats.requests);
store.close();
