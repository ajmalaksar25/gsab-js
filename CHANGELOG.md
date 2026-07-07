# Changelog

## 0.3.0 — 2026-07-07

Multi-tenant auth and mobile-grade write reliability — the pieces a real backend serving many
users (each with their own Google Drive, syncing from flaky clients) needs.

- **Multi-tenant auth** (`gsab-js/node`): `createUserAuth(store)` returns a per-user
  `Credentials` factory backed by a pluggable `TokenStore` — one cached `OAuth2Client` per user
  (short-lived access tokens are reused across requests instead of re-minted every call), with
  rotated refresh tokens written back. `buildConsentUrl()` + `exchangeAuthCode()` obtain each
  user's refresh token via the standard authorization-code flow. `MemoryTokenStore` ships as the
  default; the `TokenStore` / `StoredCredential` types are exported from the root too.
- **Idempotent writes**: `insertIdempotent(record, { key })` — a retried, timed-out insert
  returns `"exists"` instead of creating a duplicate. Give records a stable client-generated id.
- **`bulkUpsert(records, { key })`**: upsert a whole batch against **one** grid read (existing
  keys → targeted cell-writes, new keys → a single append), instead of a full-sheet read per row.
- **Per-user tab provisioning**: `ensureTab()` (add this manager's tab to an existing spreadsheet
  and write its header if missing — idempotent) and `listTabs()`. `createSheet()` still makes a
  whole new spreadsheet; `ensureTab()` adds a tab to one you already have.
- **Schema evolution**: `ensureTab()` also appends any schema fields missing from an existing
  tab's header row (new columns land at the end; existing columns are never reordered or
  removed). Reads/writes map by header name, so a field added to a schema after tabs were
  created would previously be silently dropped on write.
- **Typed error metadata**: every `GSABError` now carries `status`, a stable `code`
  (e.g. `rate_limited` vs `quota_exceeded`), `retryable`, and `retryAfter` — branch on codes,
  not message text. A 429 honors the response's `Retry-After` header.
- **Backoff jitter**: retries now use full jitter (and honor `Retry-After`) so many clients
  don't retry in lockstep.
- **Tests**: added coverage for the previously-untested read/retry paths (`gviz`, `rest`,
  `watch`) plus the new auth/idempotency/provisioning surface.

## 0.2.0 — 2026-07-05

Deploy setup is now one command and one variable.

- **`npx gsab-js env`** — sign in once on your machine, get a single `GSAB_CREDENTIALS`
  value to set on your host (`--split` for the three-variable form). **`npx gsab-js doctor`**
  verifies a deploy environment end-to-end (presence + a real token refresh).
- `refreshTokenAuth()` accepts the packed `GSAB_CREDENTIALS` (env or `{ credentials }`)
  as well as the trio; partial configuration errors now name exactly the missing variable.
- `deployEnv()` returns `{ GSAB_CREDENTIALS }` by default (pass `{ split: true }` for the
  previous three-key shape).
- **Agent skill bundled** (`skills/gsab-js/SKILL.md`): teach Claude Code or any
  skills-aware agent to use gsab-js — copy it to `~/.claude/skills/gsab-js` (one-liner:
  `npx degit ajmalaksar25/gsab-js/skills/gsab-js ~/.claude/skills/gsab-js`, or copy from
  `node_modules/gsab-js/skills/gsab-js` after installing).
- Build quality: `node:` builtins declared external (no more UNRESOLVED_IMPORT warnings);
  publish/pack builds once instead of twice (dropped redundant `prepack`).

## 0.1.0 — 2026-07-05

First npm release.

- **No-auth public read tier** (browser + Node): `connect(url).sheet()` → `read()` (client-side
  filters + `$op` operators), server-side `query()` (gviz), `watch()` (async-generator
  poll + diff). Zero keys on "anyone with the link" sheets.
- **Authenticated CRUD in Node** (`gsab-js/node`): `loopbackAuth()` (reuses the Python gsab CLI's
  bundled OAuth client and token cache — sign in once in a browser), then `createSheet` /
  `insert` / `bulkInsert` / `update` / `delete` / `upsert` / `share`. `update()`/`upsert()`
  write only the **changed cells**, so concurrent edits to different fields of a row are safe.
- **Server deployment auth**: `refreshTokenAuth()` (env-var refresh token, for
  Vercel/serverless/CI) + `deployEnv()` to print the three values it needs.
- **Reactive cache**: `createCache()` — one poller, one snapshot, granular `insert` / `update` /
  `delete` / `change` / `ready` / `sync` / `error` events.
- **React bindings** (`gsab-js/react`): `useSheet(managerOrCache, opts?)` →
  `{ rows, loading, error, cache, refresh }`. React ≥18 optional peer dep; ships `"use client"`.
- **Schema & validation** parity with the Python library (types, required, defaults, primary
  key, min/max, pattern) and the full `GSABError` hierarchy with actionable messages.

Experimental surfaces (API may change): `watch()`, `createCache()`, `useSheet()`.
