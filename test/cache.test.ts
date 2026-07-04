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

test("sync fires after every successful refresh, changed or not", async () => {
  const m = fakeManager([{ id: 1 }]);
  const cache = createCache(m, { key: "id", interval: 10_000 });
  const syncs: any[] = [];
  cache.on("sync", (rows) => syncs.push(rows));
  await cache.start();
  assert.equal(syncs.length, 0); // the initial snapshot arrives via `ready`
  await cache.refresh(); // no diff
  await cache.refresh(); // no diff
  m.rows = [{ id: 1 }, { id: 2 }];
  await cache.refresh(); // diff
  assert.equal(syncs.length, 3);
  assert.equal(syncs[2].length, 2);
  m.read = async () => {
    throw new Error("boom");
  };
  await assert.rejects(() => cache.refresh());
  assert.equal(syncs.length, 3); // no sync on a failed poll
  cache.stop();
});

test("a failed start() cleans up so a later start() retries", async () => {
  const m = fakeManager([{ id: 1 }]);
  let calls = 0;
  const rows = m.read.bind(m);
  m.read = async () => {
    if (++calls === 1) throw new Error("offline");
    return rows();
  };
  const cache = createCache(m, { key: "id", interval: 10_000 });
  await assert.rejects(() => cache.start(), /offline/);
  assert.equal(cache.running, false); // not left half-started
  await cache.start(); // retry succeeds
  assert.equal(cache.running, true);
  assert.equal(cache.size, 1);
  cache.stop();
});

test("stop() during a pending start() supersedes it — no snapshot rollback, one ready", async () => {
  const release: Array<() => void> = [];
  const results = [[{ id: 99, stale: true }], [{ id: 1 }]];
  let call = 0;
  const m = {
    schema: { primaryKey: "id" },
    async read() {
      const i = call++;
      await new Promise<void>((r) => release.push(r));
      return results[i];
    },
  } as any;
  const cache = createCache(m, { key: "id", interval: 10_000 });
  let readies = 0;
  cache.on("ready", () => readies++);

  const first = cache.start(); // read #1 in flight (would return stale rows)
  cache.stop();
  const second = cache.start(); // read #2 in flight
  release[1]!(); // resolve #2 first…
  await second;
  release[0]!(); // …then the superseded #1
  await first;

  assert.deepEqual(cache.all(), [{ id: 1 }]); // #1 must NOT roll the snapshot back
  assert.equal(readies, 1); // and must not re-emit ready or spawn a second loop
  assert.equal(cache.running, true);
  cache.stop();
});

test("overlapping refresh() calls share one read (no out-of-order rollback)", async () => {
  const m = fakeManager([{ id: 1 }]);
  let reads = 0;
  const base = m.read.bind(m);
  m.read = async () => {
    reads++;
    return base();
  };
  const cache = createCache(m, { key: "id", interval: 10_000 });
  await cache.start();
  reads = 0;
  await Promise.all([cache.refresh(), cache.refresh(), cache.refresh()]);
  assert.equal(reads, 1);
  cache.stop();
});

test("loaded flips on the first snapshot and survives stop()", async () => {
  const m = fakeManager([{ id: 1 }]);
  const cache = createCache(m, { key: "id", interval: 10_000 });
  assert.equal(cache.loaded, false);
  await cache.start();
  assert.equal(cache.loaded, true);
  cache.stop();
  assert.equal(cache.loaded, true); // the snapshot stays readable, so loaded stays true
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
