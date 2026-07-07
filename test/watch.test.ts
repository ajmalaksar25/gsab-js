import assert from "node:assert/strict";
import { test } from "node:test";

import { SheetConnection } from "../src/connection.ts";
import { Schema } from "../src/schema.ts";

const schema = new Schema({
  name: "t",
  fields: { id: { type: "integer", primaryKey: true }, name: { type: "string" } },
});

/** Serve a scripted sequence of gviz snapshots so watch()'s diff can be exercised. */
function installGviz(snapshots: { id: number; name: string }[][]) {
  let i = 0;
  const orig = globalThis.fetch;
  globalThis.fetch = (async () => {
    const snap = snapshots[Math.min(i, snapshots.length - 1)];
    i++;
    const body = `google.visualization.Query.setResponse(${JSON.stringify({
      table: {
        cols: [
          { label: "id", id: "A" },
          { label: "name", id: "B" },
        ],
        rows: snap.map((r) => ({ c: [{ v: r.id }, { v: r.name }] })),
      },
    })})`;
    return new Response(body, { status: 200 });
  }) as typeof fetch;
  return () => (globalThis.fetch = orig);
}

test("watch emits initial rows, then added / updated / removed diffs across polls", async () => {
  const restore = installGviz([
    [{ id: 1, name: "Ada" }], // initial
    [{ id: 1, name: "Ada" }, { id: 2, name: "Linus" }], // +2
    [{ id: 2, name: "Linus2" }], // -1, 2 renamed
  ]);
  try {
    const db = new SheetConnection("SID").sheet(schema);
    const changes = [];
    for await (const c of db.watch({ interval: 1 })) {
      changes.push(c);
      if (changes.length >= 3) break;
    }
    assert.deepEqual(
      changes[0].added.map((r) => r.id),
      [1],
    ); // emitInitial
    assert.deepEqual(
      changes[1].added.map((r) => r.id),
      [2],
    );
    assert.deepEqual(
      changes[2].removed.map((r) => r.id),
      [1],
    );
    assert.deepEqual(
      changes[2].updated.map((r) => r.id),
      [2],
    );
  } finally {
    restore();
  }
});
