/**
 * UI-behavior primitives scoped to the Settings modal screen. Pure
 * functions only - no runes, no Svelte imports, no DOM. The companion
 * `src/screens/Settings.svelte` composes these with its own
 * framework-native reactivity (the pane nav, the optimistic-flip
 * persist handlers, the drag/touch reorder gestures, and the markup).
 *
 * Pane-specific primitives live with their feature modules instead of
 * here: model-profile list transforms in `model-profiles.ts`, prompt
 * list transforms in `prompts.ts`, usage-pane display math in
 * `usage.ts`, image-picker options in `image-model-picker.ts`. This
 * module owns the decisions that are genuinely screen-level: form
 * validation and error copy for the Security pane, the auto-apply
 * toggles' confirmation copy, the notification-permission
 * reconciliation, the config-export filename, and the About pane's
 * labels.
 */

// ---------------------------------------------------------------
// Security pane - account-password rotation form
// ---------------------------------------------------------------

/**
 * First validation error for the change-password form, or null when
 * the form is submittable. Check order matches the form's visual
 * order (current, new, confirm) so the reported error is always the
 * topmost offending field.
 */
export function authPasswordError(
  current: string,
  next: string,
  confirm: string
): string | null {
  if (!current) {
    return 'Enter your current account password.';
  }
  // Supabase enforces a 6-character minimum by default. Hold the floor
  // at 8 so the account password is not the weakest link in the chain.
  if (next.length < 8) {
    return 'New password must be at least 8 characters.';
  }
  if (next !== confirm) {
    return 'New password and confirmation do not match.';
  }
  return null;
}

// ---------------------------------------------------------------
// Auto-apply toggle confirmation copy
// ---------------------------------------------------------------

/**
 * Post-save confirmation lines for the modal's simple on/off toggles.
 * Every auto-apply toggle answers the click with a one-liner in the
 * pane's info slot; the OFF variants spell out what keeps working so
 * a user disabling an agent isn't left wondering whether existing
 * data survives. Reply notifications aren't in this table - the ON
 * copy there depends on browser support, see
 * {@link notifyOnCompleteNotice}.
 */
const TOGGLE_NOTICES = {
  intents: {
    on: 'Intents enabled. Nak will begin forming growth intentions from the next daily pass; nothing changes mid-conversation.',
    off: 'Intents disabled. Existing intentions stop influencing replies and the pipeline goes idle; they are kept, not deleted.',
  },
  emphasisMarkdown: {
    on: 'Emphasis markdown enabled.',
    off: 'Emphasis markdown disabled.',
  },
  wikiAutomatic: {
    on: 'Automatic wiki enabled.',
    off: 'Automatic wiki disabled. Manual edits and the per-article "ask agent to update" button still work.',
  },
  wikiRecordExtraction: {
    on: 'Automatic record extraction enabled.',
    off: 'Automatic record extraction disabled. Manually-added records still work; the background agent will stop creating new ones.',
  },
  wikiLibrarian: {
    on: 'Wiki librarian enabled.',
    off: 'Wiki librarian disabled. Existing articles are unaffected.',
  },
  memoryLibrarian: {
    on: 'Memory librarian enabled.',
    off: 'Memory librarian disabled. Existing memories are unaffected.',
  },
} as const;

/** Confirmation line for a toggle flip that just persisted. */
export function toggleNotice(
  setting: keyof typeof TOGGLE_NOTICES,
  enabled: boolean
): string {
  return enabled ? TOGGLE_NOTICES[setting].on : TOGGLE_NOTICES[setting].off;
}

/**
 * Confirmation line for the reply-notifications toggle. The ON copy
 * depends on whether this browser exposes the Notification API at
 * all - on unsupported browsers (iOS Safari in a plain tab) the
 * preference still persists, but the user should know the fallback
 * is the in-app sidebar flag, not an OS popup.
 */
export function notifyOnCompleteNotice(
  enabled: boolean,
  osNotificationsSupported: boolean
): string {
  if (!enabled) return 'Reply notifications disabled.';
  return osNotificationsSupported
    ? 'Reply notifications enabled.'
    : 'Reply notifications enabled. This browser does not support OS notifications, so Nak will flag unread threads in the sidebar instead.';
}

