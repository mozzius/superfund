import { test } from "node:test";
import assert from "node:assert/strict";
import { claimedRoot, isFuckedUpReply } from "./classify.ts";

const mockPosts = (value: string | null) => ({
  getClaimedRoot: async () => value,
});

test("claimedRoot returns root URI for replies", () => {
  const record = { reply: { root: { uri: "at://did:plc:abc/root" } } };
  assert.equal(
    claimedRoot("at://did:plc:abc/post", record),
    "at://did:plc:abc/root",
  );
});

test("claimedRoot returns own URI for non-replies", () => {
  assert.equal(claimedRoot("at://did:plc:abc/post", {}), "at://did:plc:abc/post");
});

test("isFuckedUpReply returns false for non-replies", async () => {
  assert.equal(await isFuckedUpReply({}, mockPosts(null)), false);
});

test("isFuckedUpReply returns false when parent not cached", async () => {
  const record = { reply: { parent: { uri: "at://parent" }, root: { uri: "at://root" } } };
  assert.equal(await isFuckedUpReply(record, mockPosts(null)), false);
});

test("isFuckedUpReply returns true when parent root mismatches", async () => {
  const record = { reply: { parent: { uri: "at://parent" }, root: { uri: "at://root" } } };
  assert.equal(await isFuckedUpReply(record, mockPosts("at://different")), true);
});

test("isFuckedUpReply returns false when parent root matches", async () => {
  const record = { reply: { parent: { uri: "at://parent" }, root: { uri: "at://root" } } };
  assert.equal(await isFuckedUpReply(record, mockPosts("at://root")), false);
});
