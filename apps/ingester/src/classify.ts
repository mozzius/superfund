interface PostLookup {
  getClaimedRoot(uri: string): Promise<string | null>;
}

interface PostRecord {
  reply?: {
    parent?: { uri?: unknown };
    root?: { uri?: unknown };
  } | null;
}

export function claimedRoot(uri: string, record: PostRecord): string | undefined {
  if (!record.reply) return uri;
  return validUri(record.reply.root?.uri);
}

export async function isFuckedUpReply(
  record: PostRecord,
  posts: PostLookup,
): Promise<boolean> {
  if (!record.reply) return false;
  const parentUri = validUri(record.reply.parent?.uri);
  const rootUri = validUri(record.reply.root?.uri);
  if (!parentUri || !rootUri) return false;

  const parentClaimedRoot = await posts.getClaimedRoot(parentUri);
  if (!parentClaimedRoot) return false;
  return parentClaimedRoot !== rootUri;
}

function validUri(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
