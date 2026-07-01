/** Write-time validation, mirroring the Python library's enforced constraints. */
import { FieldType } from "./schema";
import type { Schema } from "./schema";
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

/** Validate a record against the schema. With `partial` (update), only supplied fields are checked. */
export function validateRecord(
  schema: Schema,
  record: Record<string, unknown>,
  partial = false,
): void {
  for (const name of schema.fieldNames) {
    const f = schema.fields[name];
    const v = record[name];
    if (isMissing(v)) {
      if (partial || f.default !== undefined) continue;
      if (f.required || f.primaryKey) throw new ValidationError(`Field '${name}' is required.`);
      continue;
    }
    if (f.type === FieldType.INTEGER || f.type === FieldType.FLOAT) {
      const n = Number(v);
      if (Number.isNaN(n)) throw new ValidationError(`Field '${name}' must be a number (got ${v}).`);
      if (f.minValue !== undefined && n < f.minValue) {
        throw new ValidationError(`Field '${name}' must be >= ${f.minValue} (got ${n}).`);
      }
      if (f.maxValue !== undefined && n > f.maxValue) {
        throw new ValidationError(`Field '${name}' must be <= ${f.maxValue} (got ${n}).`);
      }
    } else if (f.type === FieldType.STRING) {
      const s = String(v);
      if (f.minLength !== undefined && s.length < f.minLength) {
        throw new ValidationError(`Field '${name}' must be at least ${f.minLength} chars.`);
      }
      if (f.maxLength !== undefined && s.length > f.maxLength) {
        throw new ValidationError(`Field '${name}' must be at most ${f.maxLength} chars.`);
      }
      if (f.pattern !== undefined && !new RegExp(f.pattern).test(s)) {
        throw new ValidationError(`Field '${name}' does not match pattern ${f.pattern}.`);
      }
    }
  }
}
