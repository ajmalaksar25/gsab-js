import { ValidationError } from "./errors";
import { runGvizQuery } from "./gviz";
import { sleep } from "./util";
import type { SheetConnection } from "./connection";
import type { Schema } from "./schema";

export type Row = Record<string, unknown>;
export type Filters = Record<string, unknown>;

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

function matchesFilters(record: Row, filters: Filters): boolean {
  for (const [field, cond] of Object.entries(filters)) {
    const actual = record[field];
    if (cond && typeof cond === "object" && !Array.isArray(cond)) {
      for (const [op, target] of Object.entries(cond as Record<string, unknown>)) {
        const fn = OPERATORS[op];
        if (!fn) throw new ValidationError(`Unknown filter operator: ${op}.`);
        if (!fn(actual, target)) return false;
      }
    } else if (actual !== cond) {
      return false;
    }
  }
  return true;
}

function rowKey(record: Row, key: string | undefined, schema?: Schema): unknown {
  if (key) return record[key];
  return JSON.stringify(schema ? schema.fieldNames.map((n) => record[n]) : record);
}

/** Read / query / watch over one Google Sheet tab. The read tier runs over gviz, so it
 *  works on a public sheet with no auth; writes (coming next) use the Sheets/Drive REST API. */
export class SheetManager {
  connection: SheetConnection;
  schema?: Schema;

  constructor(connection: SheetConnection, schema?: Schema) {
    this.connection = connection;
    this.schema = schema;
  }

  /** Read rows, optionally filtered client-side (`{field: value}` or `{field: {$op: value}}`). */
  async read(filters?: Filters): Promise<Row[]> {
    const token = await this.connection.getToken();
    const rows = await runGvizQuery(this.connection.spreadsheetId, "SELECT *", {
      sheet: this.schema?.name,
      token,
      dropUnlabeled: true,
    });
    return filters ? rows.filter((r) => matchesFilters(r, filters)) : rows;
  }

  /** Run a server-side gviz query (columns referenced by letter, e.g. "SELECT A, D WHERE D = 'pro'"). */
  async query(sql: string): Promise<Row[]> {
    const token = await this.connection.getToken();
    return runGvizQuery(this.connection.spreadsheetId, sql, {
      sheet: this.schema?.name,
      token,
    });
  }

  /** Poll + diff; yields `{added, updated, removed}`. Experimental — polling, not push.
   *  Run one watcher per sheet and fan its events out to many viewers. */
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
}
