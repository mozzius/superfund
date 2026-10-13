import { test } from "node:test";
import assert from "node:assert/strict";
import { buildQueryLabelsSql, shouldReissueLabel } from "./internal.ts";

test("exact match (no wildcard) produces a LIKE with ESCAPE", () => {
  const result = buildQueryLabelsSql({ uriPatterns: ["at://did:plc:abc/app.bsky.feed.post/rkey"] });
  assert.equal("error" in result, false);
  if ("sql" in result) {
    assert.match(result.sql, /uri LIKE \? ESCAPE '\\'/);
    assert.deepEqual(result.args, ["at://did:plc:abc/app.bsky.feed.post/rkey"]);
  }
});

test("trailing wildcard converts * to %", () => {
  const result = buildQueryLabelsSql({ uriPatterns: ["at://did:plc:abc/*"] });
  if ("sql" in result) {
    assert.deepEqual(result.args, ["at://did:plc:abc/%"]);
  }
});

test("non-trailing wildcard is rejected", () => {
  const result = buildQueryLabelsSql({ uriPatterns: ["at://*abc"] });
  assert.equal("error" in result, true);
  if ("error" in result) {
    assert.match(result.error, /trailing wildcards/);
  }
});

test("match-all with * produces no LIKE clause", () => {
  const result = buildQueryLabelsSql({ uriPatterns: ["*"] });
  if ("sql" in result) {
    assert.equal(result.args.length, 0);
    assert.doesNotMatch(result.sql, /LIKE/);
  }
});

test("underscore is escaped so it matches literally", () => {
  const result = buildQueryLabelsSql({ uriPatterns: ["at://did_plc_abc"] });
  if ("sql" in result) {
    assert.deepEqual(result.args, ["at://did\\_plc\\_abc"]);
  }
});

test("percent is escaped so it matches literally (not stripped)", () => {
  const result = buildQueryLabelsSql({ uriPatterns: ["at://did%plc"] });
  if ("sql" in result) {
    assert.deepEqual(result.args, ["at://did\\%plc"]);
  }
});

test("sources filter produces IN clause", () => {
  const result = buildQueryLabelsSql({
    uriPatterns: ["*"],
    sources: ["did:plc:src1"],
  });
  if ("sql" in result) {
    assert.match(result.sql, /src IN \(\?\)/);
    assert.deepEqual(result.args, ["did:plc:src1"]);
  }
});

test("multiple patterns are joined with OR", () => {
  const result = buildQueryLabelsSql({ uriPatterns: ["at://a", "at://b"] });
  if ("sql" in result) {
    assert.match(result.sql, /LIKE.*OR.*LIKE/);
    assert.deepEqual(result.args, ["at://a", "at://b"]);
  }
});

test("backslash in input is escaped", () => {
  const result = buildQueryLabelsSql({ uriPatterns: ["at://a\\b"] });
  if ("sql" in result) {
    assert.deepEqual(result.args, ["at://a\\\\b"]);
  }
});

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-10-13T12:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

test("reissues when there is no existing label", () => {
  assert.equal(shouldReissueLabel(undefined, NOW, 30 * DAY), true);
});

test("reissues when the latest label is a negation", () => {
  assert.equal(shouldReissueLabel({ neg: 1, exp: null }, NOW, 30 * DAY), true);
});

test("reissues when the latest label has expired", () => {
  assert.equal(shouldReissueLabel({ neg: 0, exp: iso(NOW - 1) }, NOW, 30 * DAY), true);
});

test("reissues a permanent label so it becomes expiring", () => {
  assert.equal(shouldReissueLabel({ neg: 0, exp: null }, NOW, 30 * DAY), true);
});

test("skips an active label refreshed within the last day", () => {
  const exp = iso(NOW + 30 * DAY - 2 * 60 * 60 * 1000);
  assert.equal(shouldReissueLabel({ neg: 0, exp }, NOW, 30 * DAY), false);
});

test("reissues an active label last refreshed over a day ago", () => {
  const exp = iso(NOW + 28 * DAY);
  assert.equal(shouldReissueLabel({ neg: 0, exp }, NOW, 30 * DAY), true);
});

test("short expiries refresh at half their length", () => {
  const hour = 60 * 60 * 1000;
  assert.equal(shouldReissueLabel({ neg: 0, exp: iso(NOW + 4 * hour) }, NOW, 4 * hour), false);
  assert.equal(shouldReissueLabel({ neg: 0, exp: iso(NOW + 1 * hour) }, NOW, 4 * hour), true);
});
