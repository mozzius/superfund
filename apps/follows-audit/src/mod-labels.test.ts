import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeCborSequence } from "./cbor.ts";
import { BSKY_MOD_DID, parseLabelFrame, takedownsFromLabels, type Label } from "./mod-labels.ts";

// Minimal canonical CBOR encoder, just for building test frames.
function encode(value: unknown): number[] {
  const head = (major: number, n: number): number[] => {
    if (n < 24) return [(major << 5) | n];
    if (n < 0x100) return [(major << 5) | 24, n];
    if (n < 0x10000) return [(major << 5) | 25, n >> 8, n & 0xff];
    if (n < 0x100000000) return [(major << 5) | 26, ...[24, 16, 8, 0].map((s) => (n >>> s) & 0xff)];
    const big = BigInt(n);
    return [(major << 5) | 27, ...[56n, 48n, 40n, 32n, 24n, 16n, 8n, 0n].map((s) => Number((big >> s) & 0xffn))];
  };
  if (value === false) return [0xf4];
  if (value === true) return [0xf5];
  if (value === null) return [0xf6];
  if (typeof value === "number") return value >= 0 ? head(0, value) : head(1, -1 - value);
  if (typeof value === "string") {
    const b = new TextEncoder().encode(value);
    return [...head(3, b.length), ...b];
  }
  if (value instanceof Uint8Array) return [...head(2, value.length), ...value];
  if (Array.isArray(value)) return [...head(4, value.length), ...value.flatMap(encode)];
  const entries = Object.entries(value as Record<string, unknown>);
  return [...head(5, entries.length), ...entries.flatMap(([k, v]) => [...encode(k), ...encode(v)])];
}
const frame = (...items: unknown[]) => new Uint8Array(items.flatMap(encode));

const label = (overrides: Partial<Label>): Label => ({
  src: BSKY_MOD_DID,
  uri: "did:plc:a",
  val: "!takedown",
  cts: "2026-11-20T10:00:00.000Z",
  ...overrides,
});

test("decodes a CBOR sequence", () => {
  const big = 2 ** 40 + 7;
  const items = decodeCborSequence(
    frame({ op: 1, t: "#labels" }, { n: -300, big, bytes: new Uint8Array([1, 2]), ok: true, nil: null, list: ["é", 70000] }),
  );
  assert.deepEqual(items, [
    { op: 1, t: "#labels" },
    { n: -300, big, bytes: new Uint8Array([1, 2]), ok: true, nil: null, list: ["é", 70000] },
  ]);
});

test("decodes a tagged CID as its payload", () => {
  // tag 42 (0xd8 0x2a) wrapping 3 bytes
  assert.deepEqual(decodeCborSequence(new Uint8Array([0xd8, 0x2a, 0x43, 0, 1, 2])), [new Uint8Array([0, 1, 2])]);
});

test("rejects truncated and indefinite-length CBOR", () => {
  assert.throws(() => decodeCborSequence(new Uint8Array([0x63, 0x61])), /truncated/);
  assert.throws(() => decodeCborSequence(new Uint8Array([0x9f, 0xff])), /unsupported/);
});

test("a __proto__ map key is just a key", () => {
  const bytes = new Uint8Array([0xa1, ...encode("__proto__"), ...encode({ polluted: true })]);
  const [o] = decodeCborSequence(bytes) as [Record<string, unknown>];
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
  assert.deepEqual(Object.keys(o), ["__proto__"]);
});

test("parses #labels frames, keeping only well-formed labels", () => {
  const good = { ver: 1, src: BSKY_MOD_DID, uri: "did:plc:a", val: "!takedown", cts: "2026-11-20T10:00:00.000Z", sig: new Uint8Array([9]) };
  const parsed = parseLabelFrame(frame({ op: 1, t: "#labels" }, { seq: 42, labels: [good, { uri: 5 }] }));
  assert.equal(parsed.kind, "labels");
  if (parsed.kind !== "labels") return;
  assert.equal(parsed.seq, 42);
  assert.equal(parsed.labels.length, 1);
  assert.equal(parsed.labels[0]!.val, "!takedown");
});

test("parses error and info frames", () => {
  assert.deepEqual(parseLabelFrame(frame({ op: -1 }, { error: "FutureCursor", message: "ahead" })), {
    kind: "error",
    error: "FutureCursor",
    message: "ahead",
  });
  assert.deepEqual(parseLabelFrame(frame({ op: 1, t: "#info" }, { name: "OutdatedCursor" })), {
    kind: "info",
    name: "OutdatedCursor",
    message: undefined,
  });
});

test("takedownsFromLabels: account takedowns and suspensions from the mod service only", () => {
  const now = Date.parse("2026-11-20T12:00:00.000Z");
  const result = takedownsFromLabels(
    [
      label({ uri: "did:plc:a" }),
      label({ uri: "did:plc:b", val: "!suspend" }),
      label({ uri: "did:plc:c", src: "did:plc:someone-else" }),
      label({ uri: "at://did:plc:d/app.bsky.feed.post/1" }),
      label({ uri: "did:plc:e", val: "spam" }),
      label({ uri: "did:plc:f", val: "constructor" }),
    ],
    BSKY_MOD_DID,
    now,
  );
  assert.deepEqual([...result], [
    ["did:plc:a", "takendown"],
    ["did:plc:b", "suspended"],
  ]);
});

test("takedownsFromLabels: latest label wins, expired ones don't count, takedown beats suspend", () => {
  const now = Date.parse("2026-11-20T12:00:00.000Z");
  const result = takedownsFromLabels(
    [
      // reversed
      label({ uri: "did:plc:a" }),
      label({ uri: "did:plc:a", neg: true, cts: "2026-11-20T11:00:00.000Z" }),
      // reversed, then taken down again
      label({ uri: "did:plc:b", cts: "2026-11-20T09:00:00.000Z" }),
      label({ uri: "did:plc:b", neg: true, cts: "2026-11-20T10:00:00.000Z" }),
      label({ uri: "did:plc:b", cts: "2026-11-20T11:00:00.000Z" }),
      // suspension over
      label({ uri: "did:plc:c", val: "!suspend", exp: "2026-11-20T11:59:00.000Z" }),
      // suspension still running, neg: null as the JSON API sends it
      label({ uri: "did:plc:d", val: "!suspend", neg: null, exp: "2026-11-21T00:00:00.000Z" }),
      // both
      label({ uri: "did:plc:e", val: "!suspend" }),
      label({ uri: "did:plc:e", val: "!takedown" }),
      label({ uri: "did:plc:f", val: "!takedown" }),
      label({ uri: "did:plc:f", val: "!suspend" }),
    ],
    BSKY_MOD_DID,
    now,
  );
  assert.deepEqual(Object.fromEntries(result), {
    "did:plc:b": "takendown",
    "did:plc:d": "suspended",
    "did:plc:e": "takendown",
    "did:plc:f": "takendown",
  });
});
