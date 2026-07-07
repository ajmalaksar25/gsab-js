import assert from "node:assert/strict";
import { test } from "node:test";

import {
  APIError,
  AuthError,
  errorForStatus,
  GSABError,
  NotFoundError,
  PermissionDeniedError,
  QuotaExceededError,
  ValidationError,
} from "../src/errors.ts";

test("GSABError defaults its code from the subclass name; retryable defaults false", () => {
  assert.equal(new GSABError("x").code, "error");
  assert.equal(new AuthError("x").code, "unauthenticated");
  assert.equal(new AuthError("x").retryable, false);
  assert.equal(new ValidationError("x").code, "invalid_argument");
  // explicit options override the defaults
  const e = new APIError("x", { status: 502, code: "boom", retryable: true, retryAfter: 3 });
  assert.equal(e.status, 502);
  assert.equal(e.code, "boom");
  assert.equal(e.retryable, true);
  assert.equal(e.retryAfter, 3);
});

test("errorForStatus maps HTTP status to a typed error carrying structured metadata", () => {
  const a = errorForStatus(401, "nope");
  assert.ok(a instanceof AuthError);
  assert.equal(a.status, 401);

  // 429 → retryable rate_limit, distinct code from a quota-403, carries retryAfter
  const rl = errorForStatus(429, "slow down", 12);
  assert.ok(rl instanceof QuotaExceededError);
  assert.equal(rl.code, "rate_limited");
  assert.equal(rl.retryable, true);
  assert.equal(rl.retryAfter, 12);

  const quota = errorForStatus(403, "Quota exceeded for quota metric 'Read requests'");
  assert.ok(quota instanceof QuotaExceededError);
  assert.equal(quota.code, "quota_exceeded");
  assert.equal(quota.retryable, true);

  const perm = errorForStatus(403, "The caller does not have permission");
  assert.ok(perm instanceof PermissionDeniedError);
  assert.equal(perm.retryable, false);

  assert.ok(errorForStatus(404, "x") instanceof NotFoundError);
  assert.ok(errorForStatus(400, "x") instanceof ValidationError);

  const server = errorForStatus(500, "boom");
  assert.ok(server instanceof APIError);
  assert.equal(server.retryable, true); // 5xx is retryable
});
