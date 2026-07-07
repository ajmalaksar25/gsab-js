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
import { DuplicateKeyError } from "../src/errors.ts";
import { Schema } from "../src/schema.ts";
import { SheetForm, SheetTable, useSheetForm } from "../src/react.ts";
import type { UseSheetFormResult } from "../src/react.ts";

const users = new Schema({
  name: "users",
  fields: {
    id: { type: "integer", primaryKey: true, minValue: 1 },
    name: { type: "string", required: true, minLength: 2 },
    active: { type: "boolean", default: true },
  },
});

/** A fake SheetManager: records what insert()/upsert() got, serves `rows` to read(). */
function fakeSheet(extra: Record<string, unknown> = {}) {
  return {
    schema: users,
    inserted: [] as any[],
    upserts: [] as any[],
    rows: [] as any[],
    async read() {
      return (this as any).rows;
    },
    async insert(r: any) {
      (this as any).inserted.push(r);
    },
    async upsert(r: any) {
      (this as any).upserts.push(r);
      return "inserted";
    },
    ...extra,
  } as any;
}

/** Render a hook into a probe; `current` is the latest render's return value. */
function renderHook<T>(useHook: () => T) {
  const results: T[] = [];
  function Probe() {
    results.push(useHook());
    return null;
  }
  const root = createRoot(document.createElement("div"));
  act(() => root.render(React.createElement(Probe)));
  return {
    get current() {
      return results[results.length - 1];
    },
    unmount: () => act(() => root.unmount()),
  };
}

/** Render a component into a detached container and hand back the DOM. */
function render(node: React.ReactNode) {
  const container = document.createElement("div");
  const root = createRoot(container);
  act(() => root.render(node));
  return { container, unmount: () => act(() => root.unmount()) };
}

const flush = () => act(async () => {});

test("useSheetForm seeds values from schema + initialValues", () => {
  const sheet = fakeSheet();
  const hook = renderHook<UseSheetFormResult>(() => useSheetForm(sheet, { initialValues: { name: "Ada" } }));
  assert.equal(hook.current.values.name, "Ada");
  assert.equal(hook.current.values.id, ""); // no seed -> empty string
  assert.equal(hook.current.values.active, true); // boolean default seed
  assert.deepEqual(hook.current.fields, ["id", "name", "active"]);
  hook.unmount();
});

test("useSheetForm blocks the write and reports per-field errors when invalid", async () => {
  const sheet = fakeSheet();
  const hook = renderHook<UseSheetFormResult>(() => useSheetForm(sheet));
  let ok: boolean | undefined;
  await act(async () => {
    ok = await hook.current.submit();
  });
  assert.equal(ok, false);
  assert.ok(hook.current.errors.id); // required primary key missing
  assert.ok(hook.current.errors.name); // required missing
  assert.equal(sheet.inserted.length, 0);
  hook.unmount();
});

test("useSheetForm inserts a valid record, marks submitted, and resets", async () => {
  const sheet = fakeSheet();
  const hook = renderHook<UseSheetFormResult>(() => useSheetForm(sheet));
  await act(async () => hook.current.setField("id", "7"));
  await act(async () => hook.current.setField("name", "Ada"));
  let ok: boolean | undefined;
  await act(async () => {
    ok = await hook.current.submit();
  });
  assert.equal(ok, true);
  assert.equal(sheet.inserted.length, 1);
  assert.deepEqual(sheet.inserted[0], { id: "7", name: "Ada", active: true });
  assert.equal(hook.current.submitted, true);
  assert.equal(hook.current.values.name, ""); // reset after insert
  hook.unmount();
});

test("useSheetForm upsert mode routes to upsert() and does not reset", async () => {
  const sheet = fakeSheet();
  const hook = renderHook<UseSheetFormResult>(() =>
    useSheetForm(sheet, { mode: "upsert", initialValues: { id: 3, name: "Grace" } }),
  );
  let ok: boolean | undefined;
  await act(async () => {
    ok = await hook.current.submit();
  });
  assert.equal(ok, true);
  assert.equal(sheet.upserts.length, 1);
  assert.equal(sheet.inserted.length, 0);
  assert.equal(hook.current.values.name, "Grace"); // upsert does not reset by default
  hook.unmount();
});

