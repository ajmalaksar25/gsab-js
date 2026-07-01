import { coerceRows, coerceValue, fromCell, recordToRow, rowToRecord, valuesEqual } from "./coerce";
import { DuplicateKeyError, ValidationError } from "./errors";
import { runGvizQuery } from "./gviz";
import { driveApi, sheetsApi } from "./rest";
import { sleep } from "./util";
import { applyDefaults, validateRecord } from "./validate";
import type { SheetConnection } from "./connection";
import type { Schema } from "./schema";

export type Row = Record<string, unknown>;
export type Filters = Record<string, unknown>;
/** Public-link roles for share(); "editor"/"viewer" are aliases (Sheets UI terms). */
export type ShareRole = "reader" | "commenter" | "writer" | "editor" | "viewer";

export interface ChangeSet {
  added: Row[];
  updated: Row[];
  removed: Row[];
}

export interface WatchOptions {
  /** Milliseconds between polls (JS convention; the Python lib uses seconds). */
  interval?: number;
  filters?: Filters;
  /** Field to diff on (defaults to the schema's primary key, else whole-row identity). */
  key?: string;
  /** Yield the current rows as `added` before watching for changes. */
  emitInitial?: boolean;
  /** Abort to stop polling (interrupts the sleep and ends the generator). */
  signal?: AbortSignal;
}

// Mirror the Python read() filter operators.
const OPERATORS: Record<string, (a: any, t: any) => boolean> = {
  $eq: (a, t) => a === t,
  $ne: (a, t) => a !== t,
  $gt: (a, t) => a != null && a > t,
  $gte: (a, t) => a != null && a >= t,
  $lt: (a, t) => a != null && a < t,
  $lte: (a, t) => a != null && a <= t,
  $in: (a, t) => Array.isArray(t) && t.includes(a),
  $nin: (a, t) => Array.isArray(t) && !t.includes(a),
  $contains: (a, t) => String(a).includes(String(t)),
  $regex: (a, t) => new RegExp(String(t)).test(String(a)),
};

/** A filter value is an operator map only if it's a plain object whose keys ALL start with "$"
 *  — so a plain object (a JSON-field value) or a Date is compared by value, not misread. */
function isOperatorMap(cond: unknown): boolean {
  if (!cond || typeof cond !== "object" || Array.isArray(cond) || cond instanceof Date) return false;
  const keys = Object.keys(cond);
  return keys.length > 0 && keys.every((k) => k.startsWith("$"));
}

function matchesFilters(record: Row, filters: Filters, schema?: Schema): boolean {
  for (const [field, cond] of Object.entries(filters)) {
    const type = schema?.fields[field]?.type;
    const actual = record[field];
    if (isOperatorMap(cond)) {
      for (const [op, target] of Object.entries(cond as Record<string, unknown>)) {
        const fn = OPERATORS[op];
        if (!fn) throw new ValidationError(`Unknown filter operator: ${op}.`);
        // Coerce the target to the field type so a string "1" matches a stored integer 1.
        // $contains/$regex are string ops; $in/$nin coerce each element.
        let cmp: unknown = target;
        if ((op === "$in" || op === "$nin") && Array.isArray(target)) {
          cmp = target.map((t) => coerceValue(t, type));
        } else if (op !== "$contains" && op !== "$regex") {
          cmp = coerceValue(target, type);
        }
        if (!fn(actual, cmp)) return false;
      }
    } else if (!valuesEqual(actual, coerceValue(cond, type))) {
      return false;
    }
  }
  return true;
}

function rowKey(record: Row, key: string | undefined, schema?: Schema): unknown {
  if (key) return record[key];
  return JSON.stringify(schema ? schema.fieldNames.map((n) => record[n]) : record);
}

const SHARE_ALIASES: Record<string, string> = { editor: "writer", viewer: "reader" };

function normShareRole(role: string): string {
  const r = SHARE_ALIASES[role.toLowerCase()] ?? role.toLowerCase();
  if (!["reader", "commenter", "writer"].includes(r)) {
    throw new ValidationError(`share role must be reader, commenter or writer (got '${role}').`);
  }
  return r;
}

