import { takedownsFromLabels, type Label } from "./mod-labels.ts";
import type { AccountStatus } from "./store.ts";

const USER_AGENT = "superfund-follows-audit/1.0 (atproto labeler)";

/** Spaces requests to one host at a fixed rate; a 429 pauses the host. */
export class RateLimiter {
  readonly #intervalMs: number;
  #nextAt = 0;

  constructor(requestsPerSecond: number) {
    if (!(requestsPerSecond > 0)) throw new Error("requestsPerSecond must be > 0");
    this.#intervalMs = 1000 / requestsPerSecond;
  }

  async take(): Promise<void> {
    const now = Date.now();
    const slot = Math.max(now, this.#nextAt);
    this.#nextAt = slot + this.#intervalMs;
    if (slot > now) await sleep(slot - now);
  }

  pauseFor(ms: number): void {
    this.#nextAt = Math.max(this.#nextAt, Date.now() + ms);
  }
}

export class HttpError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(status: number, body: string, url: string) {
    super(`${status} from ${url}: ${body.slice(0, 200)}`);
    this.status = status;
    this.body = body;
  }
}

export interface Upstream {
  baseUrl: string;
  limiter: RateLimiter;
}

export interface RequestStats {
  requests: Record<string, number>;
  retries: number;
}

export const requestStats: RequestStats = { requests: {}, retries: 0 };

const ATTEMPTS = 3;

/** GET JSON with rate limiting and retries on 429 / 5xx / network errors. */
export async function getJson<T>(
  upstream: Upstream,
  path: string,
  params: URLSearchParams,
  label: string,
): Promise<T> {
  const url = `${upstream.baseUrl.replace(/\/$/, "")}${path}?${params}`;
  for (let attempt = 1; ; attempt++) {
    await upstream.limiter.take();
    requestStats.requests[label] = (requestStats.requests[label] ?? 0) + 1;
    let res: Response;
    try {
      res = await fetch(url, {
        headers: { "user-agent": USER_AGENT, accept: "application/json" },
        signal: AbortSignal.timeout(20_000),
      });
    } catch (err) {
      if (attempt >= ATTEMPTS) throw err;
      requestStats.retries++;
      await sleep(1000 * 2 ** (attempt - 1));
      continue;
    }
    if (res.ok) return (await res.json()) as T;

    const body = await res.text();
    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt >= ATTEMPTS) throw new HttpError(res.status, body, url);
    requestStats.retries++;
    const retryAfterS = Number(res.headers.get("retry-after"));
    const backoffMs =
      Number.isFinite(retryAfterS) && retryAfterS > 0
        ? retryAfterS * 1000
        : 1000 * 2 ** (attempt - 1);
    if (res.status === 429) upstream.limiter.pauseFor(backoffMs);
    await sleep(backoffMs);
  }
}

/** Per-host rate limiters, created on first use (one per PDS, say). */
export class HostLimiters {
  readonly #rps: number;
  readonly #limiters = new Map<string, RateLimiter>();

  constructor(requestsPerSecond: number) {
    this.#rps = requestsPerSecond;
  }

