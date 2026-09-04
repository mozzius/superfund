import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { createPostStore } from "./post-store.ts";

function temporaryDatabase(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "superfund-post-store-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return join(directory, "posts.db");
}

test("persists posts and the cursor across restarts", async (t) => {
  const dbPath = temporaryDatabase(t);
  const first = createPostStore({
    dbPath,
    ttlMs: 60_000,
    flushIntervalMs: 0,
    cleanupIntervalMs: 0,
  });
  first.setPost("at://post", "at://root");
  first.updateCursor(123);
  first.close();

  const second = createPostStore({
    dbPath,
    ttlMs: 60_000,
    flushIntervalMs: 0,
    cleanupIntervalMs: 0,
  });
  assert.equal(await second.getClaimedRoot("at://post"), "at://root");
  assert.equal(second.loadCursor(), 123);
  second.close();
});

test("stores a top-level post without duplicating its URI as the root", async () => {
  const store = createPostStore({
    dbPath: ":memory:",
    ttlMs: 60_000,
    flushIntervalMs: 0,
    cleanupIntervalMs: 0,
  });
  store.setPost("at://top-level", "at://top-level");
  store.flush();
  assert.equal(await store.getClaimedRoot("at://top-level"), "at://top-level");
  store.close();
});

test("makes pending posts available before the next batch flush", async () => {
  const store = createPostStore({
    dbPath: ":memory:",
    ttlMs: 60_000,
    flushIntervalMs: 0,
    cleanupIntervalMs: 0,
  });
  store.setPost("at://post", "at://root");
  assert.equal(await store.getClaimedRoot("at://post"), "at://root");
  store.close();
});

test("uses Redis as a read-only fallback and backfills SQLite", async () => {
  let fallbackCalls = 0;
  const store = createPostStore({
    dbPath: ":memory:",
    ttlMs: 60_000,
    flushIntervalMs: 0,
    cleanupIntervalMs: 0,
    legacyGetClaimedRoot: async (uri) => {
      fallbackCalls++;
      return uri === "at://legacy" ? "at://root" : null;
    },
  });

  assert.equal(await store.getClaimedRoot("at://legacy"), "at://root");
  store.flush();
  assert.equal(await store.getClaimedRoot("at://legacy"), "at://root");
  assert.equal(fallbackCalls, 1);
  store.close();
});

test("ignores and removes expired posts", async () => {
  let now = 1_000;
  const store = createPostStore({
    dbPath: ":memory:",
    ttlMs: 100,
    flushIntervalMs: 0,
    cleanupIntervalMs: 0,
    now: () => now,
  });
  store.setPost("at://post", "at://root");
  store.flush();

  now = 1_101;
  assert.equal(await store.getClaimedRoot("at://post"), null);
  assert.equal(store.cleanupExpired(), 1);
  store.close();
});

test("keeps the durable cursor monotonic across reconnecting trackers", () => {
  const store = createPostStore({
    dbPath: ":memory:",
    ttlMs: 60_000,
    flushIntervalMs: 0,
    cleanupIntervalMs: 0,
  });
  store.updateCursor(200);
  store.updateCursor(100);
  assert.equal(store.loadCursor(), 200);
  store.close();
});
