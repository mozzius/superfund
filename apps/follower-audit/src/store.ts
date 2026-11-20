import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * Account status as we know it. "active" means the AppView returned a profile
 * or the relay said active; anything else is the relay's status string
 * (takendown, suspended, deleted, deactivated, ...), or "not-found" if the
 * relay has never heard of the DID.
 */
export type AccountStatus = string;

export interface Evaluation {
  did: string;
  evaluatedAtMs: number;
  followers: number;
  counted: number;
  takendown: number;
  bucket: number;
}

export interface AuditStoreOptions {
  dbPath: string;
  /** How long a cached "active" status is trusted. */
  activeTtlMs: number;
  /** How long a cached non-active status is trusted. */
  inactiveTtlMs: number;
  /** Evaluations older than this are forgotten (their label has expired by then). */
  evaluationTtlMs: number;
  maxQueue: number;
  now?: () => number;
}

const CURSOR_KEY = "jetstream_cursor";

export class AuditStore {
  readonly #db: DatabaseSync;
  readonly #opts: AuditStoreOptions;
  readonly #now: () => number;
  #queueSize: number;
  #closed = false;

  readonly #selectStatus;
  readonly #upsertStatus;
  readonly #updateStatusIfKnown;
  readonly #selectEvaluation;
  readonly #upsertEvaluation;
  readonly #selectQueued;
  readonly #insertQueue;
  readonly #popQueue;
  readonly #selectMetadata;
  readonly #upsertMetadata;

