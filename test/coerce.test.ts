import assert from "node:assert/strict";
import { test } from "node:test";

import { coerceRows, fromCell, recordToRow, rowToRecord, toCell } from "../src/coerce.ts";
import { Schema } from "../src/schema.ts";

const schema = new Schema({
  name: "t",
  fields: {
    id: { type: "integer", primaryKey: true },
    price: { type: "float" },
    active: { type: "boolean" },
    meta: { type: "json" },
    name: { type: "string" },
  },
});

test("toCell coerces by field type", () => {
  assert.equal(toCell(3.9, "integer"), 3);
  assert.equal(toCell("2.5", "float"), 2.5);
  assert.equal(toCell(1, "boolean"), true);
  assert.equal(toCell({ a: 1 }, "json"), '{"a":1}');
  assert.equal(toCell(null, "string"), "");
  assert.equal(toCell(undefined, "integer"), "");
});

test("toCell parses string booleans symmetrically with fromCell", () => {
  assert.equal(toCell("false", "boolean"), false); // NOT Boolean("false") === true
  assert.equal(toCell("true", "boolean"), true);
  assert.equal(toCell("0", "boolean"), false);
  assert.equal(toCell(true, "boolean"), true);
});

test("fromCell reverses, tolerating string cells from values.get", () => {
  assert.equal(fromCell("3", "integer"), 3);
  assert.equal(fromCell("TRUE", "boolean"), true);
  assert.equal(fromCell(false, "boolean"), false);
  assert.deepEqual(fromCell('{"a":1}', "json"), { a: 1 });
  assert.equal(fromCell("", "string"), null);
  assert.equal(fromCell("oops{", "json"), "oops{"); // bad JSON falls back to the raw string
});

test("recordToRow / rowToRecord round-trip in header order", () => {
  const headers = ["id", "price", "active", "meta", "name"];
  const row = recordToRow({ id: 1, price: 9.5, active: true, meta: { x: 1 }, name: "Ada" }, headers, schema);
  assert.deepEqual(row, [1, 9.5, true, '{"x":1}', "Ada"]);
  const rec = rowToRecord(row, headers, schema);
  assert.deepEqual(rec, { id: 1, price: 9.5, active: true, meta: { x: 1 }, name: "Ada" });
});

test("coerceRows parses JSON fields on the gviz read path", () => {
  const rows = coerceRows([{ id: 1, meta: '{"a":1}', name: "Ada" }], schema);
  assert.deepEqual(rows[0].meta, { a: 1 });
});
