/**
 * Stable holder identity for thread response claims.
 *
 * Composed as `${browserId}:${tabSeq}`:
 *
 *   - browserId: UUID stamped into localStorage on first visit. Persists
 *     across browser restarts and is shared by every tab of the same
 *     profile. Gives logs a recognisable identity across refreshes.
 *
 *   - tabSeq: integer allocated by atomically incrementing a counter
 *     in localStorage on first mount within a tab, then stamped into
 *     sessionStorage. Survives refresh within the tab; a brand-new tab
 *     starts with empty sessionStorage and bumps the counter to claim
 *     a fresh number.
 *
 * Why this shape: the chat-loop acquires a per-thread response claim
 * keyed on (threadId, holderId). A refresh tears down the chat-loop
 * without releasing the claim - the row in `threads` keeps the holderId
 * and a future expires_at until the 60s TTL sweeps it. If the next
 * mount mints a brand-new holderId (the prior `crypto.randomUUID()`
 * path), the page sees its OWN stale claim as "another device is
 * responding" and renders a spurious Scanner bubble plus refuses the
 * user's retry. Keeping the holderId stable across refresh makes the
 * stale row read as ours - acquire_thread_response_claim takes the
 * same-holder branch and refreshes the expiry instead of refusing.
 *
 * Behaviour by scenario:
 *
 *   - Refresh same tab: both parts persist -> same holderId. Claim
 *     resumes cleanly.
 *   - New tab: sessionStorage empty, fresh tabSeq from the counter ->
 *     different holderId. Two tabs of the same browser correctly see
 *     each other as separate holders.
 *   - Close + reopen tab: sessionStorage cleared, fresh tabSeq ->
 *     different holderId. The prior claim still has to wait out its
 *     60s TTL before the new tab can take it; same as today.
 *   - New browser profile / new device: empty localStorage, fresh
 *     browserId. Naturally distinct.
 *
 * Known edge: Chrome's "Duplicate Tab" command copies sessionStorage,
 * so a duplicated tab shares the source tab's holderId. The atomic
 * message-commit RPC dedupes assistant rows on user-message-id, so the
 * worst-case symptom is two parallel completions racing - one wins,
 * the other's tokens are discarded. We accept this over the complexity
 * of a BroadcastChannel collision check; duplicate-tab is rare and the
 * cost ceiling is one wasted completion.
 *
 * Storage failure path: a sandboxed iframe / disabled cookies / private
 * mode quirk that throws on localStorage access falls back to a
 * per-mount random id. That regresses to the old refresh-loses-claim
 * behaviour but keeps the chat usable.
 */

const BROWSER_KEY = 'nak:holder:browser';
const TAB_KEY = 'nak:holder:tab';
const COUNTER_KEY = 'nak:holder:counter';

function randomId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Resolve the holderId for this tab. Idempotent within a tab: a second
 * call returns the same value because both storage reads hit the
 * previously-written entries. Safe to call from a component mount.
 *
 * The counter increment is not atomic across tabs - two tabs opened at
 * exactly the same moment can each read the counter at N and both
 * write N+1, ending up with the same tabSeq. Treated the same as the
 * duplicate-tab case above: the commit RPC catches the resulting race.
 */
export function resolveHolderId(): string {
  try {
    const local = window.localStorage;
    const session = window.sessionStorage;

    let browserId = local.getItem(BROWSER_KEY);
    if (browserId === null || browserId.length === 0) {
      browserId = randomId();
      local.setItem(BROWSER_KEY, browserId);
    }

    let tabSeq = session.getItem(TAB_KEY);
    if (tabSeq === null || tabSeq.length === 0) {
      const prev = Number.parseInt(local.getItem(COUNTER_KEY) ?? '0', 10);
      const next = Number.isFinite(prev) && prev >= 0 ? prev + 1 : 1;
      tabSeq = String(next);
      local.setItem(COUNTER_KEY, tabSeq);
      session.setItem(TAB_KEY, tabSeq);
    }

    return `${browserId}:${tabSeq}`;
  } catch {
    // Storage unavailable - sandboxed iframe, disabled cookies, private
    // mode quirk. Fall back to a per-mount random id so the chat stays
    // usable; refresh-survival is lost in this environment.
    return randomId();
  }
}
