/** Server-side querying via the Google Visualization API (gviz).
 *
 *  Pushes filtering / sorting / aggregation to Google's servers (a SQL subset) instead
 *  of fetching every row. On a PUBLIC sheet this needs no auth and works cross-origin in
 *  the browser; on a private sheet, pass an OAuth access token. */
import { ConnectionError, errorForStatus, RETRYABLE_STATUSES, ValidationError } from "./errors";
import type { Row } from "./manager";
import { backoffDelay, parseRetryAfter, sleep } from "./util";

const GVIZ = (id: string) => `https://docs.google.com/spreadsheets/d/${id}/gviz/tq`;

/** Parse the JSONP-wrapped gviz payload (a leading `google.visualization.Query.setResponse({...})`
 *  wrapper) into row objects keyed by column label. */
export function parseGvizResponse(text: string, dropUnlabeled = false): Row[] {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1) {
    throw new ValidationError(`Unexpected gviz response: ${JSON.stringify(text.slice(0, 120))}`);
  }
  const payload = JSON.parse(text.slice(start, end + 1));
  if (payload.status === "error") {
    const err = (payload.errors && payload.errors[0]) || {};
    const msg = err.detailed_message || err.message || "invalid query";
    throw new ValidationError(`Query rejected by Google: ${msg}. Columns are referenced by letter.`);
  }
  const table = payload.table || {};
  const cols: { label: string; labeled: boolean }[] = (table.cols || []).map(
    (c: { label?: string; id?: string }, i: number) => ({
      label: c.label || c.id || `c${i}`,
      labeled: Boolean(c.label),
    }),
  );
  const rows: Row[] = [];
  for (const r of table.rows || []) {
    const cells = r.c || [];
    const row: Row = {};
    cols.forEach((col, i) => {
      // A SELECT * over a grid with blank trailing columns yields header-less columns;
      // drop them on the read path (they have no header label).
      if (dropUnlabeled && !col.labeled) return;
      row[col.label] = cells[i] ? (cells[i].v ?? null) : null;
    });
    rows.push(row);
  }
  return rows;
}

/** Build the gviz request URL (sql + sheet are URL-encoded; tqx kept literal). */
export function buildGvizUrl(id: string, sql: string, sheet?: string, headers = 1): string {
  const enc = encodeURIComponent;
  let qs = `tq=${enc(sql)}&tqx=out:json&headers=${headers}`;
  if (sheet) qs += `&sheet=${enc(sheet)}`;
  return `${GVIZ(id)}?${qs}`;
}

export interface GvizOptions {
  sheet?: string;
  token?: string | null;
  retries?: number;
  baseDelay?: number;
  timeout?: number;
  /** Drop header-less columns (used by read() so a SELECT * skips blank grid columns). */
  dropUnlabeled?: boolean;
}

/** Execute a gviz query, retrying transient failures (429/5xx, dropped connections) with
 *  backoff, and mapping a final failure to a friendly GSAB error. */
export async function runGvizQuery(id: string, sql: string, opts: GvizOptions = {}): Promise<Row[]> {
  const { sheet, token, retries = 4, baseDelay = 500, timeout = 30000 } = opts;
  const url = buildGvizUrl(id, sql, sheet);
  const headers: Record<string, string> = {};
  if (token) headers["Authorization"] = `Bearer ${token}`;
  for (let attempt = 0; attempt <= retries; attempt++) {
    let resp: Response;
    try {
      resp = await fetch(url, { headers, signal: AbortSignal.timeout(timeout) });
    } catch (e) {
      if (attempt < retries) {
        await sleep(backoffDelay(attempt, baseDelay));
        continue;
      }
      throw new ConnectionError(
        `Network error running query (${(e as Error).message}). Check your connection and try again.`,
        { retryable: true, cause: e },
      );
    }
    const retryAfter = parseRetryAfter(resp.headers.get("retry-after"));
    if (RETRYABLE_STATUSES.has(resp.status) && attempt < retries) {
      await sleep(backoffDelay(attempt, baseDelay, retryAfter));
      continue;
    }
    if (resp.status >= 400) {
      const text = (await resp.text()).slice(0, 200).trim();
      throw errorForStatus(resp.status, text || resp.statusText, retryAfter);
    }
    return parseGvizResponse(await resp.text(), opts.dropUnlabeled);
  }
  throw new ConnectionError("Query failed after retries.", { retryable: true });
}
