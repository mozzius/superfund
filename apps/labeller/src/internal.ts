import type { LabelerServer } from "@skyware/labeler";
import { ZodError } from "zod";
import { routes, type SavedLabel } from "labeller-client";

export async function registerInternalRoutes(server: LabelerServer, apiKey: string) {
  // Skyware registers its own routes in a deferred microtask (see LabelerServer.js
  // `this.app.register(fastifyWebsocket).then(() => { ... })`). If we mutate the
  // Fastify instance synchronously, `app.listen` silently never binds. Yielding
  // once lets skyware finish its own setup before we add ours.
  await new Promise<void>((resolve) => setImmediate(resolve));
  const app = server.app;

  app.addHook("preHandler", async (req, reply) => {
    if (!req.url.startsWith("/internal/")) return;
    if (req.headers.authorization !== `Bearer ${apiKey}`) {
      console.warn(`[internal] 401 ${req.method} ${req.url}`);
      reply.code(401).send({ error: "unauthorized" });
      return;
    }
    console.log(`[internal] ${req.method} ${req.url}`);
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
    const labels = await server.createLabels(input.subject, {
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
    const result = await server.db.execute({
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

  app.post(routes.upsertLabel.path, async (req) => {
    const { subject, val, expiresInMs } = routes.upsertLabel.input.parse(req.body);
    const nowMs = Date.now();

    const existing = await server.db.execute({
      sql: `SELECT id, neg, exp FROM labels
              WHERE src = ? AND uri = ? AND val = ?
              ORDER BY id DESC LIMIT 1`,
      args: [server.did, subject.uri, val],
    });
    const latest = existing.rows[0];
    const emitted: SavedLabel[] = [];

    const isActive =
      latest &&
      !Number(latest.neg) &&
      (!latest.exp || Date.parse(String(latest.exp)) > nowMs);
    if (isActive) {
      const neg = await server.createLabel({
        uri: subject.uri,
        cid: subject.cid,
        val,
        neg: true,
      });
      emitted.push(neg as SavedLabel);
    }

    const created = await server.createLabel({
      uri: subject.uri,
      cid: subject.cid,
      val,
      exp: new Date(nowMs + expiresInMs).toISOString(),
    });
    emitted.push(created as SavedLabel);
    return { labels: emitted };
  });
}
