import assert from "node:assert/strict";
import { test } from "node:test";

import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>");
(globalThis as any).window = dom.window;
(globalThis as any).document = dom.window.document;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

import React, { act } from "react";
import { createRoot } from "react-dom/client";

import { createCache } from "../src/cache.ts";
import { useSheet } from "../src/react.ts";
import type { UseSheetResult } from "../src/react.ts";

/** Same fake as cache.test.ts: mutate `m.rows`, then refresh() to drive a deterministic diff. */
function fakeManager(rows: any[]) {
  return { schema: { primaryKey: "id" }, rows, async read() { return this.rows; } } as any;
}

/** Render a hook into a probe component; `current` is the latest render's return value. */
function renderHook<T>(useHook: () => T, wrap?: (node: React.ReactNode) => React.ReactNode) {
  const results: T[] = [];
  function Probe() {
    results.push(useHook());
    return null;
  }
  const root = createRoot(document.createElement("div"));
  const node = wrap ? wrap(React.createElement(Probe)) : React.createElement(Probe);
  act(() => root.render(node));
  return {
    get current() {
      return results[results.length - 1];
    },
    unmount: () => act(() => root.unmount()),
  };
}

const flush = () => act(async () => {}); // let the initial start() promise + events settle

test("useSheet loads rows, flips loading, and stops its own poller on unmount", async () => {
  const m = fakeManager([{ id: 1, name: "Ada" }, { id: 2, name: "Linus" }]);
  const hook = renderHook<UseSheetResult>(() => useSheet(m, { key: "id", interval: 60_000 }));

  assert.equal(hook.current.loading, true); // before the first snapshot
  assert.equal(hook.current.rows.length, 0);
  await flush();

  assert.equal(hook.current.loading, false);
  assert.deepEqual(hook.current.rows.map((r) => r.id).sort(), [1, 2]);
  assert.equal(hook.current.error, undefined);
  assert.equal(hook.current.cache.running, true);

  const cache = hook.current.cache;
  hook.unmount();
  assert.equal(cache.running, false); // hook-owned cache is stopped
});

test("useSheet re-renders when the sheet changes", async () => {
  const m = fakeManager([{ id: 1, name: "Ada" }]);
  const hook = renderHook<UseSheetResult>(() => useSheet(m, { key: "id", interval: 60_000 }));
  await flush();

  m.rows = [{ id: 1, name: "Ada2" }, { id: 2, name: "Grace" }];
  await act(async () => hook.current.refresh());

  assert.deepEqual(hook.current.rows, [{ id: 1, name: "Ada2" }, { id: 2, name: "Grace" }]);
  hook.unmount();
});

test("poll errors surface in `error`, keep the last rows, and clear on recovery", async () => {
  const m = fakeManager([{ id: 1 }]);
  const hook = renderHook<UseSheetResult>(() => useSheet(m, { key: "id", interval: 60_000 }));
  await flush();

  m.read = async () => {
    throw new Error("boom");
  };
  await act(async () => hook.current.refresh());
  assert.match(String(hook.current.error), /boom/);
  assert.deepEqual(hook.current.rows, [{ id: 1 }]); // stale rows stay readable

  m.read = async () => [{ id: 1 }]; // recovers with NO diff — `sync` must clear the error
  await act(async () => hook.current.cache.refresh());
  assert.equal(hook.current.error, undefined);
  hook.unmount();
});

test("a failed initial load lands in `error` (loading false) and refresh() retries", async () => {
  const m = fakeManager([]);
  m.read = async () => {
    throw new Error("offline");
  };
  const hook = renderHook<UseSheetResult>(() => useSheet(m, { key: "id", interval: 60_000 }));
  await flush();
  assert.equal(hook.current.loading, false);
  assert.match(String(hook.current.error), /offline/);

  m.read = async () => [{ id: 7 }];
  await act(async () => hook.current.refresh());
  assert.equal(hook.current.error, undefined);
  assert.deepEqual(hook.current.rows, [{ id: 7 }]);
  assert.equal(hook.current.cache.running, true); // refresh() restarted the dead poller
  hook.unmount();
});

