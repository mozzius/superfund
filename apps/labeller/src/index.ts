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
if (!/^did:[a-z]+:[a-zA-Z0-9._:%-]+$/.test(did)) {
  throw new Error(`LABELER_DID does not look like a valid DID: ${did}`);
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

// Skyware's constructor schedules fastifyWebsocket + its own routes in a
// `void register(...).then(...)` microtask, outside fastify's boot tracking.
// Adding our routes to labeler.app synchronously after construction slots them
// ahead of skyware's .then() in the boot queue in a way that deadlocks ready()
// — listen() then never binds, with no error surfaced. Yielding a macrotask
// first lets skyware's microtask flush so our routes land in a settled queue.
await new Promise<void>((resolve) => setImmediate(resolve));

registerDashboardRoutes(labeler);

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
const HEARTBEAT_INTERVAL_MS = 30_000;
let lastHeartbeatAt = Date.now();

const heartbeat = setInterval(async () => {
  lastHeartbeatAt = Date.now();
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
}, HEARTBEAT_INTERVAL_MS);
heartbeat.unref();

// Watchdog: if the heartbeat hasn't run in ~3 intervals the event loop is
// likely stalled. Exit so Railway restarts us. Uses an unrefed interval at a
// different cadence so a single missed tick doesn't fire it.
const WATCHDOG_STALL_MS = HEARTBEAT_INTERVAL_MS * 3;
const watchdog = setInterval(() => {
  const sinceMs = Date.now() - lastHeartbeatAt;
  if (sinceMs > WATCHDOG_STALL_MS) {
    console.error(
      `[watchdog] heartbeat stalled for ${Math.round(sinceMs / 1000)}s — exiting`,
    );
    process.exit(1);
  }
}, HEARTBEAT_INTERVAL_MS);
watchdog.unref();

process.on("uncaughtException", (err) => {
  console.error("[fatal] uncaughtException", err);
});
process.on("unhandledRejection", (reason) => {
  console.error("[fatal] unhandledRejection", reason);
});

let shuttingDown = false;
const shutdown = async (signal: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[shutdown] ${signal} — closing listeners`);
  clearInterval(heartbeat);

  const closeTimeout = 10_000;
  const withTimeout = <T>(label: string, p: Promise<T>) =>
    Promise.race([
      p.then(() => console.log(`[shutdown] ${label} closed`)),
      new Promise<void>((resolve) =>
        setTimeout(() => {
          console.warn(`[shutdown] ${label} close timed out after ${closeTimeout}ms`);
          resolve();
        }, closeTimeout),
      ),
    ]);

  await Promise.all([
    withTimeout("public", labeler.app.close()),
    withTimeout("internal", internal.close()),
  ]);
  try {
    labeler.db.close();
    console.log("[shutdown] db closed");
  } catch (err) {
    console.warn("[shutdown] db close failed", err);
  }
  console.log("[shutdown] bye");
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
