import type { LabelerServer } from "@skyware/labeler";
import { dashboardHtml } from "./dashboard-html.ts";

interface LabelRow {
  id: number;
  src: string;
  uri: string;
  val: string;
  neg: number | null;
  cts: string;
  exp: string | null;
  cid: string | null;
}

interface PostEntry {
  uri: string;
  cid: string | null;
  labelledAt: string;
}

interface AccountEntry {
  did: string;
  labelledAt: string;
  expiresAt: string | null;
  posts: PostEntry[];
}

const ACCOUNT_LABEL = "doesnt-know-how-replyrefs-work";
const POST_LABEL = "fucked-up-replyref";

export function registerDashboardRoutes(server: LabelerServer) {
  const app = server.app;

  app.get("/dashboard", async (_req, reply) => {
    reply.type("text/html; charset=utf-8").send(dashboardHtml);
  });

  app.get("/dashboard/data", async () => {
    const nowIso = new Date().toISOString();
    const result = await server.db.execute({
      sql: `
        WITH latest AS (
          SELECT MAX(id) AS id
          FROM labels
          WHERE val IN (?, ?)
          GROUP BY src, uri, val
        )
        SELECT l.id, l.src, l.uri, l.val, l.neg, l.cts, l.exp, l.cid
        FROM labels l
        JOIN latest ON latest.id = l.id
        WHERE (l.neg IS NULL OR l.neg = 0)
          AND (l.exp IS NULL OR l.exp > ?)
        ORDER BY l.cts DESC
        LIMIT 500
      `,
      args: [ACCOUNT_LABEL, POST_LABEL, nowIso],
    });

    const rows = result.rows as unknown as LabelRow[];

    const accountByDid = new Map<string, AccountEntry>();
    for (const row of rows) {
      if (row.val !== ACCOUNT_LABEL) continue;
      accountByDid.set(row.uri, {
        did: row.uri,
        labelledAt: row.cts,
        expiresAt: row.exp ?? null,
        posts: [],
      });
    }

    for (const row of rows) {
      if (row.val !== POST_LABEL) continue;
      const match = row.uri.match(/^at:\/\/([^/]+)\//);
      const did = match?.[1];
      if (!did) continue;
      const account = accountByDid.get(did);
      if (!account) continue;
      account.posts.push({
        uri: row.uri,
        cid: row.cid ?? null,
        labelledAt: row.cts,
      });
    }

    const accounts = [...accountByDid.values()].sort((a, b) =>
      a.labelledAt < b.labelledAt ? 1 : -1,
    );
    return { accounts };
  });
}