/** Read / query / watch (over gviz, no auth on a public sheet) plus authenticated CRUD
 *  (create / insert / update / delete / upsert / share via the Sheets + Drive REST API). */
export class SheetManager {
  connection: SheetConnection;
  schema?: Schema;

  constructor(connection: SheetConnection, schema?: Schema) {
    this.connection = connection;
    this.schema = schema;
  }

  private get _id(): string {
    if (!this.connection.spreadsheetId) {
      throw new ValidationError("No spreadsheet bound — call createSheet() or set a spreadsheetId.");
    }
    return this.connection.spreadsheetId;
  }

  private get _tab(): string {
    return this.schema?.name ?? "Sheet1";
  }

  private _qtab(): string {
    return `'${this._tab.replace(/'/g, "''")}'`;
  }

  private _valuesUrl(cells: string, query = ""): string {
    return `/${this._id}/values/${encodeURIComponent(`${this._qtab()}!${cells}`)}${query}`;
  }

  private _token(): Promise<string | null> {
    return this.connection.getToken();
  }

  // --- reads (gviz — work on a public sheet with no auth) --------------------

  /** Read rows, optionally filtered client-side (`{field: value}` or `{field: {$op: value}}`). */
  async read(filters?: Filters): Promise<Row[]> {
    const token = await this._token();
    const rows = await runGvizQuery(this._id, "SELECT *", {
      sheet: this.schema?.name,
      token,
      dropUnlabeled: true,
    });
    const typed = coerceRows(rows, this.schema);
    return filters ? typed.filter((r) => matchesFilters(r, filters, this.schema)) : typed;
  }

  /** Run a server-side gviz query (columns by letter, e.g. "SELECT A, D WHERE D = 'pro'"). */
  async query(sql: string): Promise<Row[]> {
    const token = await this._token();
    return runGvizQuery(this._id, sql, { sheet: this.schema?.name, token });
  }

  /** Poll + diff; yields `{added, updated, removed}`. Experimental — polling, not push. */
  async *watch(opts: WatchOptions = {}): AsyncGenerator<ChangeSet> {
    const { interval = 2000, filters, emitInitial = true, signal } = opts;
    const key = opts.key ?? this.schema?.primaryKey ?? undefined;
    let previous = new Map<unknown, Row>();
    let first = true;
    while (true) {
      if (signal?.aborted) return;
      const rows = await this.read(filters);
      const current = new Map<unknown, Row>(rows.map((r) => [rowKey(r, key, this.schema), r]));
      if (first) {
        if (emitInitial && current.size) {
          yield { added: [...current.values()], updated: [], removed: [] };
        }
      } else {
        const added: Row[] = [];
        const updated: Row[] = [];
        const removed: Row[] = [];
        for (const [k, r] of current) {
          if (!previous.has(k)) added.push(r);
          else if (JSON.stringify(r) !== JSON.stringify(previous.get(k))) updated.push(r);
        }
        for (const [k, r] of previous) if (!current.has(k)) removed.push(r);
        if (added.length || updated.length || removed.length) yield { added, updated, removed };
      }
      previous = current;
      first = false;
      await sleep(interval, signal);
    }
  }

  // --- write helpers (authenticated) ----------------------------------------

  private async _headers(token: string | null): Promise<string[]> {
    const res = await sheetsApi(token, this._valuesUrl("1:1"));
    const row: unknown[] = (res.values && res.values[0]) || [];
    if (row.length) return row.map(String);
    if (this.schema) return this.schema.fieldNames;
    throw new ValidationError(`Sheet '${this._tab}' has no header row and no schema was provided.`);
  }