// ---------------------------------------------------------------
// Notification-permission reconciliation
// ---------------------------------------------------------------

/**
 * Whether the pane should show the per-device "enable notifications
 * for this browser" nudge. The `notifyOnComplete` preference syncs
 * across devices via Supabase but the OS-level grant is
 * per-origin-per-browser and doesn't sync, so a user who enabled the
 * toggle on phone arrives at desktop with the preference on and no
 * permission granted - notifications silently broken on the new
 * device. The nudge shows exactly when the preference is on, the
 * browser supports the Notification API, and the grant is missing.
 */
export function notifyPermissionNudgeVisible(
  enabled: boolean,
  supported: boolean,
  permission: NotificationPermission | 'unsupported'
): boolean {
  return enabled && supported && permission !== 'granted';
}

/**
 * Outcome copy for an explicit permission request fired from the
 * nudge button. Maps the browser's answer to the pane's info/error
 * slots:
 *
 *   - 'granted' is the success line.
 *   - 'denied' spells out the browser-settings unblock path, because
 *     Chromium auto-rejects requestPermission() after a prior deny
 *     without showing UI - the user would otherwise keep clicking a
 *     button that silently does nothing.
 *   - anything else ('default' = the user dismissed the prompt
 *     without picking, or 'unsupported') invites a retry - the
 *     gesture chain stays alive, so re-clicking re-shows the prompt.
 */
export function notifyPermissionRequestNotice(
  result: NotificationPermission | 'unsupported'
): { kind: 'info' | 'error'; text: string } {
  if (result === 'granted') {
    return { kind: 'info', text: 'Reply notifications enabled for this browser.' };
  }
  if (result === 'denied') {
    return {
      kind: 'error',
      text: 'Browser notifications are blocked for this site. Allow them in your browser settings, then reload.',
    };
  }
  return {
    kind: 'error',
    text: 'Notifications still off. Click the button again to retry, or allow them in your browser settings.',
  };
}

// ---------------------------------------------------------------
// AI pane - About you fields
// ---------------------------------------------------------------

/**
 * Confirmation line after persisting a free-form About-you field.
 * An empty commit is a deliberate clear (the field is opt-in), so it
 * gets its own acknowledgement instead of a misleading "saved".
 * Expects the canonical trimmed value the persist call returned.
 */
export function userFieldNotice(
  field: 'Name' | 'Location',
  trimmed: string
): string {
  return trimmed.length > 0 ? `${field} saved.` : `${field} cleared.`;
}

// ---------------------------------------------------------------
// Keys pane - config export
// ---------------------------------------------------------------

/**
 * Download filename for the config-export JSON. Timestamped so
 * repeated exports don't silently overwrite each other in the
 * downloads folder; colons and dots are swapped out because they are
 * path-hostile on common filesystems. `now` is injectable so tests
 * can pin the clock; the component omits it.
 */
export function exportConfigFilename(now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  return `nak-config-${stamp}.json`;
}

// ---------------------------------------------------------------
// About pane
// ---------------------------------------------------------------

// Humanize the ISO string Vite stamped at build time. Falls back to
// the raw value on any parse hiccup — e.g. the literal 'dev' that
// shows up during `pnpm dev` (no build step ran, so nothing to
// parse) or on a browser that doesn't speak the en-* locale family.
export function formatBuildTime(iso: string): string {
  const parsed = new Date(iso);
  if (isNaN(parsed.getTime())) return iso;
  return parsed.toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

/**
 * Caption for the About pane's one action button, which is
 * check-for-updates and reload-to-update in a single control. A busy
 * state wins over everything (the click already happened; the label
 * narrates the in-flight work); otherwise the label advertises
 * whichever action a click would take next.
 */
export function aboutActionLabel(
  busy: 'idle' | 'checking' | 'reloading',
  updateAvailable: boolean
): string {
  if (busy === 'reloading') return 'Reloading…';
  if (busy === 'checking') return 'Checking…';
  return updateAvailable ? 'Reload to update' : 'Check for updates';
}
