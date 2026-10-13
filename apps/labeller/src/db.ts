import type { LabelerServer } from "@skyware/labeler";

/**
 * Skyware only creates the bare `labels` table (rowid PK, nothing else). The
 * internal upsert/dedup lookups all filter on (src, uri, val), so without this
 * index each one is a full table scan — and libsql runs queries synchronously
 * on the event loop. Once the table hit several GB that stalled the process
 * long enough for the watchdog to kill it, repeatedly, until Railway gave up.
 *
 * The first run against an existing big table takes a while (it blocks until
 * done), so call this before listening and keep the healthcheck timeout high.
 */
export async function ensureIndexes(labeler: LabelerServer) {
  await (labeler as unknown as { dbInitLock: Promise<void> }).dbInitLock;
  const startedAt = Date.now();
  await labeler.db.execute(
    "CREATE INDEX IF NOT EXISTS labels_src_uri_val_id ON labels (src, uri, val, id)",
  );
  console.log(`[db] indexes ready in ${Date.now() - startedAt}ms`);
}
