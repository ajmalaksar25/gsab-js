---
name: gsab-js
description: Use gsab-js — Google Sheets as a Backend for JavaScript/TypeScript (npm gsab-js). No-auth public reads in browser/Node, authed CRUD in Node, reactive cache, React useSheet hook, serverless deploy auth. Use when reading/writing Google Sheets from JS/TS, building a sheet-backed app or React UI, or deploying sheet writes to Vercel/serverless.
---

# gsab-js — Google Sheets as a Backend (JS/TS)

`npm install gsab-js`. ESM + CJS, TypeScript types included, Node ≥18. Entry points:
`gsab-js` (isomorphic core), `gsab-js/node` (auth, Node-only), `gsab-js/react` (hook;
react ≥18 optional peer). Mirrors the Python `gsab` library (PyPI) — same schema/error model.

## Read a PUBLIC sheet — zero auth, works in the browser

```js
import { connect } from "gsab-js";
const db = connect("<sheet url or id>").sheet();          // "anyone with link" sheet
const rows = await db.read();                              // all rows, keyed by header
const pro  = await db.read({ plan: "pro" });               // client-side filter ($gt/$lt/$ne ops too)
const top  = await db.query("SELECT A, D ORDER BY D DESC LIMIT 10"); // server-side gviz SQL
for await (const c of db.watch({ interval: 2000 })) { /* { added, updated, removed } */ }
```

## Authed CRUD (Node)

```js
import { connect } from "gsab-js";
import { loopbackAuth } from "gsab-js/node";               // browser opens ONCE, token cached
const schema = { name: "users", fields: {
  id: { type: "integer", primaryKey: true },
  name: { type: "string", required: true },
  plan: { type: "string", default: "free" },
}};
const db = connect({ auth: await loopbackAuth() }).sheet(schema);
const id = await db.createSheet("My App DB");              // or connect({ url/spreadsheetId, auth })
await db.insert({ id: 1, name: "Ada" });
await db.bulkInsert([{ id: 2, name: "Linus" }]);
await db.upsert({ id: 1, plan: "team" });                  // insert-or-update on primary key
await db.update({ id: 1 }, { plan: "pro" });               // writes ONLY changed cells
await db.delete({ id: 2 });
const url = await db.share("reader");                      // "reader" | "commenter" | "writer"
```

`loopbackAuth()` reuses the Python CLI's bundled OAuth client — if it errors with "No OAuth
client secrets", run `pip install gsab && gsab auth login` once (or pass `{clientSecretPath}`).

## Server / serverless deploy (Vercel, CI)

```js
import { refreshTokenAuth } from "gsab-js/node";           // sync, module-scope safe
const db = connect({ spreadsheetId, auth: refreshTokenAuth() }).sheet(schema);
```

Reads the single `GSAB_CREDENTIALS` env var (or the `GSAB_CLIENT_ID` / `GSAB_CLIENT_SECRET` /
`GSAB_REFRESH_TOKEN` trio). To mint it, run `npx gsab-js env` ONCE on the developer's machine
(never in CI) and set the printed value in the host's secret store. To debug a deployment,
run `npx gsab-js doctor` in that environment — it names what's missing and tests a real token
refresh. Scope is drive.file (only gsab-created sheets); revocable at myaccount.google.com.

## Reactive cache + React

```js
import { createCache } from "gsab-js";
const cache = createCache(db, { key: "id", interval: 2000 });
cache.on("insert", (row) => {}); cache.on("update", (row, prev) => {});
cache.on("delete", (row) => {}); cache.on("change", (set) => {});    // batched diff
cache.on("sync", (rows) => {}); cache.on("error", (e) => {});        // every poll / poll failed
await cache.start(); cache.all(); cache.get(1); cache.stop();
```

```jsx
import { useSheet } from "gsab-js/react";
const { rows, loading, error, cache, refresh } = useSheet(db, { key: "id" });
// or useSheet(sharedCache) — many components, ONE poller. Generic: useSheet<User>(db).
```

## Rules of thumb

- Public-read tier needs NO keys — don't add API keys or OAuth for reads of public sheets.
- Always give schemas a `primaryKey`; `upsert()` and cache/watch diffing key on it.
- `update()`/`upsert()` write per-cell: concurrent edits to different fields of a row are
  safe; a same-cell edit is last-write-wins (Sheets has no transactions or conditional writes).
- Errors subclass `GSABError` (AuthError, ValidationError, DuplicateKeyError, NotFoundError,
  PermissionDeniedError, QuotaExceededError, APIError) — messages state the fix; surface them.
- Rate limits: ~60 reads+writes/min/user on Google's API. Poll at ≥2000ms; share one
  `createCache` rather than N pollers.
- `watch()`, `createCache()`, `useSheet()` are Experimental; browser Google sign-in is not
  shipped yet — browser tier is public-read-only, writes go through your server.

Docs: https://gsab.ajmalaksar.com/docs/javascript (raw MD: /docs/javascript.md) ·
live demo: https://gsab.ajmalaksar.com/demo · Python sibling: `pip install gsab`.
