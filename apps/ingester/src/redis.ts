import { createClient } from "redis";

export async function createRedis(url: string) {
  const client = createClient({ url });
  client.on("error", (err) => console.error("redis error", err));
  await client.connect();
  return client;
}

export type Redis = Awaited<ReturnType<typeof createRedis>>;
