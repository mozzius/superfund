/**
 * Adds (or updates) the follows-takendown-* and followers-takendown-* label
 * definitions on the labeler's app.bsky.labeler.service record. Other
 * definitions and the rest of the record are left untouched.
 *
 *   LABELER_IDENTIFIER=labeler.example.com LABELER_PASSWORD=xxxx \
 *     pnpm -F labeller label-defs [--dry-run]
 *
 * LABELER_IDENTIFIER defaults to LABELER_DID. An app password works.
 * LABELER_PDS defaults to https://bsky.social.
 */
import { TAKEDOWN_LABEL_FAMILIES, type AuditDirection } from "labeller-client";

interface LabelValueDefinition {
  identifier: string;
  severity: "inform" | "alert" | "none";
  blurs: "content" | "media" | "none";
  defaultSetting?: "ignore" | "warn" | "hide";
  adultOnly?: boolean;
  locales: { lang: string; name: string; description: string }[];
}

const WORDING: Record<AuditDirection, { name: string; subject: string; basis: string }> = {
  follows: {
    name: "of follows taken down",
    subject: "of the accounts this account follows",
    basis: "Based on up to 1,000 of its most recent follows.",
  },
  followers: {
    name: "of followers taken down",
    subject: "of this account's followers",
    basis: "Based on up to 1,000 of its most recent followers.",
  },
};

const definitions: LabelValueDefinition[] = (
  Object.entries(TAKEDOWN_LABEL_FAMILIES) as [AuditDirection, (typeof TAKEDOWN_LABEL_FAMILIES)[AuditDirection]][]
).flatMap(([direction, family]) =>
  family.map((label, i) => {
    const next = family[i + 1];
    const range = next ? `${label.minPercent}–${next.minPercent}%` : `${label.minPercent}%+`;
    const share = next
      ? `Between ${label.minPercent}% and ${next.minPercent}%`
      : `${label.minPercent}% or more`;
    const w = WORDING[direction];
    return {
      identifier: label.val,
      severity: "inform",
      blurs: "none",
      defaultSetting: "warn",
      adultOnly: false,
      locales: [
        {
          lang: "en",
          name: `${range} ${w.name}`,
          description: `${share} ${w.subject} have been taken down by moderation. ${w.basis}`,
        },
      ],
    } satisfies LabelValueDefinition;
  }),
);

const dryRun = process.argv.includes("--dry-run");
const identifier = process.env.LABELER_IDENTIFIER ?? process.env.LABELER_DID;
const password = process.env.LABELER_PASSWORD;
const entryway = (process.env.LABELER_PDS ?? "https://bsky.social").replace(/\/$/, "");
if (!identifier || !password) {
  throw new Error("set LABELER_IDENTIFIER (or LABELER_DID) and LABELER_PASSWORD");
}

async function xrpc<T>(
  base: string,
  nsid: string,
  init: { method?: "GET" | "POST"; token?: string; params?: Record<string, string>; body?: unknown },
): Promise<T> {
  const url = new URL(`/xrpc/${nsid}`, base);
  for (const [k, v] of Object.entries(init.params ?? {})) url.searchParams.set(k, v);
  const res = await fetch(url, {
    method: init.method ?? "GET",
    headers: {
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${nsid} failed: ${res.status} ${text}`);
  return JSON.parse(text) as T;
}

const session = await xrpc<{
  did: string;
  accessJwt: string;
  didDoc?: { service?: { id: string; serviceEndpoint: string }[] };
}>(entryway, "com.atproto.server.createSession", {
  method: "POST",
  body: { identifier, password },
});
const pds =
  session.didDoc?.service?.find((s) => s.id === "#atproto_pds")?.serviceEndpoint ?? entryway;

const existing = await xrpc<{ cid: string; value: Record<string, any> }>(
  pds,
  "com.atproto.repo.getRecord",
  { params: { repo: session.did, collection: "app.bsky.labeler.service", rkey: "self" } },
).catch((err) => {
  throw new Error(
    `couldn't read the labeler service record — has \`pnpm -F labeller skyware-setup\` been run? (${err.message})`,
  );
});

const record = existing.value;
const oldDefs: LabelValueDefinition[] = record.policies?.labelValueDefinitions ?? [];
const oldValues: string[] = record.policies?.labelValues ?? [];
const newIds = new Set(definitions.map((d) => d.identifier));
const keep = (id: string) => !newIds.has(id);

const mergedDefs = [...oldDefs.filter((d) => keep(d.identifier)), ...definitions];
const mergedValues = [
  ...new Set([...oldValues.filter(keep), ...definitions.map((d) => d.identifier)]),
];

console.log(`labeler ${session.did} on ${pds}`);
for (const d of definitions) {
  const verb = oldDefs.some((o) => o.identifier === d.identifier) ? "update" : "add   ";
  console.log(`  ${verb} ${d.identifier}  "${d.locales[0]!.name}"`);
}
const kept = oldDefs.filter((d) => keep(d.identifier)).map((d) => d.identifier);
console.log(`  keep   ${kept.join(", ") || "(none)"}`);

if (dryRun) {
  console.log("\n--dry-run: not writing. Record would become:");
  console.log(JSON.stringify({ ...record, policies: { ...record.policies, labelValues: mergedValues, labelValueDefinitions: mergedDefs } }, null, 2));
  process.exit(0);
}

await xrpc(pds, "com.atproto.repo.putRecord", {
  method: "POST",
  token: session.accessJwt,
  body: {
    repo: session.did,
    collection: "app.bsky.labeler.service",
    rkey: "self",
    swapRecord: existing.cid,
    validate: true,
    record: {
      ...record,
      policies: {
        ...record.policies,
        labelValues: mergedValues,
        labelValueDefinitions: mergedDefs,
      },
    },
  },
});
console.log("done — clients pick up new definitions within a few minutes.");
