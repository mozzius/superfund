interface PostLookup {
  getClaimedRoot(uri: string): Promise<string | null>;
}

export function claimedRoot(uri: string, record: { reply?: { root: { uri: string } } }): string {
  return record.reply ? record.reply.root.uri : uri;
}

export async function isFuckedUpReply(
  record: { reply?: { parent: { uri: string }; root: { uri: string } } },
  posts: PostLookup,
): Promise<boolean> {
  if (!record.reply) return false;
  const parentClaimedRoot = await posts.getClaimedRoot(record.reply.parent.uri);
  if (!parentClaimedRoot) return false;
  return parentClaimedRoot !== record.reply.root.uri;
}
