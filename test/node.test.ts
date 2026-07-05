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

test("refreshTokenAuth throws a helpful AuthError when nothing is configured", () => {
  const saved = {};
  for (const k of ["GSAB_CLIENT_ID", "GSAB_CLIENT_SECRET", "GSAB_REFRESH_TOKEN"]) {
    (saved as any)[k] = process.env[k];
    delete process.env[k];
  }
  try {
    assert.throws(
      () => refreshTokenAuth(),
      (e: unknown) => e instanceof AuthError && /deployEnv/.test((e as Error).message),
    );
  } finally {
    for (const [k, v] of Object.entries(saved)) if (v !== undefined) process.env[k] = v as string;
  }
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

test("deployEnv returns the three env values from a cached login (no browser)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gsab-"));
  const secret = join(dir, "client_secret.json");
  writeFileSync(secret, JSON.stringify({ installed: { client_id: "id-1", client_secret: "sec-1" } }));
  const tok = join(dir, "token.json");
  writeFileSync(tok, JSON.stringify({ refresh_token: "ref-1" }));
  const env = await deployEnv({ clientSecretPath: secret, tokenPath: tok });
  assert.deepEqual(env, {
    GSAB_CLIENT_ID: "id-1",
    GSAB_CLIENT_SECRET: "sec-1",
    GSAB_REFRESH_TOKEN: "ref-1",
  });
});
