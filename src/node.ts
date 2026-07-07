/** Node authentication — loopback OAuth via @google-cloud/local-auth (parity with the Python
 *  `gsab auth login`). Node-only; exported as the `gsab-js/node` subpath so the browser bundle
 *  never pulls in google-auth-library.
 *
 *  On your machine (opens a browser once, then reuses the cached token):
 *
 *      import { connect } from "gsab-js";
 *      import { loopbackAuth } from "gsab-js/node";
 *      const db = connect({ url, auth: await loopbackAuth() }).sheet(schema);
 *      await db.insert({ id: 1, name: "Ada" });
 *
 *  On a server (Vercel / serverless / CI — no browser, no filesystem cache): print your
 *  credentials once with `deployEnv()`, set them as env vars, and use `refreshTokenAuth()`:
 *
 *      node --input-type=module -e "console.log(await (await import('gsab-js/node')).deployEnv())"
 *      // → { GSAB_CLIENT_ID, GSAB_CLIENT_SECRET, GSAB_REFRESH_TOKEN }
 *
 *      const db = connect({ spreadsheetId, auth: refreshTokenAuth() }).sheet(schema); */
import { authenticate } from "@google-cloud/local-auth";
import { OAuth2Client } from "google-auth-library";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { Credentials } from "./connection";
import { AuthError } from "./errors";
import type { StoredCredential, TokenStore } from "./store";

export { MemoryTokenStore } from "./store";
export type { StoredCredential, TokenStore } from "./store";

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

export interface RefreshTokenOptions {
  /** Default: process.env.GSAB_CLIENT_ID */
  clientId?: string;
  /** Default: process.env.GSAB_CLIENT_SECRET */
  clientSecret?: string;
  /** Default: process.env.GSAB_REFRESH_TOKEN */
  refreshToken?: string;
  /** A single packed credential from `npx gsab-js env`. Default: process.env.GSAB_CREDENTIALS */
  credentials?: string;
}

type PackedCredentials = { client_id: string; client_secret: string; refresh_token: string };

function packCredentials(c: PackedCredentials): string {
  return Buffer.from(JSON.stringify(c)).toString("base64url");
}

function unpackCredentials(blob: string): PackedCredentials {
  try {
    const c = JSON.parse(Buffer.from(blob.trim(), "base64url").toString("utf-8"));
    if (c.client_id && c.client_secret && c.refresh_token) return c;
  } catch {
    /* fall through to the error below */
  }
  throw new AuthError(
    "GSAB_CREDENTIALS is set but isn't a valid gsab credential value (it may be truncated or " +
      "hand-edited). Re-run `npx gsab-js env` on your own machine and paste the fresh value.",
  );
}

/** Credentials from a long-lived refresh token — for servers (Vercel, serverless, CI) where
 *  a browser sign-in isn't possible. Reads the single GSAB_CREDENTIALS env var (printed by
 *  `npx gsab-js env`), or the GSAB_CLIENT_ID / GSAB_CLIENT_SECRET / GSAB_REFRESH_TOKEN trio,
 *  unless values are passed explicitly. Synchronous — safe at module scope. */
