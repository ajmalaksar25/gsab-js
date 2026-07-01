import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { AuthError } from "../src/errors.ts";
import { gsabConfigDir, loopbackAuth } from "../src/node.ts";

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
