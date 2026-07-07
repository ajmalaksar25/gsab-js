import assert from "node:assert/strict";
import { test } from "node:test";

import { SheetConnection } from "../src/connection.ts";
import { ConcurrencyError } from "../src/errors.ts";
import { Schema } from "../src/schema.ts";

const SID = "SHEET_ID";
const schema = new Schema({
  name: "users",
  fields: {
    id: { type: "integer", primaryKey: true },
    name: { type: "string", required: true },
  },
});

interface Call { url: string; method: string; body: any }

/** Fake fetch where the sheet "shifts" under the writer: grid reads and key-column reads are
 *  served from a mutable script so tests can simulate a concurrent insert between them. */
function installFetch(opts: { grids: unknown[][][]; keyCols: unknown[][][] }) {
  const calls: Call[] = [];
  let gridN = 0;
  let keyColN = 0;
  const orig = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL, init: RequestInit = {}) => {
    const u = String(url);
    const method = init.method ?? "GET";
    calls.push({ url: u, method, body: init.body ? JSON.parse(String(init.body)) : undefined });
    let json: unknown = {};
    if (u.includes("A%3AA")) {
      json = { values: opts.keyCols[Math.min(keyColN++, opts.keyCols.length - 1)] };
    } else if (u.includes("/values/") && method === "GET") {
      json = { values: opts.grids[Math.min(gridN++, opts.grids.length - 1)] };
    }
    return new Response(JSON.stringify(json), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = orig) };
}

function db() {
  const conn = new SheetConnection({ spreadsheetId: SID, auth: { getToken: async () => "TOK" } });
  return conn.sheet(schema);
}

test("bulkUpsert re-reads and retargets when rows shifted under a concurrent writer", async () => {
  const gridBefore = [["id", "name"], ["1", "Ada"]];
  const gridAfter = [["id", "name"], ["9", "New"], ["1", "Ada"]]; // a row landed above Ada
  const { calls, restore } = installFetch({
    grids: [gridBefore, gridAfter],
    // First verify sees the shifted column (row2 is now 9) → drift; second matches gridAfter.
    keyCols: [[["id"], ["9"], ["1"]], [["id"], ["9"], ["1"]]],
  });
  try {
    const r = await db().bulkUpsert([{ id: 1, name: "Updated" }]);
    assert.deepEqual(r, { inserted: 0, updated: 1 });
    const write = calls.find((c) => c.url.endsWith("/values:batchUpdate"));
    // Ada moved to sheet row 3 — the write must target row 3, not the stale row 2.
    assert.ok(write!.body.data.every((d: any) => d.range.endsWith("3")), JSON.stringify(write!.body.data));
  } finally {
    restore();
  }
});

test("bulkUpsert gives up with ConcurrencyError when the sheet keeps shifting", async () => {
  const grid = [["id", "name"], ["1", "Ada"]];
  const { restore } = installFetch({
    grids: [grid, grid, grid],
    keyCols: [[["id"], ["999"]]], // key cell never matches what the grid promised
  });
  try {
    await assert.rejects(
      () => db().bulkUpsert([{ id: 1, name: "Updated" }]),
      (e: unknown) => e instanceof ConcurrencyError && (e as ConcurrencyError).retryable,
    );
  } finally {
    restore();
  }
});

test("update verifies by primary key and retries once on drift", async () => {
  const gridBefore = [["id", "name"], ["1", "Ada"]];
  const gridAfter = [["id", "name"], ["9", "New"], ["1", "Ada"]];
  const { calls, restore } = installFetch({
    grids: [gridBefore, gridAfter],
    keyCols: [[["id"], ["9"], ["1"]], [["id"], ["9"], ["1"]]],
  });
  try {
    const n = await db().update({ id: 1 }, { name: "Renamed" });
    assert.equal(n, 1);
    const write = calls.find((c) => c.url.endsWith("/values:batchUpdate"));
    assert.ok(write!.body.data.every((d: any) => d.range.endsWith("3")));
  } finally {
    restore();
  }
});