test("unmounting while the initial load is in flight neither throws nor keeps polling", async () => {
  let release!: () => void;
  const m = {
    schema: { primaryKey: "id" },
    async read() {
      await new Promise<void>((r) => (release = r));
      return [{ id: 1 }];
    },
  } as any;
  const hook = renderHook<UseSheetResult>(() => useSheet(m, { key: "id", interval: 10 }));
  const cache = hook.current.cache;
  hook.unmount(); // stop() races the pending first read
  release();
  await act(async () => {});
  assert.equal(cache.running, false);
  assert.equal(cache.size, 0); // the superseded start didn't write the snapshot
});

test("a shared SheetCache feeds many components and is never stopped by them", async () => {
  const m = fakeManager([{ id: 1, name: "Ada" }]);
  const cache = createCache(m, { key: "id", interval: 60_000 });
  await cache.start();

  const a = renderHook<UseSheetResult>(() => useSheet(cache));
  const b = renderHook<UseSheetResult>(() => useSheet(cache));
  assert.equal(a.current.loading, false); // cache already running: no false loading state
  assert.deepEqual(a.current.rows, [{ id: 1, name: "Ada" }]);

  m.rows = [{ id: 1, name: "Ada" }, { id: 2, name: "Grace" }];
  await act(async () => cache.refresh());
  assert.equal(a.current.rows.length, 2);
  assert.equal(b.current.rows.length, 2); // one poller, both components updated

  a.unmount();
  b.unmount();
  assert.equal(cache.running, true); // caller owns the lifecycle
  cache.stop();
});

test("a shared cache that is starting (not yet loaded) still reports loading", async () => {
  const m = fakeManager([{ id: 1 }]);
  const cache = createCache(m, { key: "id", interval: 60_000 });
  const started = cache.start(); // NOT awaited — running, but no snapshot yet
  const hook = renderHook<UseSheetResult>(() => useSheet(cache));
  assert.equal(hook.current.loading, true); // running-but-empty must not read as loaded
  await act(async () => started);
  assert.equal(hook.current.loading, false);
  assert.deepEqual(hook.current.rows, [{ id: 1 }]);
  hook.unmount();
  cache.stop();
});

test("a never-started shared cache is started by the hook and left running", async () => {
  const m = fakeManager([{ id: 1 }]);
  const cache = createCache(m, { key: "id", interval: 60_000 });
  const hook = renderHook<UseSheetResult>(() => useSheet(cache));
  await flush();
  assert.deepEqual(hook.current.rows, [{ id: 1 }]);
  hook.unmount();
  assert.equal(cache.running, true); // not owned: the hook never stops it
  cache.stop();
});

test("a deliberately stopped shared cache shows its rows and is NOT restarted", async () => {
  const m = fakeManager([{ id: 1 }]);
  const cache = createCache(m, { key: "id", interval: 60_000 });
  await cache.start();
  cache.stop();
  const hook = renderHook<UseSheetResult>(() => useSheet(cache));
  await flush();
  assert.equal(hook.current.loading, false); // loaded data, not a spinner
  assert.deepEqual(hook.current.rows, [{ id: 1 }]);
  assert.equal(cache.running, false); // the caller stopped it; the hook respects that
  hook.unmount();
});

test("survives React StrictMode double-mounting", async () => {
  const m = fakeManager([{ id: 1 }]);
  const hook = renderHook<UseSheetResult>(
    () => useSheet(m, { key: "id", interval: 60_000 }),
    (node) => React.createElement(React.StrictMode, null, node),
  );
  await flush();
  assert.equal(hook.current.loading, false);
  assert.deepEqual(hook.current.rows, [{ id: 1 }]);
  assert.equal(hook.current.cache.running, true);
  hook.unmount();
  assert.equal(hook.current.cache.running, false);
});
