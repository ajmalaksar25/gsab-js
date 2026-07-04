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
