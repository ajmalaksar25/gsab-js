import assert from "node:assert/strict";
import { test } from "node:test";

import { createCache } from "../src/cache.ts";

/** A minimal fake SheetManager: a mutable `rows` array + a schema for keying. Reassign
 *  `m.rows` then call `cache.refresh()` to drive a deterministic diff (no network, no timers). */
function fakeManager(rows: any[]) {
  return { schema: { primaryKey: "id" }, rows, async read() { return this.rows; } } as any;
}

test("start loads the initial snapshot and fires ready (no per-row insert spam)", async () => {
  const m = fakeManager([{ id: 1, name: "Ada" }, { id: 2, name: "Linus" }]);
  const cache = createCache(m, { key: "id", interval: 10_000 });
  let readyRows: any[] | undefined;
  let inserts = 0;
  cache.on("ready", (rows) => (readyRows = rows));
  cache.on("insert", () => inserts++);
  await cache.start();
  assert.equal(cache.size, 2);
  assert.deepEqual(readyRows!.map((r) => r.id).sort(), [1, 2]);
  assert.deepEqual(cache.get(1), { id: 1, name: "Ada" });
  assert.equal(inserts, 0); // initial rows arrive via `ready`, not as inserts
  cache.stop();
});

test("refresh diffs and emits insert / update / delete + a change batch", async () => {
  const m = fakeManager([{ id: 1, name: "Ada" }, { id: 2, name: "Linus" }]);
  const cache = createCache(m, { key: "id", interval: 10_000 });
  const ev: Record<string, any[]> = { insert: [], update: [], delete: [], change: [] };
  cache.on("insert", (r) => ev.insert.push(r));
  cache.on("update", (r, prev) => ev.update.push([r, prev]));
  cache.on("delete", (r) => ev.delete.push(r));
  cache.on("change", (c) => ev.change.push(c));
  await cache.start();

  m.rows = [{ id: 1, name: "Ada2" }, { id: 3, name: "Grace" }]; // change 1, add 3, drop 2
  await cache.refresh();

  assert.deepEqual(ev.insert, [{ id: 3, name: "Grace" }]);
  assert.deepEqual(ev.update, [[{ id: 1, name: "Ada2" }, { id: 1, name: "Ada" }]]);
  assert.deepEqual(ev.delete, [{ id: 2, name: "Linus" }]);
  assert.equal(ev.change.length, 1);
  assert.deepEqual(ev.change[0], {
    added: [{ id: 3, name: "Grace" }],
    updated: [{ id: 1, name: "Ada2" }],
    removed: [{ id: 2, name: "Linus" }],
  });
  assert.deepEqual(cache.all().map((r) => r.id).sort(), [1, 3]);
  cache.stop();
});

test("unsubscribe stops delivering events", async () => {
  const m = fakeManager([{ id: 1 }]);
  const cache = createCache(m, { key: "id" });
  let count = 0;
  const off = cache.on("insert", () => count++);
  await cache.start();
  m.rows = [{ id: 1 }, { id: 2 }];
  await cache.refresh();
  assert.equal(count, 1);
  off();
  m.rows = [{ id: 1 }, { id: 2 }, { id: 3 }];
  await cache.refresh();
  assert.equal(count, 1); // no longer subscribed
  cache.stop();
});

test("a throwing listener doesn't break the loop or other listeners", async () => {
  const m = fakeManager([{ id: 1 }]);
  const cache = createCache(m, { key: "id" });
  cache.on("insert", () => {
    throw new Error("boom");
  });
  let ok = 0;
  cache.on("insert", () => ok++);
  await cache.start();
  m.rows = [{ id: 1 }, { id: 2 }];
  await cache.refresh();
  assert.equal(ok, 1);
  cache.stop();
});
