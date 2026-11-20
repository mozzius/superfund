const USER_AGENT = "superfund-follower-audit/1.0 (atproto labeler)";

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

export interface FollowerSample {
  /** Total distinct followers Constellation knows about (undercounts old follows). */
  total: number;
  /** Most recent followers first, deduplicated. */
  dids: string[];
}

/** Up to `limit` of the account's most recent followers, via Constellation backlinks. */
export async function fetchFollowerSample(
  constellation: Upstream,
  did: string,
  limit: number,
): Promise<FollowerSample> {
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

/**
 * Which of these DIDs the AppView still shows a profile for (max 25). The
 * AppView hides taken-down, suspended, deactivated and deleted accounts, so
 * this is the cheap batch filter before per-account relay lookups.
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
