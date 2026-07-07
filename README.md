# gsab — Google Sheets as a Backend (JavaScript / TypeScript)

A lightweight client that treats a Google Spreadsheet like a database: CRUD, server-side
queries, and realtime `watch()`, in the **browser** and **Node**. Companion to the Python
library ([`gsab` on PyPI](https://pypi.org/project/gsab/)).

- Docs: https://gsab.ajmalaksar.com
- Status: **early** (`0.1.0`) — no-auth public reads **and authenticated CRUD in Node** work today; browser (GIS) auth is next.

## No-auth public read (zero setup)

Reading a **public** ("anyone with the link") sheet needs no OAuth and no API key — it runs
in a plain browser page or in Node:

```js
import { connect } from "gsab-js";

const db = connect("https://docs.google.com/spreadsheets/d/<ID>/edit").sheet();

const rows = await db.read();                          // every row
const pro  = await db.read({ plan: "pro" });           // client-side filter
const top  = await db.query("SELECT A, D ORDER BY D DESC LIMIT 10"); // server-side gviz

for await (const change of db.watch({ interval: 2000 })) {
  console.log(change); // { added, updated, removed }
}
```

## Reactive cache

`createCache(db)` keeps one in-memory snapshot of a sheet, polls + diffs, and dispatches
granular events — one poller feeds many listeners (cheaper than each view re-reading). Works
over a public sheet with no auth:

```js
import { connect, createCache } from "gsab-js";

const db = connect("https://docs.google.com/spreadsheets/d/<ID>/edit").sheet();
const cache = createCache(db, { key: "id", interval: 2000 });

cache.on("insert", (row) => console.log("added", row));
cache.on("update", (row, prev) => console.log("changed", prev, "→", row));
cache.on("delete", (row) => console.log("removed", row));
cache.on("sync",   (rows) => {});  // after EVERY successful poll, changed or not
cache.on("error",  (err) => {});   // a poll failed (polling continues)

await cache.start();     // resolves once the initial snapshot is loaded ("ready")
cache.all();             // current rows;  cache.get(1);  cache.size;  cache.running
cache.stop();            // stop polling (the snapshot stays readable)
```

Experimental — polling (~1–2s), not push (same envelope as `watch()`).

## React bindings (`useSheet`)

`gsab-js/react` turns a sheet into live component state — rows, loading, and error, re-rendered
on every change. No providers, no config:

```jsx
import { connect } from "gsab-js";
import { useSheet } from "gsab-js/react";

const db = connect("https://docs.google.com/spreadsheets/d/<ID>/edit").sheet();

function Users() {
  const { rows, loading, error } = useSheet(db, { key: "id" });
  if (loading) return <p>Loading…</p>;
  if (error) return <p>Sheet unreachable — showing the last known rows.</p>;
  return <ul>{rows.map((r) => <li key={String(r.id)}>{String(r.name)}</li>)}</ul>;
}
```

(In TypeScript, type the rows with `useSheet<User>(db, ...)` — rows are `Record<string,
unknown>` otherwise.)

Passing a manager gives the component its own poller (started on mount, stopped on unmount).
To share **one** poller across many components, create the cache yourself and pass it in —
a never-started cache is started for you (and left running); one you stopped stays stopped,
and the hook never stops a cache it didn't create:

```js
const cache = createCache(db, { key: "id" });  // app level (or via context)
const { rows } = useSheet(cache);              // any number of components
```

`useSheet` also returns `refresh()` (re-read now) and the underlying `cache` (escape hatch
for `get()` / `on()`). Works with any auth tier — public read-only sheets or an authed
manager. React ≥18 is an optional peer dependency; the `gsab` and `gsab-js/node` entry points
never load it. Experimental, like the cache it sits on.

## Authenticated CRUD (Node)

Writes (and reads of private sheets) need a Google sign-in. In Node, `loopbackAuth()` reuses
the same OAuth client the [Python `gsab` CLI](https://pypi.org/project/gsab/) installed — sign
in once in the browser; the token is cached after:

```js
import { connect } from "gsab-js";
import { loopbackAuth } from "gsab-js/node";

const schema = {
  name: "users",
  fields: {
    id: { type: "integer", primaryKey: true },
    name: { type: "string", required: true },
    plan: { type: "string", default: "free" },
  },
};

const db = connect({ auth: await loopbackAuth() }).sheet(schema);

const id = await db.createSheet("My App DB");    // creates the spreadsheet, returns its id
await db.insert({ id: 1, name: "Ada", plan: "pro" });
await db.bulkInsert([{ id: 2, name: "Linus" }]);
await db.upsert({ id: 1, plan: "team" });        // insert-or-update on the primary key
await db.update({ id: 2 }, { plan: "team" });
await db.delete({ id: 2 });
const url = await db.share("reader");            // public link (reader | commenter | writer)
```

`gsab-js/node` is a **separate entry point**, so importing `gsab` in the browser never pulls in
the Node auth dependencies. Constraints match the Python library: no transactions, and
`unique`/`primaryKey` are enforced read-check-write (concurrent inserts of the same new key
can still race).

### Deploying (Vercel / serverless / CI)

A server has no browser to sign in with, so it uses a long-lived refresh token instead.
One command on your own machine (it reuses — or triggers — the same loopback sign-in), **one
env var** on the host:

```sh
npx gsab-js env
# GSAB_CREDENTIALS=…        ← set this one value on Vercel / Netlify / CI (it's a secret)
```

And the server code is one line different:

```js
import { connect } from "gsab-js";
import { refreshTokenAuth } from "gsab-js/node";

const db = connect({ spreadsheetId, auth: refreshTokenAuth() }).sheet(schema);
```

Debugging a deploy? `npx gsab-js doctor` (in that environment) says what's configured and
does a real token refresh. Prefer separate variables? `npx gsab-js env --split` prints the
`GSAB_CLIENT_ID` / `GSAB_CLIENT_SECRET` / `GSAB_REFRESH_TOKEN` trio, which
`refreshTokenAuth()` also accepts.

**If it leaks:** the credential is scoped to `drive.file` — it can only touch sheets gsab
created, never the rest of your Drive — and you can revoke it any time at
myaccount.google.com → Security → Third-party access. Keep it in your host's secret store;
never commit it. The site's live demo
([gsab.ajmalaksar.com/demo](https://gsab.ajmalaksar.com/demo)) runs exactly this recipe:
public no-auth reads in the browser, `refreshTokenAuth()` writes in Next.js route handlers.

**Concurrent editing:** `update()` writes only the **changed cells**, so two clients editing
*different fields of the same row* at the same time don't clobber each other — only a true
same-*cell* edit is last-write-wins (Sheets has no conditional writes). Combined with
`watch()` (which sees writes from your app, other clients, and people editing the Sheet
directly), a table stays live-collaborative.

## Teach your coding agent

A ready-made agent skill ships with the package (`skills/gsab-js/`) — quickstarts, the deploy
recipe, and the rules of thumb (rate limits, per-cell writes, error types). Install it for
Claude Code (or any skills-aware agent):

```bash
npx degit ajmalaksar25/gsab-js/skills/gsab-js ~/.claude/skills/gsab-js
# or, from a project that already has gsab-js installed:
cp -r node_modules/gsab-js/skills/gsab-js ~/.claude/skills/
```

The docs are also agent-friendly directly: every page has a raw-Markdown twin
(`https://gsab.ajmalaksar.com/docs/javascript.md`) and the whole set is indexed at
[/llms.txt](https://gsab.ajmalaksar.com/llms.txt).

## Roadmap

- **Now:** `read` / `query` / `watch` over a public sheet (no auth) · **authenticated CRUD in
  Node** (`createSheet` / `insert` / `bulkInsert` / `update` / `delete` / `upsert` / `share`)
  via loopback OAuth · a **reactive cache** (`createCache` — snapshot + delta dispatch) ·
  **React bindings** (`useSheet` over the cache).
- **Next:** browser auth via Google Identity Services (a Web OAuth client), then a hosted
  sign-in page for near-zero-setup browser auth.
- **Known gap — concurrent-writer row race:** `update`/`bulkUpsert` target cells by row index
  from an earlier grid read; a concurrent insert/delete by another writer shifts rows between
  read and write, and a targeted cell write can land on the wrong row (observed in production:
  a neighbouring row's cell overwritten). Planned fix: verify the primary-key cell of every
  target row in the same batch (or re-read + retry on mismatch) before writing. Until then,
  avoid two writers on one tab at the same moment.
