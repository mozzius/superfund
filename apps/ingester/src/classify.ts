export type PostShape = "R" | "r";

interface RedisGetter {
  get(key: string): Promise<string | null>;
}

export function classifyRecord(record: { reply?: unknown }): PostShape {
  return record.reply ? "r" : "R";
}

export async function isFuckedUpReply(
  record: { reply?: { root: { uri: string } } },
  redis: RedisGetter,
): Promise<boolean> {
  if (!record.reply) return false;
  const rootShape = await redis.get(`post:${record.reply.root.uri}`);
  return rootShape === "r";
}
