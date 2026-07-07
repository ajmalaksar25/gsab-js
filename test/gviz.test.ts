import assert from "node:assert/strict";
import { test } from "node:test";

import { ValidationError } from "../src/errors.ts";
import { buildGvizUrl, parseGvizResponse } from "../src/gviz.ts";

/** Wrap a payload the way Google's gviz endpoint does (JSONP-ish prefix + call). */
const wrap = (obj: unknown) =>
  `/*O_o*/\ngoogle.visualization.Query.setResponse(${JSON.stringify(obj)});`;

test("parseGvizResponse maps cells to objects keyed by column label", () => {
  const payload = {
    status: "ok",
    table: {
      cols: [
        { label: "id", id: "A" },
        { label: "name", id: "B" },
      ],
      rows: [{ c: [{ v: 1 }, { v: "Ada" }] }, { c: [{ v: 2 }, { v: "Linus" }] }],
    },
  };
  assert.deepEqual(parseGvizResponse(wrap(payload)), [
    { id: 1, name: "Ada" },
    { id: 2, name: "Linus" },
  ]);
});

test("parseGvizResponse drops header-less columns only when asked", () => {
  const payload = {
    table: {
      cols: [
        { label: "id", id: "A" },
        { label: "", id: "B" }, // unlabeled trailing column
      ],
      rows: [{ c: [{ v: 1 }, { v: "x" }] }],
    },
  };
  assert.deepEqual(parseGvizResponse(wrap(payload), true), [{ id: 1 }]);
  assert.deepEqual(parseGvizResponse(wrap(payload), false), [{ id: 1, B: "x" }]);
});

test("parseGvizResponse throws ValidationError on an error payload", () => {
  const payload = { status: "error", errors: [{ detailed_message: "Invalid query: bad column" }] };
  assert.throws(() => parseGvizResponse(wrap(payload)), ValidationError);
});

test("parseGvizResponse throws on a body with no JSON object", () => {
  assert.throws(() => parseGvizResponse("totally not gviz"), ValidationError);
});

test("buildGvizUrl encodes the sql and sheet, keeps tqx literal", () => {
  const url = buildGvizUrl("SID", "SELECT A WHERE B = 'x'", "My Tab");
  assert.ok(url.includes("tq=SELECT%20A%20WHERE"));
  assert.ok(url.includes("sheet=My%20Tab"));
  assert.ok(url.includes("tqx=out:json"));
});
