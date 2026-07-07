import assert from "node:assert/strict";
import { test } from "node:test";

import { ValidationError } from "../src/errors.ts";
import { Schema } from "../src/schema.ts";
import { applyDefaults, collectErrors, validateRecord } from "../src/validate.ts";

const schema = new Schema({
  name: "users",
  fields: {
    id: { type: "integer", primaryKey: true, minValue: 1 },
    name: { type: "string", required: true, minLength: 2, maxLength: 10 },
    email: { type: "string", pattern: "^[^@]+@[^@]+$" },
    plan: { type: "string", default: "free" },
  },
});

test("applyDefaults fills missing fields with their default", () => {
  assert.equal(applyDefaults(schema, { id: 1, name: "Ada" }).plan, "free");
  assert.equal(applyDefaults(schema, { id: 1, name: "Ada", plan: "pro" }).plan, "pro");
});

test("required fields are enforced (unless a default exists or partial)", () => {
  assert.throws(() => validateRecord(schema, { id: 1 }), ValidationError); // name missing
  validateRecord(schema, { id: 1, name: "Ada" }); // plan has a default -> ok
  validateRecord(schema, { plan: "pro" }, true); // partial update -> ok
});

test("numeric and string constraints are enforced", () => {
  assert.throws(() => validateRecord(schema, { id: 0, name: "Ada" }), ValidationError); // minValue
  assert.throws(() => validateRecord(schema, { id: 1, name: "A" }), ValidationError); // minLength
  assert.throws(() => validateRecord(schema, { id: 1, name: "x".repeat(11) }), ValidationError); // maxLength
  assert.throws(
    () => validateRecord(schema, { id: 1, name: "Ada", email: "nope" }),
    ValidationError,
  ); // pattern
  validateRecord(schema, { id: 1, name: "Ada", email: "a@b.co" }); // ok
});

test("collectErrors returns every violation as a { field: message } map without throwing", () => {
  const errs = collectErrors(schema, { id: 0, name: "A" }); // minValue + minLength
  assert.ok(errs.id);
  assert.ok(errs.name);
  assert.equal(Object.keys(errs).length, 2); // email optional, plan has a default
  assert.deepEqual(collectErrors(schema, { id: 1, name: "Ada" }), {}); // valid -> no errors
});
