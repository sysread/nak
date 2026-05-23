/**
 * Stable per-device holder identity for thread response claims.
 *
 * A single UUID stamped into localStorage under `nak:holder:id` on first
 * visit and reused on every later mount. localStorage persists across
 * page refreshes, app-update reloads, and browser restarts on every
 * platform we target - including installed PWAs, where sessionStorage
 * has been observed to NOT survive a reload (the bug that motivated this
 * was reproduced on an Android Chrome PWA install). So the id a tab
 * presents before a refresh is the same id it presents after.
 *
 * Why this matters: the chat-loop acquires a per-thread response claim
 * keyed on (threadId, holderId) and heartbeats it while streaming. A
 * refresh tears the chat-loop down WITHOUT releasing the claim, so the
 * `threads` row keeps holderId + a future expires_at for the rest of the
 * 60s TTL. If the post-refresh page presents a NEW holderId, it reads its
 * own stale claim as "another device is responding" - the
 * respondingElsewhere bubble shows and the user's retry hits
 * acquire_thread_response_claim's not-our-holder branch and fails for the
 * full TTL. A stable id makes the stale row read as ours: acquire takes
 * the same-holder branch (`response_holder_id = p_holder_id` in
 * supabase/schema.sql) and refreshes the expiry, so the retry resumes the
 * turn cleanly.
 *
 * Why device-level and not per-tab: "device" is the right granularity for
 * the cross-device guard the claim exists to provide - respondingElsewhere
 * should fire when a DIFFERENT browser/device is producing the response,
 * and a localStorage UUID is exactly per-browser-profile. An earlier
 * attempt composed `${browserId}:${tabSeq}` with the tabSeq in
 * sessionStorage to keep two tabs distinguishable, but sessionStorage's
 * unreliability across PWA reloads (reproduced on Android Chrome) meant
 * the tabSeq regenerated on refresh and reintroduced the exact
 * stale-claim bug this module exists to prevent.
 *
 * Trade-off - two tabs of the same browser now share this id, so they no
 * longer recognise each other as separate holders. Two tabs streaming the
 * same thread at once would both pass the same-holder acquire and race to
 * commit; the atomic message-commit RPC dedupes assistant rows by
 * user-message-id, so the worst case is one wasted completion. That is the
 * rare case; refresh-during-response is the common one (every deploy
 * reload, every manual refresh), and we optimise for the common one.
 *
 * Storage-unavailable path (sandboxed iframe, disabled cookies, a
 * private-mode quirk that throws on access): fall back to a per-mount
 * random id. Refresh-survival is lost in that environment, but the chat
 * stays usable.
 */

const HOLDER_KEY = 'nak:holder:id';

function randomId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Resolve the holderId for this device. Idempotent: a second call
 * returns the same value because the read hits the entry the first call
 * wrote. Safe to call from a component mount.
 */
export function resolveHolderId(): string {
  try {
    const local = window.localStorage;
    let id = local.getItem(HOLDER_KEY);
    if (id === null || id.length === 0) {
      id = randomId();
      local.setItem(HOLDER_KEY, id);
    }
    return id;
  } catch {
    // Storage unavailable - sandboxed iframe, disabled cookies, private
    // mode quirk. Fall back to a per-mount random id so the chat stays
    // usable; refresh-survival is lost in this environment.
    return randomId();
  }
}
