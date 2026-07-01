import assert from "node:assert/strict";
import { test } from "node:test";

import { SheetConnection } from "../src/connection.ts";
import { DuplicateKeyError } from "../src/errors.ts";
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

// Default grid: header + one row (id 1, Ada, pro).
const GRID = [
  ["id", "name", "plan"],
  ["1", "Ada", "pro"],
];

interface Call {
  url: string;
  method: string;
  body: any;
}

/** Install a fake global fetch that routes Sheets/Drive calls to canned JSON and records
 *  every request, so we can assert the exact write the manager issued. */
function installFetch(grid: unknown[][] = GRID) {
  const calls: Call[] = [];
  const orig = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL, init: RequestInit = {}) => {
    const u = String(url);
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url: u, method, body });
    let json: unknown = {};
    if (u.endsWith("/v4/spreadsheets") && method === "POST") json = { spreadsheetId: "NEW_ID" };
    else if (u.includes("?fields=sheets.properties"))
      json = { sheets: [{ properties: { sheetId: 0, title: "users" } }] };
    else if (u.includes("/drive/v3/") && method === "GET")
      json = { permissions: [{ id: "perm1", type: "anyone" }] };
    else if (u.includes("/drive/v3/") && method === "POST") json = { id: "perm1" };
    else if (u.includes("/values/") && method === "GET") json = { values: grid };
    // append / values:batchUpdate / :batchUpdate / PUT header / DELETE -> {}
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

test("createSheet posts a create + writes the header row + binds the id", async () => {
  const conn = new SheetConnection({ auth: { getToken: async () => "TOK" } }); // unbound
  const db = conn.sheet(schema);
  const { calls, restore } = installFetch();
  try {
    const id = await db.createSheet("My DB");
    assert.equal(id, "NEW_ID");
    assert.equal(conn.spreadsheetId, "NEW_ID");
    const create = calls.find((c) => c.url.endsWith("/v4/spreadsheets") && c.method === "POST");
    assert.equal(create!.body.properties.title, "My DB");
    assert.equal(create!.body.sheets[0].properties.title, "users");
    const header = calls.find((c) => c.method === "PUT");
    assert.deepEqual(header!.body.values, [["id", "name", "plan"]]);
  } finally {
    restore();
  }
});

test("insert appends a coerced row with defaults and enforces the primary key", async () => {
  const db = boundDb();
  const { calls, restore } = installFetch();
  try {
    await db.insert({ id: 2, name: "Linus" }); // plan defaults to "free"
    const append = calls.find((c) => c.url.includes(":append"));
    assert.deepEqual(append!.body.values, [[2, "Linus", "free"]]);
  } finally {
    restore();
  }
});

test("insert rejects a duplicate primary key with DuplicateKeyError", async () => {
  const db = boundDb();
  const { restore } = installFetch();
  try {
    await assert.rejects(() => db.insert({ id: 1, name: "Clone" }), DuplicateKeyError);
  } finally {
    restore();
  }
});

test("bulkInsert appends many rows and returns the count", async () => {
  const db = boundDb();
  const { calls, restore } = installFetch();
  try {
    const n = await db.bulkInsert([
      { id: 2, name: "Linus" },
      { id: 3, name: "Grace", plan: "pro" },
    ]);
    assert.equal(n, 2);
    const append = calls.find((c) => c.url.includes(":append"));
    assert.deepEqual(append!.body.values, [
      [2, "Linus", "free"],
      [3, "Grace", "pro"],
    ]);
  } finally {
    restore();
  }
});

test("update rewrites matching rows and returns the count", async () => {
  const db = boundDb();
  const { calls, restore } = installFetch();
  try {
    const n = await db.update({ id: 1 }, { plan: "team" });
    assert.equal(n, 1);
    const batch = calls.find((c) => c.url.endsWith("/values:batchUpdate"));
    assert.equal(batch!.body.data[0].range, "'users'!A2"); // row 2 (row 1 is the header)
    assert.deepEqual(batch!.body.data[0].values, [[1, "Ada", "team"]]); // merged, coerced
  } finally {
    restore();
  }
});

test("delete removes matching rows bottom-up via deleteDimension", async () => {
  const db = boundDb();
  const grid = [
    ["id", "name", "plan"],
    ["1", "Ada", "free"],
    ["2", "Linus", "free"],
    ["3", "Grace", "free"],
  ];
  const { calls, restore } = installFetch(grid);
  try {
    const n = await db.delete({ plan: "free" }); // matches rows 2,3,4
    assert.equal(n, 3);
    const del = calls.find((c) => c.url.endsWith(`${SID}:batchUpdate`));
    const starts = del!.body.requests.map((r: any) => r.deleteDimension.range.startIndex);
    assert.deepEqual(starts, [3, 2, 1]); // descending: bottom-up, 0-based (sheet rows 4,3,2)
  } finally {
    restore();
  }
});

test("upsert updates an existing key and inserts a new one", async () => {
  const db = boundDb();
  {
    const { calls, restore } = installFetch();
    try {
      assert.equal(await db.upsert({ id: 1, plan: "team" }), "updated");
      assert.ok(calls.some((c) => c.url.endsWith("/values:batchUpdate")));
    } finally {
      restore();
    }
  }
  {
    const { calls, restore } = installFetch();
    try {
      assert.equal(await db.upsert({ id: 9, name: "New" }), "inserted");
      assert.ok(calls.some((c) => c.url.includes(":append")));
    } finally {
      restore();
    }
  }
});

test("string keys/filters coerce to match a stored integer column", async () => {
  // Values from LLM/MCP callers, URLs and forms arrive as strings; they must line up with
  // the schema-coerced (numeric) stored values instead of silently missing.
  const db = boundDb();
  {
    // upsert with a string key must UPDATE the stored numeric id 1, not insert a duplicate.
    const { calls, restore } = installFetch();
    try {
      assert.equal(await db.upsert({ id: "1", plan: "team" }), "updated");
      assert.ok(calls.some((c) => c.url.endsWith("/values:batchUpdate")));
      assert.ok(!calls.some((c) => c.url.includes(":append")));
    } finally {
      restore();
    }
  }
  {
    // insert with a string key colliding with the stored numeric id must be rejected.
    const { restore } = installFetch();
    try {
      await assert.rejects(() => db.insert({ id: "1", name: "Clone" }), DuplicateKeyError);
    } finally {
      restore();
    }
  }
  {
    // update with a string filter must match the numeric row.
    const { calls, restore } = installFetch();
    try {
      assert.equal(await db.update({ id: "1" }, { plan: "team" }), 1);
      assert.ok(calls.some((c) => c.url.endsWith("/values:batchUpdate")));
    } finally {
      restore();
    }
  }
  {
    // $in with a string element must match the numeric row on delete.
    const { calls, restore } = installFetch();
    try {
      assert.equal(await db.delete({ id: { $in: ["1"] } }), 1);
      assert.ok(calls.some((c) => c.url.endsWith(`${SID}:batchUpdate`)));
    } finally {
      restore();
    }
  }
});

test("share creates an anyone permission (editor -> writer) and returns the URL", async () => {
  const db = boundDb();
  const { calls, restore } = installFetch();
  try {
    const url = await db.share("editor");
    assert.equal(url, `https://docs.google.com/spreadsheets/d/${SID}/edit`);
    const perm = calls.find((c) => c.url.includes("/permissions") && c.method === "POST");
    assert.deepEqual(perm!.body, { type: "anyone", role: "writer" });
  } finally {
    restore();
  }
});
