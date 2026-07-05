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
import { connect } from "gsab";

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
import { connect, createCache } from "gsab";

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

`gsab/react` turns a sheet into live component state — rows, loading, and error, re-rendered
on every change. No providers, no config:

```jsx
import { connect } from "gsab";
import { useSheet } from "gsab/react";

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
manager. React ≥18 is an optional peer dependency; the `gsab` and `gsab/node` entry points
never load it. Experimental, like the cache it sits on.

## Authenticated CRUD (Node)

Writes (and reads of private sheets) need a Google sign-in. In Node, `loopbackAuth()` reuses
the same OAuth client the [Python `gsab` CLI](https://pypi.org/project/gsab/) installed — sign
in once in the browser; the token is cached after:

```js
import { connect } from "gsab";
import { loopbackAuth } from "gsab/node";

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

`gsab/node` is a **separate entry point**, so importing `gsab` in the browser never pulls in
the Node auth dependencies. Constraints match the Python library: no transactions, and
`unique`/`primaryKey` are enforced read-check-write (concurrent inserts of the same new key
can still race).

### Deploying (Vercel / serverless / CI)

A server has no browser to sign in with, so it uses a long-lived refresh token instead.
Print your credentials **once, on your own machine** (this reuses — or triggers — the same
loopback sign-in):

```sh
node --input-type=module -e "console.log(await (await import('gsab/node')).deployEnv())"
# → { GSAB_CLIENT_ID, GSAB_CLIENT_SECRET, GSAB_REFRESH_TOKEN }   (treat as secrets)
```

Set those three as env vars on your host, and the server code is one line different:

```js
import { connect } from "gsab";
import { refreshTokenAuth } from "gsab/node";

const db = connect({ spreadsheetId, auth: refreshTokenAuth() }).sheet(schema);
```

The default scope is `drive.file`, so the token can only touch sheets gsab created — not the
rest of your Drive. The site's live demo ([gsab.ajmalaksar.com/demo](https://gsab.ajmalaksar.com/demo))
runs exactly this recipe: public no-auth reads in the browser, `refreshTokenAuth()` writes in
Next.js route handlers.

**Concurrent editing:** `update()` writes only the **changed cells**, so two clients editing
*different fields of the same row* at the same time don't clobber each other — only a true
same-*cell* edit is last-write-wins (Sheets has no conditional writes). Combined with
`watch()` (which sees writes from your app, other clients, and people editing the Sheet
directly), a table stays live-collaborative.

## Roadmap

- **Now:** `read` / `query` / `watch` over a public sheet (no auth) · **authenticated CRUD in
  Node** (`createSheet` / `insert` / `bulkInsert` / `update` / `delete` / `upsert` / `share`)
  via loopback OAuth · a **reactive cache** (`createCache` — snapshot + delta dispatch) ·
  **React bindings** (`useSheet` over the cache).
- **Next:** browser auth via Google Identity Services (a Web OAuth client), then a hosted
  sign-in page for near-zero-setup browser auth.
