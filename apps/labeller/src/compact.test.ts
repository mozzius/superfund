import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { compactLabelsDb } from "./compact.ts";

// Same statement skyware's initializeDatabase() runs.
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS labels (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    src TEXT NOT NULL,
    uri TEXT NOT NULL,
    cid TEXT,
    val TEXT NOT NULL,
    neg BOOLEAN DEFAULT FALSE,
    cts DATETIME NOT NULL,
    exp DATETIME,
    sig BLOB
  );
`;

const SRC = "did:plc:labeller";
const ACCOUNT = "doesnt-know-how-replyrefs-work";
const POST = "fucked-up-replyref";

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "compact-test-"));
  const dbPath = join(dir, "labels.db");
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(SCHEMA);
  const insert = db.prepare(
    "INSERT INTO labels (src, uri, cid, val, neg, cts, exp, sig) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const add = (uri: string, val: string, neg = 0, exp: string | null = null) =>
    Number(
      insert.run(SRC, uri, null, val, neg, "2026-10-01T00:00:00.000Z", exp, Buffer.from("sig"))
        .lastInsertRowid,
    );
  return { dir, dbPath, db, add };
}

function rows(dbPath: string) {
  const db = new DatabaseSync(dbPath);
  try {
    return db
      .prepare("SELECT id, uri, val, neg, exp FROM labels ORDER BY id")
      .all() as { id: number; uri: string; val: string; neg: number; exp: string | null }[];
  } finally {
    db.close();
  }
}

test("keeps only the latest row per (src, uri, val), with original ids", () => {
  const { dbPath, db, add } = setup();
  // Account label churn: create, then negate + re-create twice.
  add("did:plc:a", ACCOUNT, 0, "2026-11-01T00:00:00.000Z");
  add("did:plc:a", ACCOUNT, 1);
  add("did:plc:a", ACCOUNT, 0, "2026-11-02T00:00:00.000Z");
  add("did:plc:a", ACCOUNT, 1);
  const latestAccount = add("did:plc:a", ACCOUNT, 0, "2026-11-03T00:00:00.000Z");
  // Same post labelled three times by duplicate connections.
  add("at://did:plc:a/app.bsky.feed.post/1", POST);
  add("at://did:plc:a/app.bsky.feed.post/1", POST);
  const latestPost = add("at://did:plc:a/app.bsky.feed.post/1", POST);
  // A label whose latest state is negated stays negated.
  add("did:plc:b", ACCOUNT, 0, "2026-11-01T00:00:00.000Z");
  const negated = add("did:plc:b", ACCOUNT, 1);
  db.close();

  compactLabelsDb(dbPath);

  assert.deepEqual(
    rows(dbPath).map((r) => [r.id, r.uri, r.neg, r.exp]),
    [
      [latestAccount, "did:plc:a", 0, "2026-11-03T00:00:00.000Z"],
      [latestPost, "at://did:plc:a/app.bsky.feed.post/1", 0, null],
      [negated, "did:plc:b", 1, null],
    ],
  );
});

test("carries over the AUTOINCREMENT counter so ids are never reused", () => {
  const { dbPath, db, add } = setup();
  add("did:plc:a", ACCOUNT);
  const last = add("did:plc:a", ACCOUNT, 1);
  // Delete the max-id row so the counter is ahead of every remaining id.
  db.prepare("DELETE FROM labels WHERE id = ?").run(last);
  db.close();

  compactLabelsDb(dbPath);

  const after = new DatabaseSync(dbPath);
  try {
    const next = after
      .prepare("INSERT INTO labels (src, uri, val, cts) VALUES (?, ?, ?, ?)")
      .run(SRC, "did:plc:c", ACCOUNT, "2026-10-02T00:00:00.000Z");
    assert.equal(Number(next.lastInsertRowid), last + 1);
  } finally {
    after.close();
  }
});

test("adds the lookup index and leaves no stray sidecar files", () => {
  const { dir, dbPath, db, add } = setup();
  add("did:plc:a", ACCOUNT);
  db.close();

  compactLabelsDb(dbPath);

  const after = new DatabaseSync(dbPath);
  try {
    const plan = after
      .prepare(
        "EXPLAIN QUERY PLAN SELECT id FROM labels WHERE src = ? AND uri = ? AND val = ? ORDER BY id DESC LIMIT 1",
      )
      .all("a", "b", "c") as { detail: string }[];
    assert.match(plan.map((p) => p.detail).join(" "), /labels_src_uri_val_id/);
  } finally {
    after.close();
  }
  assert.equal(existsSync(`${dbPath}.compact`), false);
  assert.equal(existsSync(join(dir, "labels.db.compact-journal")), false);
});
