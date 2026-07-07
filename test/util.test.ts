import assert from "node:assert/strict";
import { test } from "node:test";

import { backoffDelay, parseRetryAfter } from "../src/util.ts";

test("parseRetryAfter handles delta-seconds, HTTP-date and junk", () => {
  assert.equal(parseRetryAfter("5"), 5);
  assert.equal(parseRetryAfter(null), undefined);
  assert.equal(parseRetryAfter(undefined), undefined);
  assert.equal(parseRetryAfter(""), undefined);
  const now = Date.parse("2020-01-01T00:00:00Z");
  assert.equal(parseRetryAfter("Wed, 01 Jan 2020 00:00:10 GMT", now), 10);
  assert.equal(parseRetryAfter("not-a-date"), undefined);
});

test("backoffDelay: Retry-After wins (seconds→ms, capped); otherwise full jitter under ceiling", () => {
  assert.equal(backoffDelay(0, 500, 3), 3000); // server said 3s
  assert.equal(backoffDelay(99, 500, 3), 3000); // attempt irrelevant when Retry-After given
  assert.equal(backoffDelay(0, 500, 100), 30_000); // capped at 30s

  // exponential ceiling with full jitter: attempt 2 → min(500*4, 30000) = 2000
  for (let i = 0; i < 100; i++) {
    const d = backoffDelay(2, 500);
    assert.ok(d >= 0 && d <= 2000, `jittered delay ${d} out of range`);
  }
});
