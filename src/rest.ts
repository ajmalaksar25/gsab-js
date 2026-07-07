/** Authenticated Google REST calls (Sheets v4 + Drive v3) for the write path.
 *
 *  All endpoints are CORS-enabled, so this same code runs in the browser (with a GIS token)
 *  and in Node (with a loopback token). Transient failures retry with backoff; other failures
 *  map to the GSAB error hierarchy. */
import { AuthError, ConnectionError, errorForStatus, RETRYABLE_STATUSES } from "./errors";
import { backoffDelay, parseRetryAfter, sleep } from "./util";

const SHEETS = "https://sheets.googleapis.com/v4/spreadsheets";
const DRIVE = "https://www.googleapis.com/drive/v3";

export interface ApiOptions {
  method?: string;
  body?: unknown;
  retries?: number;
  baseDelay?: number;
  timeout?: number;
}

/** Pull the human-readable message out of a Google JSON error body ({error:{message}}). */
function detailFrom(text: string): string {
  try {
    const j = JSON.parse(text);
    return j?.error?.message || text.slice(0, 200);
  } catch {
    return text.slice(0, 200).trim();
  }
}

async function apiFetch(url: string, token: string, opts: ApiOptions = {}): Promise<any> {
  const { method = "GET", body, retries = 4, baseDelay = 500, timeout = 30000 } = opts;
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const init: RequestInit = {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  };
  for (let attempt = 0; attempt <= retries; attempt++) {
    let resp: Response;
    try {
      resp = await fetch(url, { ...init, signal: AbortSignal.timeout(timeout) });
    } catch (e) {
      if (attempt < retries) {
        await sleep(backoffDelay(attempt, baseDelay));
        continue;
      }
      throw new ConnectionError(
        `Network error calling Google (${(e as Error).message}). Check your connection and try again.`,
        { retryable: true, cause: e },
      );
    }
    const retryAfter = parseRetryAfter(resp.headers.get("retry-after"));
    if (RETRYABLE_STATUSES.has(resp.status) && attempt < retries) {
      await sleep(backoffDelay(attempt, baseDelay, retryAfter));
      continue;
    }
    const text = await resp.text();
    if (resp.status >= 400) {
      throw errorForStatus(resp.status, detailFrom(text) || resp.statusText, retryAfter);
    }
    return text ? JSON.parse(text) : {};
  }
  throw new ConnectionError("Request failed after retries.", { retryable: true });
}

function requireToken(token: string | null): string {
  if (!token) {
    throw new AuthError(
      "This operation needs authentication. Provide credentials via connect({ url, auth }) — " +
        'Node: `import { loopbackAuth } from "gsab-js/node"`; browser: a Google Identity Services token.',
    );
  }
  return token;
}

/** Call the Sheets v4 API. `path` is appended to .../v4/spreadsheets (e.g. "" to create, or
 *  "/{id}/values/Tab!A:Z:append?valueInputOption=RAW"). */
export function sheetsApi(
  token: string | null,
  path: string,
  opts: ApiOptions = {},
): Promise<any> {
  return apiFetch(`${SHEETS}${path}`, requireToken(token), opts);
}

/** Call the Drive v3 API (used for public sharing via permissions). */
export function driveApi(token: string | null, path: string, opts: ApiOptions = {}): Promise<any> {
  return apiFetch(`${DRIVE}${path}`, requireToken(token), opts);
}