  private async _grid(
    token: string | null,
  ): Promise<{ headers: string[]; rows: { rowIndex: number; record: Row }[] }> {
    const res = await sheetsApi(token, `/${this._id}/values/${encodeURIComponent(this._qtab())}`);
    const values: unknown[][] = res.values || [];
    const headers = values.length
      ? values[0].map(String)
      : this.schema
        ? this.schema.fieldNames
        : [];
    const rows = values.slice(1).map((cells, i) => ({
      rowIndex: i + 2, // header occupies row 1
      record: rowToRecord(cells, headers, this.schema),
    }));
    return { headers, rows };
  }

  private async _sheetGid(token: string | null): Promise<number> {
    const meta = await sheetsApi(token, `/${this._id}?fields=sheets.properties(sheetId,title)`);
    const sheets: { properties?: { sheetId?: number; title?: string } }[] = meta.sheets || [];
    const match = sheets.find((s) => s.properties?.title === this._tab) ?? sheets[0];
    return match?.properties?.sheetId ?? 0;
  }

  private _checkUnique(existing: Row[], incoming: Row[]): void {
    if (!this.schema?.uniqueFields.length) return;
    for (const field of this.schema.uniqueFields) {
      const type = this.schema.fields[field].type;
      // Canonicalize both sides to the same typed form so "1" and 1 collide for an integer key.
      const canon = (v: unknown) => (v == null || v === "" ? null : JSON.stringify(fromCell(v, type)));
      const seen = new Set(existing.map((r) => canon(r[field])).filter((v) => v != null));
      for (const rec of incoming) {
        const key = canon(rec[field]);
        if (key == null) continue;
        if (seen.has(key)) {
          throw new DuplicateKeyError(
            `Duplicate value for unique field '${field}': ${JSON.stringify(rec[field])}. Use upsert().`,
          );
        }
        seen.add(key);
      }
    }
  }

  private async _append(
    token: string | null,
    rows: (string | number | boolean)[][],
  ): Promise<void> {
    // The append endpoint is a method suffix on the range: .../values/{range}:append
    await sheetsApi(
      token,
      this._valuesUrl("A1", ":append?valueInputOption=RAW&insertDataOption=INSERT_ROWS"),
      { method: "POST", body: { values: rows } },
    );
  }

  private async _batchWrite(
    token: string | null,
    data: { range: string; values: (string | number | boolean)[][] }[],
  ): Promise<void> {
    await sheetsApi(token, `/${this._id}/values:batchUpdate`, {
      method: "POST",
      body: { valueInputOption: "RAW", data },
    });
  }

  // --- writes (authenticated) -----------------------------------------------

  /** Create the spreadsheet (tab named after the schema) and write its header row. Returns the id. */
  async createSheet(title: string): Promise<string> {
    const token = await this._token();
    const res = await sheetsApi(token, "", {
      method: "POST",
      body: { properties: { title }, sheets: [{ properties: { title: this._tab } }] },
    });
    this.connection.spreadsheetId = res.spreadsheetId;
    if (this.schema) {
      await sheetsApi(token, this._valuesUrl("A1", "?valueInputOption=RAW"), {
        method: "PUT",
        body: { values: [this.schema.fieldNames] },
      });
    }
    return res.spreadsheetId;
  }

  /** Append one row. Enforces `unique`/`primaryKey` (read-check-write); raises DuplicateKeyError. */
  async insert(data: Row): Promise<void> {
    await this.bulkInsert([data]);
  }

  /** Append many rows in one call; returns the count. Enforces `unique`/`primaryKey`. */
  async bulkInsert(records: Row[]): Promise<number> {
    if (!records.length) return 0;
    const token = await this._token();
    const prepared = records.map((r) => (this.schema ? applyDefaults(this.schema, r) : r));
    if (this.schema) prepared.forEach((r) => validateRecord(this.schema!, r));
    let headers: string[];
    if (this.schema?.uniqueFields.length) {
      const grid = await this._grid(token);
      headers = grid.headers;
      this._checkUnique(
        grid.rows.map((x) => x.record),
        prepared,
      );
    } else {
      headers = await this._headers(token);
    }
    await this._append(
      token,
      prepared.map((r) => recordToRow(r, headers, this.schema)),
    );
    return prepared.length;
  }

