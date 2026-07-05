import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { AuthError } from "../src/errors.ts";
import { deployEnv, gsabConfigDir, loopbackAuth, refreshTokenAuth } from "../src/node.ts";

test("loopbackAuth throws a helpful AuthError when no client secret exists", async () => {
  await assert.rejects(
    () =>
      loopbackAuth({
        clientSecretPath: "/nope/does/not/exist/client_secret.json",
        tokenPath: "/nope/does/not/exist/token.json",
      }),
    (e: unknown) => e instanceof AuthError && /No OAuth client secrets/.test((e as Error).message),
  );
});

test("gsabConfigDir returns a platform path (reuses the Python CLI's config dir)", () => {
  const dir = gsabConfigDir();
  assert.ok(typeof dir === "string" && dir.length > 0);
});

test("loopbackAuth reads a BOM-prefixed client_secret without crashing", async () => {
  // The recurring onboarding bug: a UTF-8 BOM must be stripped, not blow up JSON.parse.
  // A cached refresh token is supplied so no browser opens.
  const dir = mkdtempSync(join(tmpdir(), "gsab-"));
  const secret = join(dir, "client_secret.json");
  writeFileSync(secret, "﻿" + JSON.stringify({ installed: { client_id: "x", client_secret: "y" } }));
  const tok = join(dir, "token.json");
  writeFileSync(tok, JSON.stringify({ refresh_token: "r" }));
  const creds = await loopbackAuth({ clientSecretPath: secret, tokenPath: tok });
  assert.equal(typeof creds.getToken, "function"); // constructed — the BOM was stripped
});

test("loopbackAuth maps an invalid client_secret.json to AuthError, not a raw SyntaxError", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gsab-"));
  const secret = join(dir, "client_secret.json");
  writeFileSync(secret, "﻿{ not valid json");
  await assert.rejects(
    () => loopbackAuth({ clientSecretPath: secret, tokenPath: join(dir, "t.json") }),
    (e: unknown) => e instanceof AuthError && /not valid JSON/.test((e as Error).message),
  );
});

const CRED_VARS = ["GSAB_CLIENT_ID", "GSAB_CLIENT_SECRET", "GSAB_REFRESH_TOKEN", "GSAB_CREDENTIALS"];

/** Run fn with the credential env vars cleared (restored after). */
function withCleanEnv(fn: () => void) {
  const saved: Record<string, string | undefined> = {};
  for (const k of CRED_VARS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  try {
    fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) if (v !== undefined) process.env[k] = v;
  }
}

test("refreshTokenAuth throws a helpful AuthError when nothing is configured", () => {
  withCleanEnv(() => {
    assert.throws(
      () => refreshTokenAuth(),
      (e: unknown) => e instanceof AuthError && /npx gsab-js env/.test((e as Error).message),
    );
  });
});

test("refreshTokenAuth names EXACTLY the missing var on partial configuration", () => {
  withCleanEnv(() => {
    process.env.GSAB_CLIENT_ID = "a";
    process.env.GSAB_CLIENT_SECRET = "b";
    assert.throws(
      () => refreshTokenAuth(),
      (e: unknown) =>
        e instanceof AuthError &&
        /Almost configured — GSAB_REFRESH_TOKEN is missing/.test((e as Error).message),
    );
  });
});

test("refreshTokenAuth accepts a single packed GSAB_CREDENTIALS value", () => {
  const blob = Buffer.from(
    JSON.stringify({ client_id: "a", client_secret: "b", refresh_token: "c" }),
  ).toString("base64url");
  withCleanEnv(() => {
    // explicit option
    assert.equal(typeof refreshTokenAuth({ credentials: blob }).getToken, "function");
    // env var
    process.env.GSAB_CREDENTIALS = blob;
    assert.equal(typeof refreshTokenAuth().getToken, "function");
  });
});

test("refreshTokenAuth maps a corrupt GSAB_CREDENTIALS to AuthError with the fix", () => {
  withCleanEnv(() => {
    process.env.GSAB_CREDENTIALS = "not-base64-json";
    assert.throws(
      () => refreshTokenAuth(),
      (e: unknown) => e instanceof AuthError && /npx gsab-js env/.test((e as Error).message),
    );
  });
});

test("refreshTokenAuth accepts explicit values and env vars alike", () => {
  const explicit = refreshTokenAuth({ clientId: "a", clientSecret: "b", refreshToken: "c" });
  assert.equal(typeof explicit.getToken, "function");

  process.env.GSAB_CLIENT_ID = "a";
  process.env.GSAB_CLIENT_SECRET = "b";
  process.env.GSAB_REFRESH_TOKEN = "c";
  try {
    const fromEnv = refreshTokenAuth();
    assert.equal(typeof fromEnv.getToken, "function");
  } finally {
    delete process.env.GSAB_CLIENT_ID;
    delete process.env.GSAB_CLIENT_SECRET;
    delete process.env.GSAB_REFRESH_TOKEN;
  }
});

test("deployEnv returns ONE packed value by default, the trio with split (no browser)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gsab-"));
  const secret = join(dir, "client_secret.json");
  writeFileSync(secret, JSON.stringify({ installed: { client_id: "id-1", client_secret: "sec-1" } }));
  const tok = join(dir, "token.json");
  writeFileSync(tok, JSON.stringify({ refresh_token: "ref-1" }));

  const packed = await deployEnv({ clientSecretPath: secret, tokenPath: tok });
  assert.deepEqual(Object.keys(packed), ["GSAB_CREDENTIALS"]);
  assert.deepEqual(JSON.parse(Buffer.from(packed.GSAB_CREDENTIALS, "base64url").toString()), {
    client_id: "id-1",
    client_secret: "sec-1",
    refresh_token: "ref-1",
  });
  // and the packed value actually feeds refreshTokenAuth
  assert.equal(
    typeof refreshTokenAuth({ credentials: packed.GSAB_CREDENTIALS }).getToken,
    "function",
  );

  const split = await deployEnv({ clientSecretPath: secret, tokenPath: tok, split: true });
  assert.deepEqual(split, {
    GSAB_CLIENT_ID: "id-1",
    GSAB_CLIENT_SECRET: "sec-1",
    GSAB_REFRESH_TOKEN: "ref-1",
  });
});
