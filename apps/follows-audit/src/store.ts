import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AuditDirection } from "labeller-client";

/**
 * Account status as we know it. "active" means the AppView returned a profile
 * or the relay said active; anything else is the relay's status string
 * (takendown, suspended, deleted, deactivated, ...), or "not-found" if the
 * relay has never heard of the DID.
 */
export type AccountStatus = string;

export interface Evaluation {
  did: string;
  direction: AuditDirection;
  evaluatedAtMs: number;
  /** Size of the follow list / follower count the sample was drawn from. */
  total: number;
  counted: number;
  takendown: number;
  bucket: number;
}

export interface Candidate {
  did: string;
  /** Accounts this one follows that were taken down since it was last evaluated. */
  hits: number;
}

export interface AuditStoreOptions {
  dbPath: string;
  /** How long a cached "active" status is trusted. */
  activeTtlMs: number;
  /** How long a cached non-active status is trusted. */
  inactiveTtlMs: number;
  /** Evaluations older than this are forgotten (their label has expired by then). */
  evaluationTtlMs: number;
  /** Candidates that never reach the hit threshold are dropped after this long without a hit. */
  candidateTtlMs: number;
  /** Cap on takedowns waiting for their followers to be fetched. */
  maxPendingTakedowns: number;
  now?: () => number;
}

const CURSOR_KEY = "jetstream_cursor";

export class AuditStore {
  readonly #db: DatabaseSync;
  readonly #opts: AuditStoreOptions;
  readonly #now: () => number;
  #pendingTakedowns: number;
  #closed = false;

