import assert from "node:assert/strict";
import { test } from "node:test";

import { ConnectionError, QuotaExceededError } from "../src/errors.ts";
import { sheetsApi } from "../src/rest.ts";

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

test("apiFetch retries transient 5xx with backoff, then returns the success body", async () => {
  let n = 0;
  const orig = globalThis.fetch;
  globalThis.fetch = (async () => {
    n++;
    return n < 3 ? new Response("", { status: 503 }) : jsonResponse({ ok: true });
  }) as typeof fetch;
  try {
    const res = await sheetsApi("TOK", "/x", { baseDelay: 1 });
    assert.deepEqual(res, { ok: true });
    assert.equal(n, 3); // failed twice, succeeded on the third
  } finally {
    globalThis.fetch = orig;
  }
});

test("a 429 surfaces a retryable QuotaExceededError with rate_limited code + retryAfter", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = (async () =>
    jsonResponse(
      { error: { message: "Rate Limit Exceeded" } },
      { status: 429, headers: { "retry-after": "7", "content-type": "application/json" } },
    )) as typeof fetch;
  try {
    await assert.rejects(
      () => sheetsApi("TOK", "/x", { retries: 0 }),
      (e: unknown) => {
        assert.ok(e instanceof QuotaExceededError);
        assert.equal(e.status, 429);
        assert.equal(e.code, "rate_limited");
        assert.equal(e.retryable, true);
        assert.equal(e.retryAfter, 7);
        return true;
      },
    );
  } finally {
    globalThis.fetch = orig;
  }
});

test("a persistent network error throws a retryable ConnectionError after exhausting retries", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("boom");
  }) as typeof fetch;
  try {
    await assert.rejects(
      () => sheetsApi("TOK", "/x", { retries: 1, baseDelay: 1 }),
      (e: unknown) => {
        assert.ok(e instanceof ConnectionError);
        assert.equal(e.retryable, true);
        return true;
      },
    );
  } finally {
    globalThis.fetch = orig;
  }
});