  upstream(baseUrl: string): Upstream {
    const host = new URL(baseUrl).host;
    let limiter = this.#limiters.get(host);
    if (!limiter) {
      limiter = new RateLimiter(this.#rps);
      this.#limiters.set(host, limiter);
    }
    return { baseUrl, limiter };
  }
}

export interface GraphSample {
  /** Size of the list the sample came from, as far as the source knows. */
  total: number;
  /** Most recent first, deduplicated, without the account itself. */
  dids: string[];
}

/** Up to `limit` of the account's most recent followers, via Constellation backlinks. */
export async function fetchFollowerSample(
  constellation: Upstream,
  did: string,
  limit: number,
): Promise<GraphSample> {
  const data = await getJson<{ total?: number; linking_dids?: string[] }>(
    constellation,
    "/links/distinct-dids",
    new URLSearchParams({
      target: did,
      collection: "app.bsky.graph.follow",
      path: ".subject",
      limit: String(limit),
    }),
    "constellation",
  );
  const dids = [...new Set((data.linking_dids ?? []).filter((d) => d !== did))];
  return { total: Number(data.total ?? dids.length), dids };
}

/** The account's PDS endpoint from its DID document (did:plc or did:web). */
export async function resolvePds(plc: Upstream, hosts: HostLimiters, did: string): Promise<string> {
  type DidDoc = { service?: { id: string; type?: string; serviceEndpoint?: unknown }[] };
  let doc: DidDoc;
  if (did.startsWith("did:plc:")) {
    doc = await getJson<DidDoc>(plc, `/${encodeURIComponent(did)}`, new URLSearchParams(), "plc");
  } else if (did.startsWith("did:web:")) {
    const host = decodeURIComponent(did.slice("did:web:".length));
    doc = await getJson<DidDoc>(
      hosts.upstream(`https://${host}`),
      "/.well-known/did.json",
      new URLSearchParams(),
      "didweb",
    );
  } else {
    throw new Error(`unsupported DID method: ${did}`);
  }
  const service = doc.service?.find(
    (s) => s.id === "#atproto_pds" || s.id === `${did}#atproto_pds`,
  );
  if (typeof service?.serviceEndpoint !== "string") throw new Error(`no PDS in DID doc for ${did}`);
  return service.serviceEndpoint;
}

/**
 * Up to `limit` of the accounts `did` most recently followed, read straight
 * from its repo. Unlike the AppView's getFollows this still lists accounts
 * that have since been taken down.
 */
export async function fetchFollowsSample(
  plc: Upstream,
  hosts: HostLimiters,
  did: string,
  limit: number,
): Promise<GraphSample> {
  const pds = hosts.upstream(await resolvePds(plc, hosts, did));
  const seen = new Set<string>();
  let cursor: string | undefined;
  do {
    const params = new URLSearchParams({
      repo: did,
      collection: "app.bsky.graph.follow",
      limit: "100",
    });
    if (cursor) params.set("cursor", cursor);
    const page = await getJson<{ records?: { value?: { subject?: unknown } }[]; cursor?: string }>(
      pds,
      "/xrpc/com.atproto.repo.listRecords",
      params,
      "pds",
    );
    const records = page.records ?? [];
    for (const r of records) {
      const subject = r.value?.subject;
      if (typeof subject === "string" && subject.startsWith("did:") && subject !== did) {
        seen.add(subject);
      }
    }
    cursor = records.length ? page.cursor : undefined;
  } while (cursor && seen.size < limit);
  const dids = [...seen].slice(0, limit);
  return { total: dids.length, dids };
}

/**
 * Which of these DIDs the AppView still shows a profile for (max 25). The
 * AppView hides taken-down, suspended, deactivated and deleted accounts, so
 * this is the cheap batch filter before mod label and relay lookups.
 */
export async function fetchVisibleProfiles(appview: Upstream, dids: string[]): Promise<Set<string>> {
  if (dids.length === 0) return new Set();
  if (dids.length > 25) throw new Error("getProfiles takes at most 25 actors");
  const params = new URLSearchParams();
  for (const did of dids) params.append("actors", did);
  const data = await getJson<{ profiles?: { did: string }[] }>(
    appview,
    "/xrpc/app.bsky.actor.getProfiles",
    params,
    "appview",
  );
  return new Set((data.profiles ?? []).map((p) => p.did));
}

/**
 * Which of these DIDs (max 25) the moderation service `modDid` has taken
 * down or suspended, from its `!takedown` / `!suspend` account labels. This
 * catches appview-only takedowns, which the relay still reports as active.
 */
export async function fetchModTakedowns(
  mod: Upstream,
  modDid: string,
  dids: string[],
): Promise<Map<string, AccountStatus>> {
  // Ozone rejects wildcard patterns; a DID never contains "*" anyway.
  const subjects = dids.filter((d) => !d.includes("*"));
  if (subjects.length === 0) return new Map();
  if (subjects.length > 25) throw new Error("fetchModTakedowns takes at most 25 DIDs");
  const PAGE = 250;
  const labels: Label[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 10; page++) {
    const params = new URLSearchParams({ sources: modDid, limit: String(PAGE) });
    for (const did of subjects) params.append("uriPatterns", did);
    if (cursor) params.set("cursor", cursor);
    const data = await getJson<{ labels?: Label[]; cursor?: string }>(
      mod,
      "/xrpc/com.atproto.label.queryLabels",
      params,
      "mod",
    );
    const got = data.labels ?? [];
    labels.push(...got);
    if (got.length < PAGE || !data.cursor) break;
    cursor = data.cursor;
  }
  return takedownsFromLabels(labels, modDid, Date.now());
}

/** The relay's view of an account: "active", its status string, or "not-found". */
export async function fetchRepoStatus(relay: Upstream, did: string): Promise<string> {
  try {
    const data = await getJson<{ active?: boolean; status?: string }>(
      relay,
      "/xrpc/com.atproto.sync.getRepoStatus",
      new URLSearchParams({ did }),
      "relay",
    );
    if (data.active) return "active";
    return data.status ?? "inactive";
  } catch (err) {
    if (err instanceof HttpError && (err.status === 404 || err.status === 400)) {
      return "not-found";
    }
    throw err;
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
