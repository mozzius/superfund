import { createClient } from "redis";

export async function createRedis(url: string) {
  const client = createClient({ url });
  client.on("error", (err) => console.error("redis error", err));

  // Retry the initial connect — redis v5 auto-reconnects after the first
  // successful connection, but if Redis isn't up yet at boot we'd crash
  // instead of waiting.
  const MAX_CONNECT_ATTEMPTS = 10;
  const CONNECT_BACKOFF_MS = 2000;
  for (let attempt = 1; ; attempt++) {
    try {
      await client.connect();
      break;
    } catch (err) {
      if (attempt >= MAX_CONNECT_ATTEMPTS) throw err;
      console.warn(
        `[redis] connect attempt ${attempt}/${MAX_CONNECT_ATTEMPTS} failed, retrying in ${CONNECT_BACKOFF_MS}ms`,
        err,
      );
      await new Promise((r) => setTimeout(r, CONNECT_BACKOFF_MS));
    }
  }
  return client;
}

export type Redis = Awaited<ReturnType<typeof createRedis>>;
