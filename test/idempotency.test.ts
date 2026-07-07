import assert from "node:assert/strict";
import { test } from "node:test";

import { SheetConnection } from "../src/connection.ts";
import { Schema } from "../src/schema.ts";

const SID = "SHEET_ID";
const schema = new Schema({
  name: "users",
  fields: {
    id: { type: "integer", primaryKey: true },
    name: { type: "string", required: true },
    plan: { type: "string", default: "free" },
  },
});

// header + one row (id 1, Ada, pro)
const GRID = [
  ["id", "name", "plan"],
  ["1", "Ada", "pro"],
];

interface Call {
  url: string;
  method: string;
  body: any;
}

/** Fake fetch routing Sheets calls, distinguishing the full-grid read from the header (1:1)
 *  read and the spreadsheet-meta (tab titles) read, so we can assert provisioning + upsert. */
function installFetch(opts: { grid?: unknown[][]; tabs?: string[] } = {}) {
  const { grid = GRID, tabs = ["users"] } = opts;
  const calls: Call[] = [];
  const orig = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL, init: RequestInit = {}) => {
    const u = String(url);
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url: u, method, body });
    let json: unknown = {};
    if (u.includes("fields=sheets.properties.title")) {
      json = { sheets: tabs.map((t) => ({ properties: { title: t } })) };
    } else if (u.includes("/values/") && method === "GET") {
      json = u.includes("1%3A1") ? { values: [grid[0] ?? []] } : { values: grid };
    }
    return new Response(JSON.stringify(json), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = orig) };
}

function boundDb() {
  const conn = new SheetConnection({ spreadsheetId: SID, auth: { getToken: async () => "TOK" } });
  return conn.sheet(schema);
}

test("insertIdempotent appends a brand-new key", async () => {
  const db = boundDb();
  const { calls, restore } = installFetch();
  try {
    assert.equal(await db.insertIdempotent({ id: 2, name: "Linus" }), "inserted");
    assert.ok(calls.some((c) => c.url.includes(":append")));
  } finally {
    restore();
  }
});

test("insertIdempotent is a no-op for an existing key — no append (retry-safe)", async () => {
  const db = boundDb();
  const { calls, restore } = installFetch();
  try {
    // a string key still matches the stored numeric id 1
    assert.equal(await db.insertIdempotent({ id: "1", name: "Dup" }), "exists");
    assert.ok(!calls.some((c) => c.url.includes(":append")));
  } finally {
    restore();
  }
});

test("bulkUpsert splits updates vs inserts against ONE grid read", async () => {
  const db = boundDb();
  const { calls, restore } = installFetch();
  try {
    const r = await db.bulkUpsert([
      { id: 1, plan: "team" }, // exists → update
      { id: 2, name: "Linus" }, // new → insert
    ]);
    assert.deepEqual(r, { inserted: 1, updated: 1 });
    const gridReads = calls.filter(
      (c) => c.url.includes("/values/") && c.method === "GET" && !c.url.includes("1%3A1"),
    );
    assert.equal(gridReads.length, 1); // the whole batch shares one read
    assert.ok(calls.some((c) => c.url.endsWith("/values:batchUpdate"))); // the update
    assert.ok(calls.some((c) => c.url.includes(":append"))); // the insert
  } finally {
    restore();
  }
});

test("ensureTab adds a missing tab and writes its header row", async () => {
  const conn = new SheetConnection({ spreadsheetId: SID, auth: { getToken: async () => "TOK" } });
  const db = conn.sheet(
    new Schema({ name: "tx_u1", fields: { id: { type: "integer", primaryKey: true }, amt: { type: "float" } } }),
  );
  const { calls, restore } = installFetch({ tabs: ["users"], grid: [[]] });
  try {
    await db.ensureTab();
    const add = calls.find((c) => c.url.endsWith(`${SID}:batchUpdate`));
    assert.equal(add!.body.requests[0].addSheet.properties.title, "tx_u1");
    const header = calls.find((c) => c.method === "PUT");
    assert.deepEqual(header!.body.values, [["id", "amt"]]);
  } finally {
    restore();
  }
});

test("ensureTab is a no-op when the tab and header already exist", async () => {
  const db = boundDb();
  const { calls, restore } = installFetch(); // tab "users" present, header non-empty
  try {
    await db.ensureTab();
    assert.ok(!calls.some((c) => c.url.endsWith(`${SID}:batchUpdate`)));
    assert.ok(!calls.some((c) => c.method === "PUT"));
  } finally {
    restore();
  }
});

test("ensureTab appends schema fields missing from an existing header (schema evolution)", async () => {
  const conn = new SheetConnection({ spreadsheetId: SID, auth: { getToken: async () => "TOK" } });
  const db = conn.sheet(
    new Schema({
      name: "users",
      fields: {
        id: { type: "integer", primaryKey: true },
        name: { type: "string" },
        plan: { type: "string" },
        tier: { type: "string" }, // new field, not in the live header
      },
    }),
  );
  const { calls, restore } = installFetch(); // live header is [id, name, plan]
  try {
    await db.ensureTab();
    const put = calls.find((c) => c.method === "PUT");
    assert.deepEqual(put!.body.values, [["id", "name", "plan", "tier"]]); // appended, not reordered
  } finally {
    restore();
  }
});

test("listTabs returns the worksheet titles", async () => {
  const db = boundDb();
  const { restore } = installFetch({ tabs: ["users", "tx_u1", "tx_u2"] });
  try {
    assert.deepEqual(await db.listTabs(), ["users", "tx_u1", "tx_u2"]);
  } finally {
    restore();
  }
});
