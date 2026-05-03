import type { LabelerServer } from "@skyware/labeler";
import Fastify, { type FastifyInstance } from "fastify";
import { z, ZodError } from "zod";
import { routes, type SavedLabel } from "labeller-client";

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
    const labels = await labeler.createLabels(input.subject, {
      create: input.create,
      negate: input.negate,
    });
    return { labels } satisfies { labels: SavedLabel[] };
  });

  app.post(routes.queryLabels.path, async (req, reply) => {
    const input = routes.queryLabels.input.parse(req.body);
    const { uriPatterns, sources } = input;

    const patterns: string[] = [];
    const matchAll = uriPatterns.includes("*");
    if (!matchAll) {
      for (const raw of uriPatterns) {
        const cleaned = raw.replaceAll("%", "").replaceAll("_", "\\_");
        const star = cleaned.indexOf("*");
        if (star !== -1 && star !== cleaned.length - 1) {
          return reply.code(400).send({
            error: "only trailing wildcards are supported in uriPatterns",
          });
        }
        patterns.push(star === -1 ? cleaned : cleaned.slice(0, -1) + "%");
      }
    }

    const conditions: string[] = [];
    const args: (string | number)[] = [];
    if (patterns.length) {
      conditions.push("(" + patterns.map(() => "uri LIKE ?").join(" OR ") + ")");
      args.push(...patterns);
    }
    if (sources?.length) {
      conditions.push(`src IN (${sources.map(() => "?").join(", ")})`);
      args.push(...sources);
    }
    const whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const result = await labeler.db.execute({
      sql: `SELECT * FROM labels ${whereClause} ORDER BY id ASC LIMIT 250`,
      args,
    });

    const labels: SavedLabel[] = result.rows.map((row) => ({
      id: Number(row.id),
      src: String(row.src),
      uri: String(row.uri),
      val: String(row.val),
      neg: Boolean(row.neg),
      cts: String(row.cts),
      ...(row.cid ? { cid: String(row.cid) } : {}),
      ...(row.exp ? { exp: String(row.exp) } : {}),
    }));
    return { labels };
  });

  // One-off recovery endpoint for wiping out a run of bad labels. Takes a val,
  // finds every (uri, val) pair whose latest row is still active, and negates
  // each. Returns quickly; negations run in the background. Idempotent on
  // re-run. Delete once used.
  const recoveryState: {
    running: boolean;
    val: string | null;
    scanned: number;
    negated: number;
    startedAt: number | null;
    finishedAt: number | null;
    error: string | null;
  } = {
    running: false,
    val: null,
    scanned: 0,
    negated: 0,
    startedAt: null,
    finishedAt: null,
    error: null,
  };

  app.post("/negate-all-by-val", async (req) => {
    const { val } = z.object({ val: z.string().min(1) }).parse(req.body);
    if (recoveryState.running) {
      return { status: "already-running", state: recoveryState };
    }
    recoveryState.running = true;
    recoveryState.val = val;
    recoveryState.scanned = 0;
    recoveryState.negated = 0;
    recoveryState.startedAt = Date.now();
    recoveryState.finishedAt = null;
    recoveryState.error = null;

    void (async () => {
      try {
        const nowIso = new Date().toISOString();
        // Efficient: group rows by (src, uri, val) once, pick MAX(id), then
        // join back on id for the active check. Single scan of the labels
        // table, no correlated subquery.
        const candidates = await labeler.db.execute({
          sql: `
            WITH latest AS (
              SELECT MAX(id) AS id
              FROM labels
              WHERE src = ? AND val = ?
              GROUP BY uri
            )
            SELECT l.uri, l.cid
            FROM labels l
            JOIN latest ON latest.id = l.id
            WHERE (l.neg IS NULL OR l.neg = 0)
              AND (l.exp IS NULL OR l.exp > ?)
          `,
          args: [labeler.did, val, nowIso],
        });
        recoveryState.scanned = candidates.rows.length;
        console.log(`[recover] val=${val} candidates=${candidates.rows.length}`);
        for (const row of candidates.rows) {
          await labeler.createLabel({
            uri: String(row.uri),
            cid: row.cid ? String(row.cid) : undefined,
            val,
            neg: true,
          });
          recoveryState.negated++;
          if (recoveryState.negated % 1000 === 0) {
            console.log(`[recover] val=${val} negated=${recoveryState.negated}/${recoveryState.scanned}`);
          }
        }
      } catch (err) {
        recoveryState.error = err instanceof Error ? err.message : String(err);
        console.error(`[recover] val=${val} failed`, err);
      } finally {
        recoveryState.running = false;
        recoveryState.finishedAt = Date.now();
        console.log(
          `[recover] done val=${val} scanned=${recoveryState.scanned} ` +
            `negated=${recoveryState.negated} error=${recoveryState.error ?? "none"}`,
        );
      }
    })();

    return { status: "started", val };
  });

  app.get("/negate-all-by-val/status", async () => recoveryState);

  app.post(routes.upsertLabel.path, async (req) => {
    const { subject, val, expiresInMs } = routes.upsertLabel.input.parse(req.body);
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

  return app;
}
