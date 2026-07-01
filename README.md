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

## Roadmap

- **Now:** `read` / `query` / `watch` over a public sheet (no auth) **+ authenticated CRUD in
  Node** (`createSheet` / `insert` / `bulkInsert` / `update` / `delete` / `upsert` / `share`)
  via loopback OAuth.
- **Next:** browser auth via Google Identity Services (a Web OAuth client), then a hosted
  sign-in page for near-zero-setup browser auth.
- **Later:** a reactive cache (one snapshot + delta dispatch) and React bindings (`useSheet`).
