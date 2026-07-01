import { ValidationError } from "./errors";

/** Column data types. Mirrors the Python FieldType (a const map + union, not a TS enum,
 *  so the source stays erasable and tree-shakeable). */
export const FieldType = {
  STRING: "string",
  INTEGER: "integer",
  FLOAT: "float",
  BOOLEAN: "boolean",
  DATE: "date",
  DATETIME: "datetime",
  JSON: "json",
} as const;

export type FieldTypeName = (typeof FieldType)[keyof typeof FieldType];

/** One column in a Schema. `primaryKey` implies required + unique and is the default
 *  key upsert()/watch() match on. */
export interface FieldDef {
  type: FieldTypeName;
  required?: boolean;
  unique?: boolean;
  primaryKey?: boolean;
  default?: unknown;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  minValue?: number;
  maxValue?: number;
  encrypted?: boolean;
}

/** A tab definition: a name plus ordered columns (JS preserves object key order). */
export interface SchemaDef {
  name: string;
  fields: Record<string, FieldDef>;
}

export class Schema {
  name: string;
  fields: Record<string, FieldDef>;
  fieldNames: string[];
  primaryKey: string | null;
  uniqueFields: string[];

  constructor(def: SchemaDef) {
    this.name = def.name;
    this.fields = def.fields;
    this.fieldNames = Object.keys(def.fields);
    const pks = this.fieldNames.filter((n) => def.fields[n].primaryKey);
    if (pks.length > 1) {
      throw new ValidationError(`A schema can have at most one primaryKey (got ${pks.join(", ")}).`);
    }
    this.primaryKey = pks[0] ?? null;
    this.uniqueFields = this.fieldNames.filter(
      (n) => def.fields[n].unique || def.fields[n].primaryKey,
    );
  }
}

export function normalizeSchema(s: Schema | SchemaDef): Schema {
  return s instanceof Schema ? s : new Schema(s);
}
