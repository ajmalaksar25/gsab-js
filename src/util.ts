/** Parse a `Retry-After` header (either delta-seconds or an HTTP date) into seconds from now,
 *  or undefined if absent/unparseable. Negative results are clamped to 0. */
export function parseRetryAfter(header: string | null | undefined, now = Date.now()): number | undefined {
  if (!header) return undefined;
  const secs = Number(header);
  if (Number.isFinite(secs)) return Math.max(0, secs);
  const at = Date.parse(header);
  if (!Number.isNaN(at)) return Math.max(0, (at - now) / 1000);
  return undefined;
}

/** Backoff delay (ms) for a retry attempt. Honors a server `Retry-After` (seconds) when given;
 *  otherwise uses exponential backoff with FULL jitter — `random(0, min(base*2^attempt, cap))`
 *  — so many clients retrying at once don't thunder back in lockstep. */
export function backoffDelay(
  attempt: number,
  baseDelay: number,
  retryAfter?: number,
  cap = 30_000,
): number {
  if (retryAfter != null) return Math.min(retryAfter * 1000, cap);
  const ceiling = Math.min(baseDelay * 2 ** attempt, cap);
  return Math.random() * ceiling;
}

/** Sleep that resolves early (without rejecting) if the AbortSignal fires — lets a
 *  watch() loop wake up, see signal.aborted, and return cleanly. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    // Detach from the (long-lived, reused) signal on BOTH paths — leaving the abort
    // listener behind would accumulate one listener per poll for the loop's lifetime.
    const done = () => {
      clearTimeout(t);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const t = setTimeout(done, ms);
    signal?.addEventListener("abort", done);
  });
}
