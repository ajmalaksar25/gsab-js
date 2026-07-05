# Changelog

## 0.1.1 — 2026-07-05

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