  constructor(opts: AuditStoreOptions) {
    this.#opts = opts;
    this.#now = opts.now ?? Date.now;
    if (opts.dbPath !== ":memory:") mkdirSync(dirname(opts.dbPath), { recursive: true });
    this.#db = new DatabaseSync(opts.dbPath, { timeout: 5_000 });
    this.#db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA temp_store = MEMORY;

      CREATE TABLE IF NOT EXISTS account_status (
        did TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        checked_at_ms INTEGER NOT NULL
      ) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS account_status_by_checked ON account_status (checked_at_ms);

      CREATE TABLE IF NOT EXISTS evaluations (
        did TEXT PRIMARY KEY,
        evaluated_at_ms INTEGER NOT NULL,
        followers INTEGER NOT NULL,
        counted INTEGER NOT NULL,
        takendown INTEGER NOT NULL,
        bucket INTEGER NOT NULL
      ) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS evaluations_by_time ON evaluations (evaluated_at_ms);

      CREATE TABLE IF NOT EXISTS queue (
        did TEXT PRIMARY KEY,
        enqueued_at_ms INTEGER NOT NULL
      ) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS queue_by_time ON queue (enqueued_at_ms);

      CREATE TABLE IF NOT EXISTS metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) WITHOUT ROWID;
    `);

    this.#selectStatus = this.#db.prepare(
      "SELECT status, checked_at_ms FROM account_status WHERE did = ?",
    );
    this.#upsertStatus = this.#db.prepare(`
      INSERT INTO account_status (did, status, checked_at_ms) VALUES (?, ?, ?)
      ON CONFLICT (did) DO UPDATE SET status = excluded.status, checked_at_ms = excluded.checked_at_ms
    `);
    this.#updateStatusIfKnown = this.#db.prepare(
      "UPDATE account_status SET status = ?, checked_at_ms = ? WHERE did = ?",
    );
    this.#selectEvaluation = this.#db.prepare(
      "SELECT * FROM evaluations WHERE did = ? AND evaluated_at_ms > ?",
    );
    this.#upsertEvaluation = this.#db.prepare(`
      INSERT INTO evaluations (did, evaluated_at_ms, followers, counted, takendown, bucket)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (did) DO UPDATE SET
        evaluated_at_ms = excluded.evaluated_at_ms,
        followers = excluded.followers,
        counted = excluded.counted,
        takendown = excluded.takendown,
        bucket = excluded.bucket
    `);
    this.#selectQueued = this.#db.prepare("SELECT 1 FROM queue WHERE did = ?");
    this.#insertQueue = this.#db.prepare(
      "INSERT OR IGNORE INTO queue (did, enqueued_at_ms) VALUES (?, ?)",
    );
    this.#popQueue = this.#db.prepare(
      "DELETE FROM queue WHERE did = (SELECT did FROM queue ORDER BY enqueued_at_ms LIMIT 1) RETURNING did",
    );
    this.#selectMetadata = this.#db.prepare("SELECT value FROM metadata WHERE key = ?");
    this.#upsertMetadata = this.#db.prepare(`
      INSERT INTO metadata (key, value) VALUES (?, ?)
      ON CONFLICT (key) DO UPDATE SET value = excluded.value
    `);

    const row = this.#db.prepare("SELECT COUNT(*) AS n FROM queue").get() as { n: number };
    this.#queueSize = Number(row.n);
  }

  /** Cached statuses that are still fresh. DIDs missing from the result need looking up. */
  getStatuses(dids: Iterable<string>): Map<string, AccountStatus> {
    const now = this.#now();
    const out = new Map<string, AccountStatus>();
    for (const did of dids) {
      const row = this.#selectStatus.get(did) as
        | { status: string; checked_at_ms: number }
        | undefined;
      if (!row) continue;
      const ttl = row.status === "active" ? this.#opts.activeTtlMs : this.#opts.inactiveTtlMs;
      if (row.checked_at_ms + ttl > now) out.set(did, row.status);
    }
    return out;
  }

  setStatuses(entries: Iterable<[string, AccountStatus]>): void {
    const now = this.#now();
    this.#transaction(() => {
      for (const [did, status] of entries) this.#upsertStatus.run(did, status, now);
    });
  }

  /**
   * Apply a firehose #account event. Non-active statuses are always recorded
   * (they're the interesting ones); reactivations only touch DIDs we already
   * have, so the cache doesn't fill up with every account that logs in.
   */
  applyAccountEvent(did: string, active: boolean, status: string | undefined): void {
    const now = this.#now();
    if (active) this.#updateStatusIfKnown.run("active", now, did);
    else this.#upsertStatus.run(did, status ?? "inactive", now);
  }

  getEvaluation(did: string): Evaluation | undefined {
    const row = this.#selectEvaluation.get(did, this.#now() - this.#opts.evaluationTtlMs) as
      | Record<string, number | string>
      | undefined;
    if (!row) return undefined;
    return {
      did: String(row.did),
      evaluatedAtMs: Number(row.evaluated_at_ms),
      followers: Number(row.followers),
      counted: Number(row.counted),
      takendown: Number(row.takendown),
      bucket: Number(row.bucket),
    };
  }

  saveEvaluation(e: Omit<Evaluation, "evaluatedAtMs">): void {
    this.#upsertEvaluation.run(e.did, this.#now(), e.followers, e.counted, e.takendown, e.bucket);
  }

  /**
   * Queue `did` for evaluation unless it was evaluated within `reevaluateMs`,
   * is already queued, or the queue is full. Returns whether it was queued.
   */
  enqueueIfDue(did: string, reevaluateMs: number): boolean {
    if (this.#queueSize >= this.#opts.maxQueue) return false;
    const last = this.getEvaluation(did);
    if (last && last.evaluatedAtMs + reevaluateMs > this.#now()) return false;
    if (this.#selectQueued.get(did)) return false;
    const changes = Number(this.#insertQueue.run(did, this.#now()).changes);
    this.#queueSize += changes;
    return changes > 0;
  }

  dequeue(): string | undefined {
    const row = this.#popQueue.get() as { did: string } | undefined;
    if (!row) return undefined;
    this.#queueSize--;
    return row.did;
  }

  get queueSize(): number {
    return this.#queueSize;
  }

  loadCursor(): number | undefined {
    const row = this.#selectMetadata.get(CURSOR_KEY) as { value: string } | undefined;
    const cursor = Number(row?.value);
    return row && Number.isFinite(cursor) ? cursor : undefined;
  }

  saveCursor(cursor: number): void {
    this.#upsertMetadata.run(CURSOR_KEY, String(cursor));
  }

  /** Drop stale cache rows and expired evaluations. Returns rows deleted. */
  prune(): number {
    const now = this.#now();
    let deleted = 0;
    deleted += Number(
      this.#db
        .prepare("DELETE FROM account_status WHERE status = 'active' AND checked_at_ms <= ?")
        .run(now - this.#opts.activeTtlMs).changes,
    );
    deleted += Number(
      this.#db
        .prepare("DELETE FROM account_status WHERE status != 'active' AND checked_at_ms <= ?")
        .run(now - this.#opts.inactiveTtlMs).changes,
    );
    deleted += Number(
      this.#db
        .prepare("DELETE FROM evaluations WHERE evaluated_at_ms <= ?")
        .run(now - this.#opts.evaluationTtlMs).changes,
    );
    return deleted;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#db.close();
  }

  #transaction(fn: () => void): void {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      fn();
      this.#db.exec("COMMIT");
    } catch (err) {
      this.#db.exec("ROLLBACK");
      throw err;
    }
  }
}
