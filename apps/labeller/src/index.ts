import { LabelerServer } from "@skyware/labeler";
import { createInternalServer } from "./internal.ts";
import { registerDashboardRoutes } from "./dashboard.ts";

const did = process.env.LABELER_DID;
const signingKey = process.env.SIGNING_KEY;
const internalApiKey = process.env.INTERNAL_API_KEY;
if (!did || !signingKey) {
  throw new Error("LABELER_DID and SIGNING_KEY must be set");
}
if (!internalApiKey) {
  throw new Error("INTERNAL_API_KEY must be set");
}

const volumePath = process.env.RAILWAY_VOLUME_MOUNT_PATH;
const dbPath = volumePath ? `${volumePath}/labels.db` : "./labels.db";
const publicPort = Number(process.env.PORT ?? 14831);
const internalPort = Number(process.env.INTERNAL_PORT ?? 14832);

/**
 * Has the following labels configured:
 *
 * ID: `fucked-up-replyref`
 * Name: Fucked up replyRef
 * Description: This post has a fucked up replyRef
 * Type: Posts
 * Severity: Informational
 *
 * ID: `doesnt-know-how-replyrefs-work`
 * Name: Has posts with fucked up replyRefs
 * Description: Has posted a fucked-up replyRef within the last 30 days
 * Type: Posts
 * Severity: Informational
 */

const labeler = new LabelerServer({ did, signingKey, dbPath });
registerDashboardRoutes(labeler);

labeler.app.ready((err) => {
  if (err) {
    console.error("[boot] labeler.app.ready rejected", err);
  } else {
    console.log("[boot] labeler.app.ready resolved");
  }
});

labeler.start({ port: publicPort, host: "::" }, (error, address) => {
  if (error) {
    console.error("labeller public server failed to start", error);
    process.exit(1);
  }
  console.log(`labeller public listening on ${address}`);
});

const internal = createInternalServer(labeler, internalApiKey);
internal.listen({ port: internalPort, host: "::" }, (error, address) => {
  if (error) {
    console.error("labeller internal server failed to start", error);
    process.exit(1);
  }
  console.log(`labeller internal listening on ${address}`);
});

const fmtMB = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)}MB`;
const heartbeat = setInterval(async () => {
  const mem = process.memoryUsage();
  const connections = (labeler as unknown as {
    connections: Map<string, Set<unknown>>;
  }).connections;
  const subs = connections.get("com.atproto.label.subscribeLabels")?.size ?? 0;
  let maxLabelId = 0;
  let labelCount = 0;
  try {
    const row = await labeler.db.execute({
      sql: "SELECT MAX(id) AS maxId, COUNT(*) AS total FROM labels",
      args: [],
    });
    maxLabelId = Number(row.rows[0]?.maxId ?? 0);
    labelCount = Number(row.rows[0]?.total ?? 0);
  } catch (err) {
    console.error("[heartbeat] db query failed", err);
  }
  console.log(
    `[heartbeat] rss=${fmtMB(mem.rss)} heapUsed=${fmtMB(mem.heapUsed)}/` +
      `${fmtMB(mem.heapTotal)} ext=${fmtMB(mem.external)} subs=${subs} ` +
      `labels=${labelCount} maxId=${maxLabelId} ` +
      `uptimeSec=${Math.round(process.uptime())}`,
  );
}, 30_000);
heartbeat.unref();

process.on("uncaughtException", (err) => {
  console.error("[fatal] uncaughtException", err);
});
process.on("unhandledRejection", (reason) => {
  console.error("[fatal] unhandledRejection", reason);
});
