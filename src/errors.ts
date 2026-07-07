/** Structured metadata carried on every GSABError, so callers (a backend deciding retry-vs-
 *  surface, a mobile client mapping to UI) branch on codes instead of matching message text. */
export interface GSABErrorOptions {
  /** The HTTP status this maps to, when it came from a Google API response. */
  status?: number;
  /** A stable, machine-readable code (e.g. "rate_limited"). Defaults per error class. */
  code?: string;
  /** Whether retrying the same request could plausibly succeed (429/5xx → true). */
  retryable?: boolean;
  /** Seconds the caller should wait before retrying (from a `Retry-After` header). */
  retryAfter?: number;
  /** The underlying error, when this wraps one. */
  cause?: unknown;
}

/** Default `code` per error class — a stable identifier that survives message rewording. */
const DEFAULT_CODES: Record<string, string> = {
  GSABError: "error",
  AuthError: "unauthenticated",
  ConnectionError: "network",
  NotFoundError: "not_found",
  PermissionDeniedError: "permission_denied",
  QuotaExceededError: "quota_exceeded",
  ValidationError: "invalid_argument",
  DuplicateKeyError: "duplicate_key",
  APIError: "api_error",
  ConcurrencyError: "concurrent_modification",
};

/** GSAB error hierarchy — every error subclasses GSABError, with a plain-language,
 *  actionable message (for people and LLM agents alike) plus structured metadata
 *  (`status` / `code` / `retryable` / `retryAfter`). Mirrors the Python package. */
export class GSABError extends Error {
  /** HTTP status, when derived from a Google API response. */
  readonly status?: number;
  /** Stable machine-readable code — branch on this, not the message. */
  readonly code: string;
  /** True when a retry could plausibly succeed. */
  readonly retryable: boolean;
  /** Seconds to wait before retrying, when the server told us (`Retry-After`). */
  readonly retryAfter?: number;

  constructor(message: string, opts: GSABErrorOptions = {}) {
    super(message);
    this.name = new.target.name;
    this.status = opts.status;
    this.code = opts.code ?? DEFAULT_CODES[new.target.name] ?? DEFAULT_CODES.GSABError;
    this.retryable = opts.retryable ?? false;
    this.retryAfter = opts.retryAfter;
    if (opts.cause !== undefined) (this as { cause?: unknown }).cause = opts.cause;
  }
}
export class AuthError extends GSABError {}
export class ConnectionError extends GSABError {}
export class NotFoundError extends GSABError {}
export class PermissionDeniedError extends GSABError {}
export class QuotaExceededError extends GSABError {}
export class ValidationError extends GSABError {}
export class DuplicateKeyError extends GSABError {}
export class APIError extends GSABError {}
/** Rows shifted under a concurrent writer while a targeted write was being prepared; the write
 *  was aborted rather than landing on the wrong row. Retryable. */
export class ConcurrencyError extends GSABError {}

/** Statuses worth retrying: rate limiting and transient server errors. */
export const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

/** Map an HTTP status (from Sheets, Drive or gviz) to the closest GSAB error. `retryAfter`
 *  (seconds, from the response's `Retry-After` header) is attached when present. */
export function errorForStatus(status: number, detail: string, retryAfter?: number): GSABError {
  const low = detail.toLowerCase();
  if (status === 401) {
    return new AuthError(
      `Not authenticated with Google (${detail}). Sign in again (Node: run the loopback login; browser: request a fresh token).`,
      { status, retryAfter },
    );
  }
  if (status === 403) {
    if (low.includes("quota") || low.includes("rate limit") || low.includes("ratelimit")) {
      // A 403 rate-limit/quota is transient (per-minute buckets refill) — mark it retryable
      // but distinguish it from a hard 429 via the `code`.
      return new QuotaExceededError(`Google API quota exceeded (${detail}). Wait, then retry.`, {
        status,
        code: "quota_exceeded",
        retryable: true,
        retryAfter,
      });
    }
    return new PermissionDeniedError(
      `Access denied (${detail}). Check this account can open the spreadsheet and that the needed scopes were granted.`,
      { status },
    );
  }
  if (status === 404) {
    return new NotFoundError(
      `Spreadsheet or tab not found (${detail}). Check the sheet id and tab name.`,
      { status },
    );
  }
  if (status === 429) {
    return new QuotaExceededError(
      `Rate limited by Google (${detail}). Retried with backoff — try again shortly.`,
      { status, code: "rate_limited", retryable: true, retryAfter },
    );
  }
  if (status === 400) {
    return new ValidationError(`Google rejected the request (${detail}).`, { status });
  }
  return new APIError(`Google Sheets API error ${status || "?"}: ${detail}`, {
    status,
    retryable: RETRYABLE_STATUSES.has(status),
    retryAfter,
  });
}
