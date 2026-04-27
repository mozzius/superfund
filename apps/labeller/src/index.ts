import { LabelerServer } from "@skyware/labeler";
import { registerInternalRoutes } from "./internal.ts";

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
const port = Number(process.env.PORT ?? 14831);

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

const server = new LabelerServer({ did, signingKey, dbPath });
await registerInternalRoutes(server, internalApiKey);
server.start({ port, host: "::" }, (error, address) => {
  if (error) {
    console.error("labeller failed to start", error);
    process.exit(1);
  }
  console.log(`labeller listening on ${address}`);
});
