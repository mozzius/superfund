/**
 * Bluesky's moderation service (mod.bsky.app) puts a `!takedown` or
 * `!suspend` label on every account it takes down or suspends. That includes
 * appview-only takedowns of accounts on other PDSes, which the relay and the
 * firehose never see as takedowns. We read these labels on demand (status
 * lookups, via sources.ts) and live from its label stream (to start a
 * fan-out when an account goes).
 */
import { decodeCborSequence } from "./cbor.ts";
import type { AccountStatus } from "./store.ts";

export const BSKY_MOD_DID = "did:plc:ar7c4by46qjdydhdevvrndac";

/** The mod service's account labels, and the status each one means. */
export const MOD_TAKEDOWN_LABELS: Readonly<Record<string, AccountStatus>> = {
  "!takedown": "takendown",
  "!suspend": "suspended",
};

export interface Label {
  src: string;
  uri: string;
  val: string;
  neg?: boolean | null;
  cts: string;
  exp?: string | null;
}

/** A takedown or suspension label on an account (not a record) from `src`. */
export function isAccountTakedownLabel(label: Label, src: string): boolean {
  return (
    label.src === src &&
    label.uri.startsWith("did:") &&
    Object.hasOwn(MOD_TAKEDOWN_LABELS, label.val)
  );
}

export function isExpired(label: Label, nowMs: number): boolean {
  return !!label.exp && Date.parse(label.exp) <= nowMs;
}

/**
 * Accounts that have a live takedown or suspension among these labels from
 * `src`. For each account and value the latest label wins, so a negation
 * cancels an earlier label. Expired labels don't count, and a takedown beats
 * a suspension.
 */
export function takedownsFromLabels(
  labels: Iterable<Label>,
  src: string,
  nowMs: number,
): Map<string, AccountStatus> {
  const latest = new Map<string, Label>();
  for (const label of labels) {
    if (!isAccountTakedownLabel(label, src)) continue;
    const key = `${label.uri} ${label.val}`;
    const prev = latest.get(key);
    if (!prev || Date.parse(label.cts) >= Date.parse(prev.cts)) latest.set(key, label);
  }
  const out = new Map<string, AccountStatus>();
  for (const label of latest.values()) {
    if (label.neg || isExpired(label, nowMs)) continue;
    if (out.get(label.uri) !== "takendown") out.set(label.uri, MOD_TAKEDOWN_LABELS[label.val]!);
  }
  return out;
}

// --- com.atproto.label.subscribeLabels

export type LabelFrame =
  | { kind: "labels"; seq: number; labels: Label[] }
  | { kind: "info"; name: string; message?: string }
  | { kind: "error"; error: string; message?: string }
  | { kind: "unknown"; type: string };

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v) && !(v instanceof Uint8Array);

function isLabel(v: unknown): v is Label {
  return (
    isRecord(v) &&
    typeof v.src === "string" &&
    typeof v.uri === "string" &&
    typeof v.val === "string" &&
    typeof v.cts === "string" &&
    (v.neg === undefined || v.neg === null || typeof v.neg === "boolean") &&
    (v.exp === undefined || v.exp === null || typeof v.exp === "string")
  );
}

export function parseLabelFrame(bytes: Uint8Array): LabelFrame {
  const [header, body] = decodeCborSequence(bytes);
  if (!isRecord(header) || !isRecord(body)) throw new Error("malformed label frame");
  const message = typeof body.message === "string" ? body.message : undefined;
  if (header.op === -1) return { kind: "error", error: String(body.error), message };
  if (header.t === "#labels") {
    const seq = body.seq;
    if (typeof seq !== "number") throw new Error("label frame without a seq");
    const labels = Array.isArray(body.labels) ? body.labels.filter(isLabel) : [];
    return { kind: "labels", seq, labels };
  }
  if (header.t === "#info") return { kind: "info", name: String(body.name), message };
  return { kind: "unknown", type: String(header.t) };
}

export interface LabelStreamOptions {
  /** The labeler's base URL, e.g. https://mod.bsky.app. */
  serviceUrl: string;
  /** Read on every (re)connect: resume after this seq, or tail live if undefined. */
  cursor(): number | undefined;
  onLabels(seq: number, labels: Label[]): void;
  /** An error frame; the stream reconnects afterwards. */
  onErrorFrame?(error: string): void;
  onConnect?(): void;
  /** Reconnect if no frame arrives for this long. */
  idleTimeoutMs?: number;
}

/** Follow a labeler's label stream, reconnecting with backoff. */
export function subscribeLabelStream(opts: LabelStreamOptions): { close(): void } {
  const endpoint = new URL("/xrpc/com.atproto.label.subscribeLabels", opts.serviceUrl);
  endpoint.protocol = endpoint.protocol === "http:" ? "ws:" : "wss:";
  const idleTimeoutMs = opts.idleTimeoutMs ?? 10 * 60_000;
  let closed = false;
  let failures = 0;
  let socket: WebSocket | undefined;

  const connect = () => {
    const url = new URL(endpoint);
    const cursor = opts.cursor();
    if (cursor !== undefined) url.searchParams.set("cursor", String(cursor));
    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    socket = ws;
    let retired = false;
    let lastFrameAt = Date.now();

    const retire = (reason: string) => {
      if (retired) return;
      retired = true;
      clearInterval(watchdog);
      try {
        ws.close();
      } catch {}
      if (closed) return;
      const delayMs = Math.min(60_000, 1000 * 2 ** failures++);
      console.warn(`[mod-labels] reconnecting in ${delayMs}ms (${reason})`);
      setTimeout(connect, delayMs);
    };

    const watchdog = setInterval(() => {
      if (Date.now() - lastFrameAt > idleTimeoutMs) {
        retire(`no frames for ${Math.round(idleTimeoutMs / 1000)}s`);
      }
    }, 30_000);
    watchdog.unref();

    ws.onopen = () => {
      console.log(`[mod-labels] connected cursor=${cursor ?? "live"}`);
      opts.onConnect?.();
    };
    ws.onmessage = (event) => {
      if (retired) return;
      lastFrameAt = Date.now();
      let frame: LabelFrame;
      try {
        frame = parseLabelFrame(new Uint8Array(event.data as ArrayBuffer));
      } catch (err) {
        console.error("[mod-labels] unreadable frame", err);
        return;
      }
      failures = 0;
      try {
        switch (frame.kind) {
          case "labels":
            opts.onLabels(frame.seq, frame.labels);
            break;
          case "info":
            console.warn(`[mod-labels] info ${frame.name}: ${frame.message ?? ""}`);
            break;
          case "error":
            console.error(`[mod-labels] error frame ${frame.error}: ${frame.message ?? ""}`);
            opts.onErrorFrame?.(frame.error);
            retire(`error frame ${frame.error}`);
            break;
        }
      } catch (err) {
        console.error("[mod-labels] handler failed", err);
      }
    };
    ws.onclose = (event) => retire(`closed code=${event.code}`);
    ws.onerror = () => retire("socket error");
  };

  connect();
  return {
    close() {
      closed = true;
      socket?.close();
    },
  };
}