export function refreshTokenAuth(opts: RefreshTokenOptions = {}): Credentials {
  let clientId = opts.clientId ?? process.env.GSAB_CLIENT_ID;
  let clientSecret = opts.clientSecret ?? process.env.GSAB_CLIENT_SECRET;
  let refreshToken = opts.refreshToken ?? process.env.GSAB_REFRESH_TOKEN;
  const packed = opts.credentials ?? process.env.GSAB_CREDENTIALS;
  if (packed && !(clientId && clientSecret && refreshToken)) {
    const c = unpackCredentials(packed);
    clientId ??= c.client_id;
    clientSecret ??= c.client_secret;
    refreshToken ??= c.refresh_token;
  }
  if (!clientId || !clientSecret || !refreshToken) {
    const missing = [
      !clientId && "GSAB_CLIENT_ID",
      !clientSecret && "GSAB_CLIENT_SECRET",
      !refreshToken && "GSAB_REFRESH_TOKEN",
    ].filter(Boolean);
    throw new AuthError(
      missing.length < 3
        ? `Almost configured — ${missing.join(" and ")} ${missing.length === 1 ? "is" : "are"} ` +
          "missing (the other credential vars are set). Re-run `npx gsab-js env --split` and " +
          "set the full set, or use the single GSAB_CREDENTIALS value instead."
        : "No deploy credentials found. Run `npx gsab-js env` on your own machine and set the " +
          "printed GSAB_CREDENTIALS env var on your host (Vercel/CI). Local scripts don't " +
          "need this — loopbackAuth() signs in by itself.",
    );
  }
  const client = new OAuth2Client({ clientId, clientSecret });
  client.setCredentials({ refresh_token: refreshToken });
  return {
    async getToken(): Promise<string | null> {
      try {
        const { token } = await client.getAccessToken();
        return token ?? null;
      } catch (e) {
        throw new AuthError(
          `Google sign-in expired or was revoked (${(e as Error).message}). Re-run ` +
            "`npx gsab-js env` on your machine and update the host's credentials.",
        );
      }
    },
  };
}

/** Sign in locally (via {@link loopbackAuth}, cached after the first run) and return what a
 *  deployed server needs for {@link refreshTokenAuth}, keyed by env-var name. By default one
 *  value: `{ GSAB_CREDENTIALS }` — a single var to set on the host. Pass `{ split: true }`
 *  for the three-variable form. Treat the output as secrets. */
export async function deployEnv(
  opts: LoopbackOptions & { split?: boolean } = {},
): Promise<Record<string, string>> {
  await loopbackAuth(opts); // guarantees a cached refresh token (may open a browser once)
  const clientSecretPath = opts.clientSecretPath ?? join(gsabConfigDir(), "client_secret.json");
  const tokenPath = opts.tokenPath ?? join(gsabConfigDir(), "token-js.json");
  const { client_id, client_secret } = readInstalledClient(clientSecretPath);
  const refresh = readToken(tokenPath)?.refresh_token;
  if (typeof refresh !== "string" || !refresh) {
    throw new AuthError(
      `Signed in, but no refresh token was cached at ${tokenPath}. Delete that file and run ` +
        "`npx gsab-js env` again to force a fresh consent.",
    );
  }
  if (opts.split) {
    return {
      GSAB_CLIENT_ID: client_id,
      GSAB_CLIENT_SECRET: client_secret,
      GSAB_REFRESH_TOKEN: refresh,
    };
  }
  return {
    GSAB_CREDENTIALS: packCredentials({ client_id, client_secret, refresh_token: refresh }),
  };
}

// --- multi-tenant auth (each user their own Google account / refresh token) ---------------

export interface UserAuthOptions {
  /** Shared app OAuth client id. Default: process.env.GSAB_CLIENT_ID. Used for every user
   *  unless their StoredCredential carries its own clientId/clientSecret. */
  clientId?: string;
  /** Shared app OAuth client secret. Default: process.env.GSAB_CLIENT_SECRET. */
  clientSecret?: string;
}

/** Build a per-user `Credentials` factory backed by a {@link TokenStore}, for a backend that
 *  serves many users, each writing to their OWN Google Drive.
 *
 *      const userAuth = createUserAuth(store);            // once, at startup
 *      const db = connect({ spreadsheetId, auth: userAuth(userId) }).sheet(schema);
 *
 *  Unlike calling `refreshTokenAuth()` per request (which builds a fresh OAuth2Client every
 *  time), this caches one `OAuth2Client` per user, so a user's short-lived access token is
 *  reused across requests instead of being re-minted each call. Rotated refresh tokens are
 *  written back to the store. Obtain each user's refresh token first with
 *  {@link buildConsentUrl} + {@link exchangeAuthCode}. */
