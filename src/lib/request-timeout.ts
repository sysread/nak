/**
 * Shared request bound for browser loads and writes that must not
 * hang forever on a black-holed connection: without it, a request
 * that never settles pins a loading flag or leaves a row's pending
 * spinner running. Rune-free by design - both the UI store
 * (src/lib/grocery-store.svelte.ts) and the data-layer slices
 * (src/lib/supabase/settings.ts) import it, and the data layer must
 * not import Svelte modules.
 */
export const REQUEST_TIMEOUT_MS = 15_000;

/**
 * Reject when `p` does not settle within `ms`. Unlike passing an
 * AbortSignal to supabase-js, this bounds any promise - including
 * the slice functions that take no signal. `AbortSignal.timeout`'s
 * timer does not hold the event loop, so a test injecting a short
 * bound ends cleanly instead of waiting out the full timeout.
 */
export function withRequestTimeout<T>(
  p: Promise<T>,
  ms: number = REQUEST_TIMEOUT_MS
): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      AbortSignal.timeout(ms).addEventListener('abort', () =>
        reject(new Error(`request timed out after ${ms}ms`))
      );
    }),
  ]);
}
