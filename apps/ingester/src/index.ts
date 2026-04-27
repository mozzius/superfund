import { Jetstream } from "@skyware/jetstream";
import { createLabellerClient } from "labeller-client";
import { createRedis } from "./redis.ts";
import { classifyRecord, isFuckedUpReply } from "./classify.ts";
import { createCursorStore } from "./cursor.ts";

const labellerUrl = process.env.LABELLER_URL;
const internalApiKey = process.env.INTERNAL_API_KEY;
const redisUrl = process.env.REDIS_URL;
if (!labellerUrl || !internalApiKey || !redisUrl) {
  throw new Error("LABELLER_URL, INTERNAL_API_KEY, and REDIS_URL must be set");
}

const postCacheTtlSeconds = Number(process.env.POST_CACHE_TTL_DAYS ?? 7) * 86_400;
const accountLabelMs = 30 * 86_400 * 1000;

const labeller = createLabellerClient({ url: labellerUrl, apiKey: internalApiKey });
const redis = await createRedis(redisUrl);
const cursor = createCursorStore(redis);

const stats = { posts: 0, roots: 0, replies: 0, matched: 0, labelled: 0, errors: 0 };
const heartbeat = setInterval(() => {
  console.log(
    `[stats] posts=${stats.posts} roots=${stats.roots} replies=${stats.replies} ` +
      `matched=${stats.matched} labelled=${stats.labelled} errors=${stats.errors}`,
  );
}, 10_000);
heartbeat.unref();

async function connect() {
  const jetstream = new Jetstream({
    wantedCollections: ["app.bsky.feed.post"],
    endpoint: process.env.JETSTREAM_ENDPOINT,
    cursor: await cursor.load(),
  });

  jetstream.onCreate("app.bsky.feed.post", async (event) => {
    cursor.update(event.time_us);
    const did = event.did;
    const uri = `at://${did}/app.bsky.feed.post/${event.commit.rkey}`;
    const record = event.commit.record;
    const shape = classifyRecord(record);
    stats.posts++;
    if (shape === "R") stats.roots++;
    else stats.replies++;

    try {
      await redis.set(`post:${uri}`, shape, { EX: postCacheTtlSeconds });

      if (await isFuckedUpReply(record, redis)) {
        stats.matched++;
        console.log(`[match] fucked-up-replyref uri=${uri} did=${did}`);
        await Promise.all([
          labeller.createLabels({
            subject: { uri, cid: event.commit.cid },
            create: ["fucked-up-replyref"],
          }),
          labeller.upsertLabel({
            subject: { uri: did },
            val: "doesnt-know-how-replyrefs-work",
            expiresInMs: accountLabelMs,
          }),
        ]);
        stats.labelled++;
        console.log(`[labelled] ${uri}`);
      }
    } catch (err) {
      stats.errors++;
      console.error(`failed to process ${uri}`, err);
    }
  });

  jetstream.on("open", () => console.log("jetstream connected"));
  jetstream.on("close", () => {
    console.warn("jetstream closed, reconnecting in 3s");
    setTimeout(() => void connect(), 3000);
  });
  jetstream.on("error", (err) => console.error("jetstream error", err));

  jetstream.start();
}

const shutdown = async () => {
  await cursor.flush();
  await redis.quit();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

await connect();