export function createUserAuth(
  store: TokenStore,
  opts: UserAuthOptions = {},
): (userId: string) => Credentials {
  const appClientId = opts.clientId ?? process.env.GSAB_CLIENT_ID;
  const appClientSecret = opts.clientSecret ?? process.env.GSAB_CLIENT_SECRET;
  const clients = new Map<string, OAuth2Client>();

  return (userId: string): Credentials => ({
    async getToken(): Promise<string | null> {
      let client = clients.get(userId);
      if (!client) {
        const cred = await store.get(userId);
        if (!cred?.refreshToken) {
          throw new AuthError(
            `No Google credentials stored for user '${userId}'. Send them through the OAuth ` +
              "connect flow (buildConsentUrl → exchangeAuthCode) and save the result first.",
            { code: "unauthenticated" },
          );
        }
        client = new OAuth2Client({
          clientId: cred.clientId ?? appClientId,
          clientSecret: cred.clientSecret ?? appClientSecret,
        });
        client.setCredentials({ refresh_token: cred.refreshToken });
        // Persist a rotated refresh token (Google occasionally issues a new one).
        client.on("tokens", (t) => {
          if (t.refresh_token) void store.set(userId, { ...cred, refreshToken: t.refresh_token });
        });
        clients.set(userId, client);
      }
      try {
        const { token } = await client.getAccessToken();
        return token ?? null;
      } catch (e) {
        clients.delete(userId); // rebuild from the store next call (creds may have been updated)
        throw new AuthError(
          `Google sign-in for user '${userId}' expired or was revoked (${(e as Error).message}). ` +
            "Have them reconnect their Google account.",
          { code: "unauthenticated", cause: e },
        );
      }
    },
  });
}

export interface ConsentUrlOptions {
  /** OAuth client id. Default: process.env.GSAB_CLIENT_ID. */
  clientId?: string;
  /** The redirect URI registered on the OAuth client (your backend's callback route). */
  redirectUri: string;
  /** Scopes to request. Default: the friction-free `drive.file`. */
  scopes?: string[];
  /** Opaque value round-tripped to your callback (carry your own userId/CSRF token here). */
  state?: string;
}

/** Build the Google consent-screen URL to send a user to so they authorize your app against
 *  THEIR Google account. Uses `access_type=offline` + `prompt=consent` so Google returns a
 *  refresh token (required by {@link createUserAuth}). Handle the redirect in your callback and
 *  pass the `code` to {@link exchangeAuthCode}. */
export function buildConsentUrl(opts: ConsentUrlOptions): string {
  const clientId = opts.clientId ?? process.env.GSAB_CLIENT_ID;
  if (!clientId) {
    throw new AuthError("buildConsentUrl() needs a clientId (or set GSAB_CLIENT_ID).");
  }
  const client = new OAuth2Client({ clientId, redirectUri: opts.redirectUri });
  return client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: opts.scopes ?? [DRIVE_FILE],
    state: opts.state,
  });
}

export interface AuthCodeExchangeOptions {
  /** OAuth client id. Default: process.env.GSAB_CLIENT_ID. */
  clientId?: string;
  /** OAuth client secret. Default: process.env.GSAB_CLIENT_SECRET. */
  clientSecret?: string;
  /** The same redirectUri used to build the consent URL. */
  redirectUri: string;
  /** The `code` query param Google sent to your callback. */
  code: string;
}

/** Exchange an OAuth authorization `code` (from your callback) for a {@link StoredCredential}
 *  you persist via a {@link TokenStore}. Throws if Google returned no refresh token — build the
 *  consent URL with {@link buildConsentUrl} (offline + consent) so it does. */
export async function exchangeAuthCode(
  opts: AuthCodeExchangeOptions,
): Promise<StoredCredential> {
  const clientId = opts.clientId ?? process.env.GSAB_CLIENT_ID;
  const clientSecret = opts.clientSecret ?? process.env.GSAB_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new AuthError(
      "exchangeAuthCode() needs clientId/clientSecret (or GSAB_CLIENT_ID / GSAB_CLIENT_SECRET).",
    );
  }
  const client = new OAuth2Client({ clientId, clientSecret, redirectUri: opts.redirectUri });
  const { tokens } = await client.getToken(opts.code);
  if (!tokens.refresh_token) {
    throw new AuthError(
      "Google returned no refresh token. Build the consent URL with access_type=offline and " +
        "prompt=consent (buildConsentUrl does this), and make sure the user is re-consenting.",
    );
  }
  return { refreshToken: tokens.refresh_token, clientId, clientSecret };
}
