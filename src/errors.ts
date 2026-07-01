/** GSAB error hierarchy — every error subclasses GSABError, with a plain-language,
 *  actionable message (for people and LLM agents alike). Mirrors the Python package. */
export class GSABError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
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

/** Statuses worth retrying: rate limiting and transient server errors. */
export const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

/** Map an HTTP status (from Sheets, Drive or gviz) to the closest GSAB error. */
export function errorForStatus(status: number, detail: string): GSABError {
  const low = detail.toLowerCase();
  if (status === 401) {
    return new AuthError(
      `Not authenticated with Google (${detail}). Sign in again (Node: run the loopback login; browser: request a fresh token).`,
    );
  }
  if (status === 403) {
    if (low.includes("quota") || low.includes("rate limit") || low.includes("ratelimit")) {
      return new QuotaExceededError(`Google API quota exceeded (${detail}). Wait, then retry.`);
    }
    return new PermissionDeniedError(
      `Access denied (${detail}). Check this account can open the spreadsheet and that the needed scopes were granted.`,
    );
  }
  if (status === 404) {
    return new NotFoundError(
      `Spreadsheet or tab not found (${detail}). Check the sheet id and tab name.`,
    );
  }
  if (status === 429) {
    return new QuotaExceededError(
      `Rate limited by Google (${detail}). Retried with backoff — try again shortly.`,
    );
  }
  if (status === 400) {
    return new ValidationError(`Google rejected the request (${detail}).`);
  }
  return new APIError(`Google Sheets API error ${status || "?"}: ${detail}`);
}