  readonly #selectStatus;
  readonly #upsertStatus;
  readonly #updateStatusIfKnown;
  readonly #selectEvaluation;
  readonly #upsertEvaluation;
  readonly #selectDueRelabel;
  readonly #touchEvaluation;
  readonly #insertPendingTakedown;
  readonly #popPendingTakedown;
  readonly #addHit;
  readonly #selectCandidate;
  readonly #deleteCandidate;
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
        did TEXT NOT NULL,
        direction TEXT NOT NULL,
        evaluated_at_ms INTEGER NOT NULL,
        total INTEGER NOT NULL,
        counted INTEGER NOT NULL,
        takendown INTEGER NOT NULL,
        bucket INTEGER NOT NULL,
        PRIMARY KEY (did, direction)
      ) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS evaluations_by_time ON evaluations (evaluated_at_ms);

      -- Accounts that were just taken down, waiting for a backlinks lookup.
      CREATE TABLE IF NOT EXISTS pending_takedowns (
        did TEXT PRIMARY KEY,
        taken_down_at_ms INTEGER NOT NULL
      ) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS pending_takedowns_by_time ON pending_takedowns (taken_down_at_ms);

      -- Followers of taken-down accounts, scored by how many takedowns they follow.
      CREATE TABLE IF NOT EXISTS candidates (
        did TEXT PRIMARY KEY,
        hits INTEGER NOT NULL,
        last_hit_ms INTEGER NOT NULL
      ) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS candidates_by_hits ON candidates (hits);
      CREATE INDEX IF NOT EXISTS candidates_by_last_hit ON candidates (last_hit_ms);

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
      "SELECT * FROM evaluations WHERE did = ? AND direction = ? AND evaluated_at_ms > ?",
    );
    this.#upsertEvaluation = this.#db.prepare(`
      INSERT INTO evaluations (did, direction, evaluated_at_ms, total, counted, takendown, bucket)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (did, direction) DO UPDATE SET
        evaluated_at_ms = excluded.evaluated_at_ms,
        total = excluded.total,
        counted = excluded.counted,
        takendown = excluded.takendown,
        bucket = excluded.bucket
    `);
    this.#selectDueRelabel = this.#db.prepare(`
      SELECT did FROM evaluations
      WHERE direction = ? AND bucket > 0 AND evaluated_at_ms <= ?
      ORDER BY evaluated_at_ms LIMIT 1
    `);
    this.#touchEvaluation = this.#db.prepare(
      "UPDATE evaluations SET evaluated_at_ms = ? WHERE did = ? AND direction = ?",
    );
    this.#insertPendingTakedown = this.#db.prepare(
      "INSERT OR IGNORE INTO pending_takedowns (did, taken_down_at_ms) VALUES (?, ?)",
    );
    this.#popPendingTakedown = this.#db.prepare(`
      DELETE FROM pending_takedowns
      WHERE did = (SELECT did FROM pending_takedowns ORDER BY taken_down_at_ms LIMIT 1)
      RETURNING did
    `);
    this.#addHit = this.#db.prepare(`
      INSERT INTO candidates (did, hits, last_hit_ms) VALUES (?, 1, ?)
      ON CONFLICT (did) DO UPDATE SET hits = hits + 1, last_hit_ms = excluded.last_hit_ms
    `);
    // Highest-scoring candidate that hasn't been evaluated within the cooldown.
    this.#selectCandidate = this.#db.prepare(`
      SELECT c.did, c.hits FROM candidates c
      WHERE c.hits >= ?
        AND NOT EXISTS (
          SELECT 1 FROM evaluations e
          WHERE e.did = c.did AND e.direction = 'follows' AND e.evaluated_at_ms > ?
        )
      ORDER BY c.hits DESC
      LIMIT 1
    `);
    this.#deleteCandidate = this.#db.prepare("DELETE FROM candidates WHERE did = ?");
    this.#selectMetadata = this.#db.prepare("SELECT value FROM metadata WHERE key = ?");
    this.#upsertMetadata = this.#db.prepare(`
      INSERT INTO metadata (key, value) VALUES (?, ?)
      ON CONFLICT (key) DO UPDATE SET value = excluded.value
    `);

    const row = this.#db.prepare("SELECT COUNT(*) AS n FROM pending_takedowns").get() as {
      n: number;
    };
    this.#pendingTakedowns = Number(row.n);
  }

  // --- Status cache.

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

  // --- Evaluations.

  getEvaluation(did: string, direction: AuditDirection): Evaluation | undefined {
    const row = this.#selectEvaluation.get(
      did,
      direction,
      this.#now() - this.#opts.evaluationTtlMs,
    ) as Record<string, number | string> | undefined;
    if (!row) return undefined;
    return {
      did: String(row.did),
      direction: String(row.direction) as AuditDirection,
      evaluatedAtMs: Number(row.evaluated_at_ms),
      total: Number(row.total),
      counted: Number(row.counted),
      takendown: Number(row.takendown),
      bucket: Number(row.bucket),
    };
  }

  saveEvaluation(e: Omit<Evaluation, "evaluatedAtMs">): void {
    this.#upsertEvaluation.run(
      e.did,
      e.direction,
      this.#now(),
      e.total,
      e.counted,
      e.takendown,
      e.bucket,
    );
  }

  /**
   * A labelled account whose label is due a refresh (evaluated more than
   * `reevaluateMs` ago), so labels don't lapse just because no new takedowns
   * turned up among its follows. Oldest first. Not removed: evaluating it
   * (or touchEvaluation on failure) moves it out of range.
   */
  dueForRelabel(direction: AuditDirection, reevaluateMs: number): string | undefined {
    const row = this.#selectDueRelabel.get(direction, this.#now() - reevaluateMs) as
      | { did: string }
      | undefined;
    return row?.did;
  }

  /** Push an evaluation's timestamp forward without changing its result (after a failed re-check). */
  touchEvaluation(did: string, direction: AuditDirection): void {
    this.#touchEvaluation.run(this.#now(), did, direction);
  }

  /** Highest share-taken-down first, for the dashboard. */
  topEvaluations(direction: AuditDirection, limit: number): Evaluation[] {
    const rows = this.#db
      .prepare(`
        SELECT * FROM evaluations
        WHERE direction = ? AND counted > 0 AND evaluated_at_ms > ?
        ORDER BY CAST(takendown AS REAL) / counted DESC, takendown DESC
        LIMIT ?
      `)
      .all(direction, this.#now() - this.#opts.evaluationTtlMs, limit) as Record<string, number | string>[];
    return rows.map((row) => ({
      did: String(row.did),
      direction: String(row.direction) as AuditDirection,
      evaluatedAtMs: Number(row.evaluated_at_ms),
      total: Number(row.total),
      counted: Number(row.counted),
      takendown: Number(row.takendown),
      bucket: Number(row.bucket),
    }));
  }

  /** Evaluated accounts per bucket (0 = no label). */
  bucketCounts(direction: AuditDirection): Record<number, number> {
    const rows = this.#db
      .prepare(`
        SELECT bucket, COUNT(*) AS n FROM evaluations
        WHERE direction = ? AND evaluated_at_ms > ?
        GROUP BY bucket
      `)
      .all(direction, this.#now() - this.#opts.evaluationTtlMs) as { bucket: number; n: number }[];
    return Object.fromEntries(rows.map((r) => [Number(r.bucket), Number(r.n)]));
  }

  // --- Takedowns waiting for a backlinks lookup.

  /** Returns false if it was already pending or the backlog is full. */
  addPendingTakedown(did: string): boolean {
    if (this.#pendingTakedowns >= this.#opts.maxPendingTakedowns) return false;
    const changes = Number(this.#insertPendingTakedown.run(did, this.#now()).changes);
    this.#pendingTakedowns += changes;
    return changes > 0;
  }

  takePendingTakedown(): string | undefined {
    const row = this.#popPendingTakedown.get() as { did: string } | undefined;
    if (!row) return undefined;
    this.#pendingTakedowns--;
    return row.did;
  }

  get pendingTakedowns(): number {
    return this.#pendingTakedowns;
  }

  // --- Candidates.

  /** Each DID follows one more account that was just taken down. */
  addHits(dids: Iterable<string>): void {
    const now = this.#now();
    this.#transaction(() => {
      for (const did of dids) this.#addHit.run(did, now);
    });
  }

  /**
   * Remove and return the candidate with the most hits, if it has at least
   * `minHits` and wasn't evaluated within `cooldownMs`. Taking it resets its
   * score, so it only comes back once it racks up fresh hits.
   */
  takeCandidate(minHits: number, cooldownMs: number): Candidate | undefined {
    const row = this.#selectCandidate.get(minHits, this.#now() - cooldownMs) as
      | { did: string; hits: number }
      | undefined;
    if (!row) return undefined;
    this.#deleteCandidate.run(row.did);
    return { did: row.did, hits: Number(row.hits) };
  }

  // --- Misc.

  loadCursor(): number | undefined {
    const row = this.#selectMetadata.get(CURSOR_KEY) as { value: string } | undefined;
    const cursor = Number(row?.value);
    return row && Number.isFinite(cursor) ? cursor : undefined;
  }

  saveCursor(cursor: number): void {
    this.#upsertMetadata.run(CURSOR_KEY, String(cursor));
  }

  /** Drop stale cache rows, expired evaluations and cold candidates. Returns rows deleted. */
  prune(): number {
    const now = this.#now();
    const run = (sql: string, arg: number) => Number(this.#db.prepare(sql).run(arg).changes);
    return (
      run(
        "DELETE FROM account_status WHERE status = 'active' AND checked_at_ms <= ?",
        now - this.#opts.activeTtlMs,
      ) +
      run(
        "DELETE FROM account_status WHERE status != 'active' AND checked_at_ms <= ?",
        now - this.#opts.inactiveTtlMs,
      ) +
      run("DELETE FROM evaluations WHERE evaluated_at_ms <= ?", now - this.#opts.evaluationTtlMs) +
      run("DELETE FROM candidates WHERE last_hit_ms <= ?", now - this.#opts.candidateTtlMs)
    );
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
