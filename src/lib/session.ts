/**
 * Tab-local active-thread persistence. Survives a refresh within the
 * same tab; evaporates when the tab closes (sessionStorage semantics).
 * Chat.svelte reads this at mount time so a refresh lands on the same
 * conversation the user was looking at.
 *
 * Earlier this module also held a master-password session-bridge blob
 * (a TTL-gated copy of the decrypted config so a refresh didn't
 * reprompt for the password). That ceremony was retired with the
 * streaming-root cleanup - the local config is plaintext JSON now and
 * `App.svelte` loads it synchronously on mount, no bridge needed.
 * What's left is just the thread-id helper used by Chat.svelte's
 * "reopen the last active thread" path.
 */

const KEY = 'nak:session:thread:v1';

function storage(): Storage | null {
  try {
    if (typeof sessionStorage === 'undefined') return null;
    return sessionStorage;
  } catch {
    return null;
  }
}

/**
 * Read the active-thread id saved for this tab, or null if there isn't
 * one (fresh tab, the user signed out, or the value isn't a string).
 */
export function getSessionThreadId(): string | null {
  const s = storage();
  if (!s) return null;
  try {
    const raw = s.getItem(KEY);
    return typeof raw === 'string' && raw.length > 0 ? raw : null;
  } catch {
    return null;
  }
}

/**
 * Save (or clear with `null`) the active-thread id for this tab.
 * Best-effort: a storage failure (quota, private mode) drops silently.
 */
export function setSessionThreadId(id: string | null): void {
  const s = storage();
  if (!s) return;
  try {
    if (id === null) s.removeItem(KEY);
    else s.setItem(KEY, id);
  } catch {
    // Quota / private mode - treat as no-op.
  }
}

/**
 * Drop the saved thread id. Called by the Sign-out path so the
 * post-sign-in session doesn't reopen a thread the user has just
 * signed away from.
 */
export function clearSessionThreadId(): void {
  setSessionThreadId(null);
}

export const __test = { KEY };
