import { createServer, type Server } from "node:http";
import { TAKEDOWN_LABEL_FAMILIES, type AuditDirection } from "labeller-client";
import type { AuditStore } from "./store.ts";

const TOP_LIMIT = 300;
const CACHE_MS = 30_000;

/**
 * Internal, read-only JSON for the labeller's dashboard: whose follows and
 * followers have been taken down the most. Railway private network only; /data.json needs the
 * shared INTERNAL_API_KEY.
 */
export function createDataServer(
  store: AuditStore,
  apiKey: string,
  stats: () => Record<string, unknown>,
): Server {
  let cached: { at: number; body: string } | undefined;
  const data = () => {
    if (cached && Date.now() - cached.at < CACHE_MS) return cached.body;
    const direction = (d: AuditDirection) => ({
      buckets: store.bucketCounts(d),
      thresholds: TAKEDOWN_LABEL_FAMILIES[d].map((l) => l.minPercent),
      accounts: store.topEvaluations(d, TOP_LIMIT).map((e) => ({
        did: e.did,
        pct: Math.round((e.takendown / e.counted) * 10000) / 100,
        takendown: e.takendown,
        counted: e.counted,
        bucket: e.bucket,
        checkedAt: new Date(e.evaluatedAtMs).toISOString(),
      })),
    });
    const body = JSON.stringify({
      generatedAt: new Date().toISOString(),
      stats: stats(),
      follows: direction("follows"),
      followers: direction("followers"),
    });
    cached = { at: Date.now(), body };
    return body;
  };

  return createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    try {
      if (path === "/health") {
        res.writeHead(200, { "content-type": "text/plain" }).end("ok");
      } else if (path === "/data.json") {
        if (req.headers.authorization !== `Bearer ${apiKey}`) {
          res.writeHead(401, { "content-type": "text/plain" }).end("unauthorized");
          return;
        }
        res.writeHead(200, { "content-type": "application/json" }).end(data());
      } else {
        res.writeHead(404, { "content-type": "text/plain" }).end("not found");
      }
    } catch (err) {
      console.error("[data-server] request failed", err);
      res.writeHead(500, { "content-type": "text/plain" }).end("error");
    }
  });
}
