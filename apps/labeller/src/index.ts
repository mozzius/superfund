import { LabelerServer } from "@skyware/labeler";
import { createInternalServer } from "./internal.ts";

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

// Skyware registers fastifyWebsocket in a deferred microtask and only
// wires up /xrpc/com.atproto.label.subscribeLabels after that promise
// settles. If we call start() synchronously, listen() races the WS route
// registration and subscribeLabels never binds. Yield once to let
// skyware finish setting itself up.
await new Promise<void>((resolve) => setImmediate(resolve));

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
