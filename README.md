# gsab — Google Sheets as a Backend (JavaScript / TypeScript)

A lightweight client that treats a Google Spreadsheet like a database: CRUD, server-side
queries, and realtime `watch()`, in the **browser** and **Node**. Companion to the Python
library ([`gsab` on PyPI](https://pypi.org/project/gsab/)).

- Docs: https://gsab.ajmalaksar.com
- Status: **pre-release** (`0.0.0`) — the no-auth read tier works today; authenticated CRUD is in progress.

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

## Roadmap

- **Now:** `read` / `query` / `watch` over a public sheet (no auth).
- **Next:** authenticated CRUD — `insert` / `update` / `delete` / `upsert` / `share`.
  Node uses the same loopback OAuth as the Python CLI; the browser uses Google Identity
  Services (a Web OAuth client).
- **Later:** a reactive cache (one snapshot + delta dispatch), React bindings (`useSheet`),
  and a hosted sign-in page for near-zero-setup browser auth.
