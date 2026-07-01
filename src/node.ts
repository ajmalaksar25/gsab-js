/** Node authentication — loopback OAuth via @google-cloud/local-auth (parity with the Python
 *  `gsab auth login`). Node-only; exported as the `gsab/node` subpath so the browser bundle
 *  never pulls in google-auth-library.
 *
 *      import { connect } from "gsab";
 *      import { loopbackAuth } from "gsab/node";
 *      const db = connect({ url, auth: await loopbackAuth() }).sheet(schema);
 *      await db.insert({ id: 1, name: "Ada" });
 *
 *  The first call opens a browser once; the refresh token is cached and reused after that. */
import { authenticate } from "@google-cloud/local-auth";
import { OAuth2Client } from "google-auth-library";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { Credentials } from "./connection";
import { AuthError } from "./errors";

const DRIVE_FILE = "https://www.googleapis.com/auth/drive.file";
/** DIY: read/write ALL of the user's sheets (broader, sensitive scope). */
export const FULL_SCOPES = [
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/drive.file",
];

export interface LoopbackOptions {
  /** OAuth Desktop client-secrets JSON. Defaults to the one the gsab Python CLI installed. */
  clientSecretPath?: string;
  /** Where to cache the refresh token. Defaults to the gsab config dir. */
  tokenPath?: string;
  /** OAuth scopes. Defaults to the friction-free `drive.file` (only sheets gsab creates). */
  scopes?: string[];
}

/** The gsab config dir the Python CLI uses (platformdirs user-data dir), so the JS client
 *  reuses the same bundled OAuth client instead of needing its own. */
export function gsabConfigDir(): string {
  if (process.platform === "win32") {
    return join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "gsab", "gsab");
  }
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "gsab");
  }
  return join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "gsab");
}

function readInstalledClient(path: string): { client_id: string; client_secret: string } {
  let raw: { installed?: Record<string, string>; web?: Record<string, string> };
  try {
    // Strip a UTF-8 BOM (a recurring gsab onboarding bug) before parsing.
    raw = JSON.parse(readFileSync(path, "utf-8").replace(/^﻿/, ""));
  } catch (e) {
    throw new AuthError(
      `${path} is not valid JSON (${(e as Error).message}). Reinstall the gsab Python CLI and run ` +
        "`gsab auth login`, or pass a valid { clientSecretPath }.",
    );
  }
  const c = raw.installed || raw.web;
  if (!c?.client_id || !c?.client_secret) {
    throw new AuthError(`${path} is not a valid OAuth Desktop client (missing installed/web keys).`);
  }
  return { client_id: c.client_id, client_secret: c.client_secret };
}

function readToken(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

function writeToken(path: string, creds: Record<string, unknown>): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(creds, null, 2), { encoding: "utf-8", mode: 0o600 });
  // writeFileSync's mode only applies on create; reassert on POSIX so rewrites stay owner-only.
  // (On Windows, Node ignores POSIX mode — the token rests under the LOCALAPPDATA directory ACL.)
  if (process.platform !== "win32") chmodSync(path, 0o600);
}

/** Sign in with Google via the loopback flow and return reusable `Credentials`.
 *
 *  Reuses the bundled OAuth client the Python CLI installed (so no Cloud project is needed)
 *  and caches the refresh token, so only the first call opens a browser. */
export async function loopbackAuth(opts: LoopbackOptions = {}): Promise<Credentials> {
  const clientSecretPath = opts.clientSecretPath ?? join(gsabConfigDir(), "client_secret.json");
  const tokenPath = opts.tokenPath ?? join(gsabConfigDir(), "token-js.json");
  const scopes = opts.scopes ?? [DRIVE_FILE];

  if (!existsSync(clientSecretPath)) {
    throw new AuthError(
      `No OAuth client secrets found at ${clientSecretPath}. Install the gsab Python CLI ` +
        "(pip install gsab) and run `gsab auth login` once, or pass { clientSecretPath }.",
    );
  }
  const { client_id, client_secret } = readInstalledClient(clientSecretPath);

  let client: OAuth2Client;
  const cached = readToken(tokenPath);
  if (cached?.refresh_token) {
    client = new OAuth2Client({ clientId: client_id, clientSecret: client_secret });
    client.setCredentials(cached);
  } else {
    // local-auth bundles its own google-auth-library copy, so cast through unknown.
    client = (await authenticate({ scopes, keyfilePath: clientSecretPath })) as unknown as OAuth2Client;
    if (client.credentials?.refresh_token) {
      writeToken(tokenPath, client.credentials as Record<string, unknown>);
    }
  }
  // Persist rotated tokens (Google may hand back a new refresh token).
  client.on("tokens", (t) =>
    writeToken(tokenPath, { ...(readToken(tokenPath) ?? {}), ...t } as Record<string, unknown>),
  );

  return {
    async getToken(): Promise<string | null> {
      try {
        const { token } = await client.getAccessToken();
        return token ?? null;
      } catch (e) {
        // A revoked/expired refresh token surfaces as a raw google-auth error — map it to
        // AuthError, matching the 401 REST path and the "errors are first-class" contract.
        throw new AuthError(
          `Google sign-in expired or was revoked (${(e as Error).message}). Run the loopback ` +
            `login again to re-consent (delete ${tokenPath} or call loopbackAuth()).`,
        );
      }
    },
  };
}
