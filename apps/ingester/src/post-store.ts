import { mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface PostStoreOptions {
  dbPath: string;
  ttlMs: number;
  legacyGetClaimedRoot?: (uri: string) => Promise<string | null>;
  flushIntervalMs?: number;
  cleanupIntervalMs?: number;
  now?: () => number;
}

interface PendingPost {
  claimedRoot: string;
  expiresAtMs: number;
}

interface ClaimedRootRow {
  claimed_root: string | null;
}

interface MetadataRow {
  value: string;
}

const CURSOR_KEY = "jetstream_cursor";
const DEFAULT_FLUSH_INTERVAL_MS = 1_000;
const DEFAULT_CLEANUP_INTERVAL_MS = 60_000;
const MAX_PENDING_POSTS = 1_000;

export class PostStore {
  readonly #db: DatabaseSync;
  readonly #ttlMs: number;
  readonly #legacyGetClaimedRoot?: (uri: string) => Promise<string | null>;
  readonly #now: () => number;
  readonly #pendingPosts = new Map<string, PendingPost>();
  readonly #selectPost;
  readonly #upsertPost;
  readonly #selectMetadata;
  readonly #upsertMetadata;
  readonly #deleteExpired;
  readonly #flushInterval?: NodeJS.Timeout;
  readonly #cleanupInterval?: NodeJS.Timeout;
  #latestCursor: number | undefined;
  #flushedCursor: number | undefined;
  #closed = false;

  constructor(options: PostStoreOptions) {
    const {
      dbPath,
      ttlMs,
      legacyGetClaimedRoot,
      flushIntervalMs = DEFAULT_FLUSH_INTERVAL_MS,
      cleanupIntervalMs = DEFAULT_CLEANUP_INTERVAL_MS,
      now = Date.now,
    } = options;
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
      throw new Error("post store TTL must be a positive number");
    }

    if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
    this.#db = new DatabaseSync(dbPath, { timeout: 5_000 });
    this.#ttlMs = ttlMs;
    this.#legacyGetClaimedRoot = legacyGetClaimedRoot;
    this.#now = now;

    this.#db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA temp_store = MEMORY;
      PRAGMA wal_autocheckpoint = 1000;

      CREATE TABLE IF NOT EXISTS posts (
        uri_hash BLOB PRIMARY KEY,
        claimed_root TEXT,
        expires_at_ms INTEGER NOT NULL
      ) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS posts_by_expiry ON posts (expires_at_ms);

      CREATE TABLE IF NOT EXISTS metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) WITHOUT ROWID;
    `);

    this.#selectPost = this.#db.prepare(
      "SELECT claimed_root FROM posts WHERE uri_hash = ? AND expires_at_ms > ?",
    );
    this.#upsertPost = this.#db.prepare(`
      INSERT INTO posts (uri_hash, claimed_root, expires_at_ms) VALUES (?, ?, ?)
      ON CONFLICT (uri_hash) DO UPDATE SET
        claimed_root = excluded.claimed_root,
        expires_at_ms = excluded.expires_at_ms
    `);
    this.#selectMetadata = this.#db.prepare("SELECT value FROM metadata WHERE key = ?");
    this.#upsertMetadata = this.#db.prepare(`
      INSERT INTO metadata (key, value) VALUES (?, ?)
      ON CONFLICT (key) DO UPDATE SET value = excluded.value
    `);
    this.#deleteExpired = this.#db.prepare("DELETE FROM posts WHERE expires_at_ms <= ?");

    this.#latestCursor = this.#readCursor();
    this.#flushedCursor = this.#latestCursor;

    if (flushIntervalMs > 0) {
      this.#flushInterval = setInterval(() => {
        try {
          this.flush();
        } catch (err) {
          console.error("post store flush failed", err);
        }
      }, flushIntervalMs);
      this.#flushInterval.unref();
    }
    if (cleanupIntervalMs > 0) {
      this.#cleanupInterval = setInterval(() => {
        try {
          this.cleanupExpired();
        } catch (err) {
          console.error("post store cleanup failed", err);
        }
      }, cleanupIntervalMs);
      this.#cleanupInterval.unref();
    }
  }

  setPost(uri: string, claimedRoot: string): void {
    this.#assertOpen();
    this.#pendingPosts.set(uri, {
      claimedRoot,
      expiresAtMs: this.#now() + this.#ttlMs,
    });
    if (this.#pendingPosts.size >= MAX_PENDING_POSTS) this.flush();
  }

  async getClaimedRoot(uri: string): Promise<string | null> {
    this.#assertOpen();
    const pending = this.#pendingPosts.get(uri);
    if (pending && pending.expiresAtMs > this.#now()) return pending.claimedRoot;

    const row = this.#selectPost.get(hashUri(uri), this.#now()) as
      | ClaimedRootRow
      | undefined;
    if (row) return row.claimed_root ?? uri;

    const legacy = await this.#legacyGetClaimedRoot?.(uri);
    if (legacy != null) this.setPost(uri, legacy);
    return legacy ?? null;
  }

  loadCursor(): number | undefined {
    this.#assertOpen();
    return this.#latestCursor;
  }

  updateCursor(cursor: number): void {
    this.#assertOpen();
    if (!Number.isFinite(cursor)) return;
    this.#latestCursor = Math.max(this.#latestCursor ?? cursor, cursor);
  }

  flush(): void {
    this.#assertOpen();
    if (
      this.#pendingPosts.size === 0 &&
      this.#latestCursor === this.#flushedCursor
    ) {
      return;
    }

    const posts = [...this.#pendingPosts];
    const cursor = this.#latestCursor;
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      for (const [uri, post] of posts) {
        this.#upsertPost.run(
          hashUri(uri),
          post.claimedRoot === uri ? null : post.claimedRoot,
          post.expiresAtMs,
        );
      }
      if (cursor !== undefined && cursor !== this.#flushedCursor) {
        this.#upsertMetadata.run(CURSOR_KEY, String(cursor));
      }
      this.#db.exec("COMMIT");
    } catch (err) {
      this.#db.exec("ROLLBACK");
      throw err;
    }

    for (const [uri, post] of posts) {
      if (this.#pendingPosts.get(uri) === post) this.#pendingPosts.delete(uri);
    }
    this.#flushedCursor = cursor;
  }

  cleanupExpired(): number {
    this.#assertOpen();
    return Number(this.#deleteExpired.run(this.#now()).changes);
  }

  close(): void {
    if (this.#closed) return;
    if (this.#flushInterval) clearInterval(this.#flushInterval);
    if (this.#cleanupInterval) clearInterval(this.#cleanupInterval);
    this.flush();
    this.#closed = true;
    this.#db.close();
  }

  #readCursor(): number | undefined {
    const row = this.#selectMetadata.get(CURSOR_KEY) as MetadataRow | undefined;
    if (!row) return undefined;
    const cursor = Number(row.value);
    return Number.isFinite(cursor) ? cursor : undefined;
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("post store is closed");
  }
}

export function createPostStore(options: PostStoreOptions): PostStore {
  return new PostStore(options);
}

function hashUri(uri: string): Buffer {
  return createHash("sha256").update(uri).digest();
}
