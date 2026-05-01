interface RedisGetter {
  get(key: string): Promise<string | null>;
}

export function claimedRoot(uri: string, record: { reply?: { root: { uri: string } } }): string {
  return record.reply ? record.reply.root.uri : uri;
}

export async function isFuckedUpReply(
  record: { reply?: { parent: { uri: string }; root: { uri: string } } },
  redis: RedisGetter,
): Promise<boolean> {
  if (!record.reply) return false;
  const parentClaimedRoot = await redis.get(`post:${record.reply.parent.uri}`);
  if (!parentClaimedRoot) return false;
  return parentClaimedRoot !== record.reply.root.uri;
}