test("useSheetForm surfaces a write error (e.g. duplicate key)", async () => {
  const sheet = fakeSheet({
    async insert() {
      throw new DuplicateKeyError("Duplicate value for unique field 'id'.");
    },
  });
  const hook = renderHook<UseSheetFormResult>(() => useSheetForm(sheet));
  await act(async () => hook.current.setField("id", "1"));
  await act(async () => hook.current.setField("name", "Ada"));
  let ok: boolean | undefined;
  await act(async () => {
    ok = await hook.current.submit();
  });
  assert.equal(ok, false);
  assert.ok(hook.current.error instanceof DuplicateKeyError);
  hook.unmount();
});

test("SheetForm renders one typed, labelled input per field plus a submit button", () => {
  const sheet = fakeSheet();
  const { container, unmount } = render(React.createElement(SheetForm, { sheet }));
  assert.equal(container.querySelectorAll(".gsab-field").length, 3);
  assert.ok(container.querySelector('input[data-field="id"][type="number"]'));
  assert.ok(container.querySelector('input[data-field="name"][type="text"]'));
  assert.ok(container.querySelector('input[data-field="active"][type="checkbox"]'));
  assert.ok(container.querySelector("button[type=submit]"));
  const idLabel = container.querySelector('label[for="gsab-users-id"]');
  assert.match(idLabel!.textContent!, /\*/); // required marker
  unmount();
});

test("SheetTable renders headers + a row per record, formatting by type", async () => {
  const sheet = fakeSheet({
    rows: [
      { id: 1, name: "Ada", active: true },
      { id: 2, name: "Linus", active: false },
    ],
  });
  const { container, unmount } = render(
    React.createElement(SheetTable, { source: sheet, options: { interval: 60_000 } }),
  );
  await flush();
  assert.equal(container.querySelectorAll("thead th").length, 3);
  assert.equal(container.querySelectorAll("tbody tr").length, 2);
  const firstRowCells = container.querySelectorAll("tbody tr:first-child td");
  assert.equal(firstRowCells[2].textContent, "✓"); // boolean true -> ✓
  unmount();
});

test("SheetTable shows the empty state when there are no rows", async () => {
  const sheet = fakeSheet({ rows: [] });
  const { container, unmount } = render(
    React.createElement(SheetTable, { source: sheet, empty: "Nothing here", options: { interval: 60_000 } }),
  );
  await flush();
  assert.equal(container.querySelector(".gsab-empty")?.textContent, "Nothing here");
  unmount();
});

test("SheetTable formats by type even when given a shared SheetCache", async () => {
  const sheet = fakeSheet({ rows: [{ id: 1, name: "Ada", active: true }] });
  const cache = createCache(sheet, { key: "id", interval: 60_000 });
  await act(async () => {
    await cache.start();
  });
  const { container, unmount } = render(React.createElement(SheetTable, { source: cache }));
  await flush();
  const cells = container.querySelectorAll("tbody tr:first-child td");
  assert.equal(cells[2].textContent, "✓"); // boolean formatted via cache.schema getter, not "true"
  unmount();
  cache.stop();
});

test("SheetForm omits blank optional fields so a number cell is empty, not 0", async () => {
  const events = new Schema({
    name: "events",
    fields: {
      id: { type: "integer", primaryKey: true, minValue: 1 },
      title: { type: "string", required: true },
      score: { type: "float" }, // optional
    },
  });
  const sheet = fakeSheet({ schema: events });
  const hook = renderHook<UseSheetFormResult>(() => useSheetForm(sheet, { schema: events }));
  await act(async () => hook.current.setField("id", "1"));
  await act(async () => hook.current.setField("title", "Launch"));
  // score left blank
  let ok: boolean | undefined;
  await act(async () => {
    ok = await hook.current.submit();
  });
  assert.equal(ok, true);
  assert.deepEqual(sheet.inserted[0], { id: "1", title: "Launch" }); // no `score: ""` -> empty cell, not 0
  assert.equal("score" in sheet.inserted[0], false);
  hook.unmount();
});
