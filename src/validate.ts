/** Write-time validation, mirroring the Python library's enforced constraints. */
import { FieldType } from "./schema";
import type { FieldDef, Schema } from "./schema";
import { ValidationError } from "./errors";

function isMissing(v: unknown): boolean {
  return v === undefined || v === null || v === "";
}

/** Return a copy of `record` with schema defaults filled in for missing fields. */
export function applyDefaults(schema: Schema, record: Record<string, unknown>): Record<string, unknown> {
  const out = { ...record };
  for (const name of schema.fieldNames) {
    const f = schema.fields[name];
    if (isMissing(out[name]) && f.default !== undefined) out[name] = f.default;
  }
  return out;
}

/** The first constraint `value` violates for field `name`, or null if it's valid. Shared by
 *  validateRecord (throws the first) and collectErrors (collects all), so they never drift. */
export function fieldError(
  name: string,
  f: FieldDef,
  value: unknown,
  partial = false,
): string | null {
  if (isMissing(value)) {
    if (partial || f.default !== undefined) return null;
    if (f.required || f.primaryKey) return `Field '${name}' is required.`;
    return null;
  }
  if (f.type === FieldType.INTEGER || f.type === FieldType.FLOAT) {
    const n = Number(value);
    if (Number.isNaN(n)) return `Field '${name}' must be a number (got ${value}).`;
    if (f.minValue !== undefined && n < f.minValue) return `Field '${name}' must be >= ${f.minValue} (got ${n}).`;
    if (f.maxValue !== undefined && n > f.maxValue) return `Field '${name}' must be <= ${f.maxValue} (got ${n}).`;
  } else if (f.type === FieldType.STRING) {
    const s = String(value);
    if (f.minLength !== undefined && s.length < f.minLength) return `Field '${name}' must be at least ${f.minLength} chars.`;
    if (f.maxLength !== undefined && s.length > f.maxLength) return `Field '${name}' must be at most ${f.maxLength} chars.`;
    if (f.pattern !== undefined && !new RegExp(f.pattern).test(s)) return `Field '${name}' does not match pattern ${f.pattern}.`;
  }
  return null;
}

/** Validate a record against the schema, throwing the first violation. With `partial` (update),
 *  only supplied fields are checked. */
export function validateRecord(
  schema: Schema,
  record: Record<string, unknown>,
  partial = false,
): void {
  for (const name of schema.fieldNames) {
    const msg = fieldError(name, schema.fields[name], record[name], partial);
    if (msg) throw new ValidationError(msg);
  }
}

/** Validate a record and return a `{ field: message }` map of ALL violations (never throws).
 *  Powers form-level, per-field error display in `<SheetForm>` / `useSheetForm`. */
export function collectErrors(
  schema: Schema,
  record: Record<string, unknown>,
  partial = false,
): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const name of schema.fieldNames) {
    const msg = fieldError(name, schema.fields[name], record[name], partial);
    if (msg) errors[name] = msg;
  }
  return errors;
}
