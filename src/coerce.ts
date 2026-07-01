/** Value coercion between JS and Google Sheets cells, mirroring the Python FieldType round-trip.
 *
 *  Writes go out with valueInputOption=RAW, so a JS number/boolean lands as a typed cell
 *  (which keeps server-side gviz numeric/boolean filters working); JSON is stored as a string. */
import { FieldType } from "./schema";
import type { FieldTypeName, Schema } from "./schema";

/** Convert a JS value to the cell value written to a sheet (RAW input). */
export function toCell(value: unknown, type: FieldTypeName): string | number | boolean {
  if (value === null || value === undefined) return "";
  switch (type) {
    case FieldType.INTEGER:
      return Math.trunc(Number(value));
    case FieldType.FLOAT:
      return Number(value);
    case FieldType.BOOLEAN:
      // A non-empty string is truthy in JS, so Boolean("false") is true — parse strings instead.
      if (typeof value === "boolean") return value;
      if (typeof value === "number") return value !== 0;
      return ["true", "1", "yes"].includes(String(value).trim().toLowerCase());
    case FieldType.JSON:
      return JSON.stringify(value);
    case FieldType.DATE:
    case FieldType.DATETIME:
      return value instanceof Date ? value.toISOString() : String(value);
    default:
      return String(value);
  }
}

/** Convert a cell value read back from a sheet to a typed JS value. */
export function fromCell(value: unknown, type: FieldTypeName): unknown {
  if (value === null || value === undefined || value === "") return null;
  switch (type) {
    case FieldType.INTEGER:
      return Math.trunc(Number(value));
    case FieldType.FLOAT:
      return Number(value);
    case FieldType.BOOLEAN:
      return typeof value === "boolean" ? value : String(value).toLowerCase() === "true";
    case FieldType.JSON:
      if (typeof value !== "string") return value;
      try {
        return JSON.parse(value);
      } catch {
        return value;
      }
    default:
      return String(value);
  }
}

/** Build a sheet row (array in header order) from a record, coercing each field. */
export function recordToRow(
  record: Record<string, unknown>,
  headers: string[],
  schema?: Schema,
): (string | number | boolean)[] {
  return headers.map((h) => {
    const type = schema?.fields[h]?.type ?? FieldType.STRING;
    return toCell(record[h], type);
  });
}

/** Build a record from a sheet row (array in header order), coercing each field by schema. */
export function rowToRecord(
  cells: unknown[],
  headers: string[],
  schema?: Schema,
): Record<string, unknown> {
  const record: Record<string, unknown> = {};
  headers.forEach((h, i) => {
    const type = schema?.fields[h]?.type ?? FieldType.STRING;
    record[h] = fromCell(cells[i], type);
  });
  return record;
}

/** Normalize an incoming filter/key value to the same typed form stored values carry, so a
 *  raw string "1" compares equal to a schema-coerced integer 1 (values often arrive as strings
 *  from LLM/MCP callers, URLs and forms). */
export function coerceValue(value: unknown, type: FieldTypeName | undefined): unknown {
  if (value === null || value === undefined) return value;
  return type ? fromCell(value, type) : value;
}

/** Equality that deep-compares objects (JSON fields) and uses `===` for primitives. */
export function valuesEqual(a: unknown, b: unknown): boolean {
  if (a && b && typeof a === "object" && typeof b === "object") {
    return JSON.stringify(a) === JSON.stringify(b);
  }
  return a === b;
}

/** Re-type JSON (and other) fields on rows returned by the gviz read path, per schema. */
export function coerceRows(
  rows: Record<string, unknown>[],
  schema?: Schema,
): Record<string, unknown>[] {
  if (!schema) return rows;
  const jsonFields = schema.fieldNames.filter((n) => schema.fields[n].type === FieldType.JSON);
  if (!jsonFields.length) return rows;
  for (const row of rows) {
    for (const f of jsonFields) {
      if (f in row) row[f] = fromCell(row[f], FieldType.JSON);
    }
  }
  return rows;
}
