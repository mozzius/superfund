import type { LabelerServer } from "@skyware/labeler";
import Fastify, { type FastifyInstance } from "fastify";
import { ZodError } from "zod";
import { routes, type SavedLabel } from "labeller-client";

/** Result of building the queryLabels WHERE clause. */
export interface QueryLabelsSql {
  sql: string;
  args: (string | number)[];
}

/** Escape a literal so it's safe to embed in a LIKE pattern. */
function escapeLikeLiteral(s: string): string {
  return s.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

/**
 * Build the parameterised SQL for the queryLabels endpoint.
 * Returns an error string if the input is invalid (e.g. non-trailing wildcard).
 */
export function buildQueryLabelsSql(
  input: { uriPatterns: string[]; sources?: string[] },
): QueryLabelsSql | { error: string } {
  const { uriPatterns, sources } = input;

  const patterns: string[] = [];
  const matchAll = uriPatterns.includes("*");
  if (!matchAll) {
    for (const raw of uriPatterns) {
      const cleaned = escapeLikeLiteral(raw);
      const star = cleaned.indexOf("*");
      if (star !== -1 && star !== cleaned.length - 1) {
        return { error: "only trailing wildcards are supported in uriPatterns" };
      }
      patterns.push(star === -1 ? cleaned : cleaned.slice(0, -1) + "%");
    }
  }

  const conditions: string[] = [];
  const args: (string | number)[] = [];
  if (patterns.length) {
    conditions.push(
      "(" + patterns.map(() => "uri LIKE ? ESCAPE '\\'").join(" OR ") + ")",
    );
    args.push(...patterns);
  }
  if (sources?.length) {
    conditions.push(`src IN (${sources.map(() => "?").join(", ")})`);
    args.push(...sources);
  }
  const whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  return {
    sql: `SELECT * FROM labels ${whereClause} ORDER BY id ASC LIMIT 250`,
    args,
  };
}

/** Per-key mutex to serialise concurrent upsertLabel calls (libsql uses a single connection). */
const upsertLocks = new Map<string, Promise<unknown>>();
function withUpsertLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = upsertLocks.get(key) ?? Promise.resolve();
  const result = prev.then(fn, fn);
  const chain = result.then(
    () => {},
    () => {},
  );
  upsertLocks.set(key, chain);
  chain.finally(() => {
    if (upsertLocks.get(key) === chain) upsertLocks.delete(key);
  });
  return result;
}

export function createInternalServer(
  labeler: LabelerServer,
  apiKey: string,
): FastifyInstance {
  const app = Fastify();

  app.addHook("onRequest", async (req, reply) => {
    if (req.headers.authorization !== `Bearer ${apiKey}`) {
      console.warn(
        `[internal] 401 ${req.method} ${req.url} ip=${req.ip} ua=${req.headers["user-agent"] ?? "-"}`,
      );
      reply.code(401).send({ error: "unauthorized" });
      return;
    }
    (req as unknown as { _startedAt: number })._startedAt = Date.now();
    console.log(`[internal] -> ${req.method} ${req.url}`);
  });

  app.addHook("onResponse", async (req, reply) => {
    const startedAt = (req as unknown as { _startedAt?: number })._startedAt;
    const durMs = startedAt ? Date.now() - startedAt : -1;
    console.log(
      `[internal] <- ${req.method} ${req.url} status=${reply.statusCode} durMs=${durMs}`,
    );
  });

  app.addHook("onError", async (req, _reply, err) => {
    console.error(`[internal] !! ${req.method} ${req.url}`, err);
  });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError) {
      reply.code(400).send({ error: "invalid input", details: err.issues });
      return;
    }
    reply.send(err);
  });

  app.post(routes.createLabels.path, async (req) => {
    const input = routes.createLabels.input.parse(req.body);
    const create = input.create ?? [];

    // Dedup: skip labels that already exist and are active. Makes this
    // endpoint idempotent on Jetstream replay.
    const nowIso = new Date().toISOString();
    const needCreate: string[] = [];
    for (const val of create) {
      const existing = await labeler.db.execute({
        sql: `SELECT 1 FROM labels
              WHERE src = ? AND uri = ? AND val = ?
                AND (neg IS NULL OR neg = 0)
                AND (exp IS NULL OR exp > ?)
              LIMIT 1`,
        args: [labeler.did, input.subject.uri, val, nowIso],
      });
      if (existing.rows.length === 0) needCreate.push(val);
    }

    if (needCreate.length === 0 && !input.negate?.length) {
      return { labels: [] } satisfies { labels: SavedLabel[] };
    }
    const labels = await labeler.createLabels(input.subject, {
      create: needCreate.length ? needCreate : undefined,
      negate: input.negate,
    });
    return { labels } satisfies { labels: SavedLabel[] };
  });

  app.post(routes.queryLabels.path, async (req, reply) => {
    const input = routes.queryLabels.input.parse(req.body);
    const built = buildQueryLabelsSql(input);
    if ("error" in built) {
      return reply.code(400).send({ error: built.error });
    }
    const result = await labeler.db.execute(built);

    const labels: SavedLabel[] = result.rows.map((row) => ({
      id: Number(row.id),
      src: String(row.src),
      uri: String(row.uri),
      val: String(row.val),
      cts: String(row.cts),
      ...(row.cid ? { cid: String(row.cid) } : {}),
      ...(row.exp ? { exp: String(row.exp) } : {}),
      ...(row.neg != null ? { neg: Boolean(row.neg) } : {}),
    }));
    return { labels };
  });

  app.post(routes.upsertLabel.path, async (req) => {
    const { subject, val, expiresInMs } = routes.upsertLabel.input.parse(req.body);
    return withUpsertLock(`${subject.uri}\0${val}`, async () => {
      const nowMs = Date.now();

      const existing = await labeler.db.execute({
        sql: `SELECT id, neg, exp FROM labels
              WHERE src = ? AND uri = ? AND val = ?
              ORDER BY id DESC LIMIT 1`,
        args: [labeler.did, subject.uri, val],
      });
      const latest = existing.rows[0];
      const emitted: SavedLabel[] = [];

      const isActive =
        latest &&
        !Number(latest.neg) &&
        (!latest.exp || Date.parse(String(latest.exp)) > nowMs);
      if (isActive) {
        const neg = await labeler.createLabel({
          uri: subject.uri,
          cid: subject.cid,
          val,
          neg: true,
        });
        emitted.push(neg as SavedLabel);
      }

      const created = await labeler.createLabel({
        uri: subject.uri,
        cid: subject.cid,
        val,
        exp: new Date(nowMs + expiresInMs).toISOString(),
      });
      emitted.push(created as SavedLabel);
      return { labels: emitted };
    });
  });

  return app;
}
