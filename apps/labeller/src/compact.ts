import { renameSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

/**
 * One-off rewrite of the labels DB that keeps only the latest row per
 * (src, uri, val). Older rows for the same key are fully superseded, so a
 * subscriber replaying the stream ends up in the same state either way — and
 * they were most of the table: every matched post used to negate + re-create
 * the account label, and a Jetstream connection leak wrote post labels up to
 * 8 times over.
 *
 * Seq ids are kept as-is so existing subscriber cursors stay valid, and the
 * AUTOINCREMENT counter is carried over so ids are never reused. Builds the
 * new file alongside, verifies it, then swaps it in with an atomic rename. Must
 * run before LabelerServer opens the DB.
 */
export function compactLabelsDb(dbPath: string) {
  const freshPath = `${dbPath}.compact`;
  removeWithSidecars(freshPath);

  const startedAt = Date.now();
  const db = new DatabaseSync(dbPath);
  let before: number;
  let kept: number;
  try {
    const table = db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'labels'")
      .get() as { sql: string } | undefined;
    if (!table) throw new Error("no labels table to compact");
    const createFresh = table.sql.replace(/^CREATE TABLE "?labels"?/i, "CREATE TABLE fresh.labels");
    if (createFresh === table.sql) {
      throw new Error(`unexpected labels schema: ${table.sql}`);
    }

    before = count(db, "main");
    console.log(`[compact] ${before} rows in ${dbPath}, rebuilding into ${freshPath}`);

    db.prepare("ATTACH DATABASE ? AS fresh").run(freshPath);
    db.exec("BEGIN");
    db.exec(createFresh);
    db.exec(`
      INSERT INTO fresh.labels
      SELECT * FROM main.labels
      WHERE id IN (SELECT MAX(id) FROM main.labels GROUP BY src, uri, val)
      ORDER BY id
    `);
    const seq = db
      .prepare("SELECT seq FROM main.sqlite_sequence WHERE name = 'labels'")
      .get() as { seq: number } | undefined;
    if (seq) {
      const updated = db
        .prepare("UPDATE fresh.sqlite_sequence SET seq = CAST(? AS INTEGER) WHERE name = 'labels'")
        .run(seq.seq);
      if (updated.changes === 0) {
        db.prepare("INSERT INTO fresh.sqlite_sequence (name, seq) VALUES ('labels', CAST(? AS INTEGER))").run(seq.seq);
      }
    }
    db.exec("CREATE INDEX fresh.labels_src_uri_val_id ON labels (src, uri, val, id)");
    db.exec("COMMIT");
    kept = count(db, "fresh");
    db.exec("DETACH DATABASE fresh");

    // Fold the old WAL into the main file so nothing is left in the sidecars
    // we delete below.
    const ckpt = db.prepare("PRAGMA main.wal_checkpoint(TRUNCATE)").get() as
      | { busy: number }
      | undefined;
    if (ckpt && ckpt.busy !== 0) throw new Error("could not checkpoint the old WAL");
  } catch (err) {
    db.close();
    removeWithSidecars(freshPath);
    throw err;
  }
  db.close();

  const check = new DatabaseSync(freshPath);
  try {
    const ok = check.prepare("PRAGMA quick_check").get() as { quick_check: string };
    if (ok.quick_check !== "ok") throw new Error(`quick_check failed: ${ok.quick_check}`);
    const rows = count(check, "main");
    if (rows !== kept) throw new Error(`row count mismatch: ${rows} != ${kept}`);
  } finally {
    check.close();
  }

  // A stale -wal next to the new file would be replayed onto it, so these must
  // go before the rename. They're empty after the TRUNCATE checkpoint above.
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
  renameSync(freshPath, dbPath);

  console.log(
    `[compact] kept ${kept} of ${before} rows (dropped ${before - kept}) ` +
      `in ${Date.now() - startedAt}ms`,
  );
}

function count(db: DatabaseSync, schema: "main" | "fresh"): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM ${schema}.labels`).get() as { n: number };
  return Number(row.n);
}

function removeWithSidecars(path: string) {
  for (const suffix of ["", "-journal", "-wal", "-shm"]) {
    rmSync(`${path}${suffix}`, { force: true });
  }
}