  /** Update every row matching `filters` with `updates` (omitted fields keep their value).
   *  Returns the number of rows changed. */
  async update(filters: Filters, updates: Row): Promise<number> {
    const token = await this._token();
    const grid = await this._grid(token);
    const matches = grid.rows.filter((x) => matchesFilters(x.record, filters, this.schema));
    if (!matches.length) return 0;
    if (this.schema) validateRecord(this.schema, updates, true);
    await this._batchWrite(
      token,
      matches.map((m) => ({
        range: `${this._qtab()}!A${m.rowIndex}`,
        values: [recordToRow({ ...m.record, ...updates }, grid.headers, this.schema)],
      })),
    );
    return matches.length;
  }

  /** Delete every row matching `filters`. Returns the number of rows deleted. */
  async delete(filters: Filters): Promise<number> {
    const token = await this._token();
    const grid = await this._grid(token);
    const matches = grid.rows.filter((x) => matchesFilters(x.record, filters, this.schema));
    if (!matches.length) return 0;
    const gid = await this._sheetGid(token);
    const requests = matches
      .map((m) => m.rowIndex)
      .sort((a, b) => b - a) // delete bottom-up so earlier removals don't shift later indices
      .map((r) => ({
        deleteDimension: {
          range: { sheetId: gid, dimension: "ROWS", startIndex: r - 1, endIndex: r },
        },
      }));
    await sheetsApi(token, `/${this._id}:batchUpdate`, { method: "POST", body: { requests } });
    return matches.length;
  }

  /** Insert, or update the row whose key matches (default key = the schema's primaryKey). */
  async upsert(data: Row, opts: { key?: string } = {}): Promise<"inserted" | "updated"> {
    const key = opts.key ?? this.schema?.primaryKey ?? undefined;
    if (!key) {
      throw new ValidationError(
        "upsert() needs a key — set a primaryKey on the schema or pass { key }.",
      );
    }
    const keyValue = data[key];
    if (keyValue == null || keyValue === "") {
      throw new ValidationError(`upsert() record is missing its key field '${key}'.`);
    }
    const token = await this._token();
    const grid = await this._grid(token);
    // Coerce the incoming key to the field type so a string "1" matches a stored integer 1.
    const target = coerceValue(keyValue, this.schema?.fields[key]?.type);
    const match = grid.rows.find((x) => valuesEqual(x.record[key], target));
    if (match) {
      if (this.schema) validateRecord(this.schema, data, true);
      await this._batchWrite(token, [
        {
          range: `${this._qtab()}!A${match.rowIndex}`,
          values: [recordToRow({ ...match.record, ...data }, grid.headers, this.schema)],
        },
      ]);
      return "updated";
    }
    const prepared = this.schema ? applyDefaults(this.schema, data) : data;
    if (this.schema) validateRecord(this.schema, prepared);
    await this._append(token, [recordToRow(prepared, grid.headers, this.schema)]);
    return "inserted";
  }

  // --- sharing (Drive) ------------------------------------------------------

  /** Make the sheet public (anyone with the link) and return its URL. */
  async share(role: ShareRole = "reader"): Promise<string> {
    const token = await this._token();
    await driveApi(token, `/files/${this._id}/permissions?fields=id`, {
      method: "POST",
      body: { type: "anyone", role: normShareRole(role) },
    });
    return `https://docs.google.com/spreadsheets/d/${this._id}/edit`;
  }

  /** Revoke public ("anyone with the link") access. */
  async unshare(): Promise<void> {
    const token = await this._token();
    const list = await driveApi(
      token,
      `/files/${this._id}/permissions?fields=permissions(id,type)`,
    );
    const anyone = (list.permissions || []).find((p: { type?: string }) => p.type === "anyone");
    if (anyone) {
      await driveApi(token, `/files/${this._id}/permissions/${anyone.id}`, { method: "DELETE" });
    }
  }

  /** The CSV-export URL (publicly fetchable once shared). */
  get csvUrl(): string {
    return `https://docs.google.com/spreadsheets/d/${this._id}/export?format=csv`;
  }
}
