#!/usr/bin/env node
/** `npx gsab-js <command>` — deploy-setup helpers.
 *
 *  env [--split]   sign in once (browser, cached after) and print the env var(s) a server
 *                  needs for refreshTokenAuth(). Default: one GSAB_CREDENTIALS value.
 *  doctor          check THIS environment's deploy credentials end-to-end (presence + a
 *                  real token refresh). Exit 0 = writes will work. */
import { deployEnv, refreshTokenAuth } from "./node";

const cmd = process.argv[2];
const flags = new Set(process.argv.slice(3));

async function main(): Promise<void> {
if (cmd === "env") {
  const split = flags.has("--split");
  const vars = await deployEnv({ split });
  for (const [k, v] of Object.entries(vars)) console.log(`${k}=${v}`);
  console.error(`\nSet ${split ? "these" : "this"} on your host (Vercel / Netlify / CI secret store).`);
  console.error("Treat as secrets — scope is drive.file (only sheets gsab created), revocable at");
  console.error("myaccount.google.com → Security → Third-party access.");
} else if (cmd === "doctor") {
  const packed = !!process.env.GSAB_CREDENTIALS;
  const trio = ["GSAB_CLIENT_ID", "GSAB_CLIENT_SECRET", "GSAB_REFRESH_TOKEN"].filter(
    (k) => process.env[k],
  );
  if (!packed && trio.length === 0) {
    console.log("No deploy credentials in this environment (GSAB_CREDENTIALS or the GSAB_* trio).");
    console.log("Local dev doesn't need them — loopbackAuth() signs in on its own.");
    console.log("For a server: run `npx gsab-js env` on your machine, set the value on the host.");
    process.exit(1);
  }
  console.log(
    packed
      ? `found: GSAB_CREDENTIALS${trio.length ? ` (plus ${trio.join(", ")})` : ""}`
      : `found: ${trio.join(", ")}`,
  );
  try {
    const token = await refreshTokenAuth().getToken();
    if (token) {
      console.log("token refresh: OK — writes will work here.");
    } else {
      console.log("token refresh returned no token — check the credentials.");
      process.exit(1);
    }
  } catch (e) {
    console.error(`token refresh FAILED: ${(e as Error).message}`);
    process.exit(1);
  }
} else {
  console.log(`gsab-js — Google Sheets as a Backend (JS/TS)

Usage:
  npx gsab-js env [--split]   sign in (once) and print the env var(s) a deployed server needs
  npx gsab-js doctor          verify this environment's deploy credentials end-to-end

Docs: https://gsab.ajmalaksar.com/docs/javascript   Demo: https://gsab.ajmalaksar.com/demo`);
  if (cmd && cmd !== "help" && cmd !== "--help" && cmd !== "-h") process.exit(1);
}
}

main().catch((e) => {
  console.error((e as Error).message);
  process.exit(1);
});
