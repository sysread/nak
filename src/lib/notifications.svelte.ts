/**
 * Thin wrapper around the Web Notifications API plus an in-app "unread
 * thread" Set. Owns the policy for "did a completion finish, and if so,
 * how do we tell the user":
 *
 *   - If the completed thread is the active one AND the tab is visible,
 *     do nothing. The user is sitting there watching the stream - they
 *     don't need a popup for content they're already looking at.
 *   - If the document is hidden (tab backgrounded, PWA minimised, screen
 *     locked), and the user has both toggled the setting on AND granted
 *     Notification permission, fire an OS-level Notification tagged with
 *     the threadId. Same tag means a second completion on the same thread
 *     collapses into a single notification instead of stacking - the user
 *     only cares that SOMETHING landed, not how many rounds it took.
 *     This fires regardless of which thread is "active" in the app -
 *     when the tab is hidden the user isn't actually watching anything,
 *     so the same-thread suppression would just deny them the nudge they
 *     came here for.
 *   - Otherwise (document visible but on a different thread, or permission
 *     not granted, or browser has no Notification API), mark the thread
 *     unread. The sidebar renders a small dot on matching rows;
 *     markThreadRead clears it on open.
 *
 * `Notification` is missing entirely on iOS Safari-in-browser tabs (only
 * available to installed PWAs on iOS 16.4+). `isSupported()` tells the
 * Settings pane whether the OS-notification toggle is meaningful at all;
 * on unsupported browsers we still fall back to the in-app unread dot,
 * which works everywhere.
 */

import { app } from './state.svelte';
import { createLogger } from './logger.svelte';

const log = createLogger('notifications');

interface NotificationsState {
  /** Thread ids that have received a completion while the user was elsewhere. */
  unread: Set<string>;
}

export const notifications = $state<NotificationsState>({
  unread: new Set<string>(),
});

export function markThreadRead(threadId: string): void {
  if (!notifications.unread.has(threadId)) return;
  // Svelte 5 rune reactivity on Set needs a reassignment to trigger
  // subscribers - mutating the existing instance in place wouldn't
  // re-run the sidebar's derived badges.
  const next = new Set(notifications.unread);
  next.delete(threadId);
  notifications.unread = next;
}

export function isSupported(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window;
}

type PermissionState = NotificationPermission | 'unsupported';

/**
 * Thin wrapper over `Notification.requestPermission()`. The modern
 * promise form returns on every browser we target (Chrome, Firefox,
 * Safari 16+, Edge). Returns 'unsupported' where the API is absent
 * entirely (iOS Safari-in-browser tabs).
 */
export async function requestPermission(): Promise<PermissionState> {
  if (!isSupported()) return 'unsupported';
  try {
    return await Notification.requestPermission();
  } catch {
    // Some browsers reject rather than returning 'denied' when the user
    // has blocked the site at the OS level - treat both the same.
    return 'denied';
  }
}

function iconUrl(): string {
  // Honour Vite's BASE_URL so the manifest icon resolves correctly on
  // the GitHub Pages base path as well as on local dev.
  return `${import.meta.env.BASE_URL}icon.svg`;
}

export interface NotifyArgs {
  threadId: string;
  /**
   * Raw thread title. May be the empty string for threads that haven't
   * been auto-titled yet - the notification function interpolates a
   * generic heading when that's the case rather than rendering an
   * unhelpful "Nak replied to ''" line.
   */
  title: string;
  /** True iff this thread is the one the user is currently viewing. */
  isActive: boolean;
  /**
   * Called when the user clicks the OS notification. The service focuses
   * the window first; the callback is responsible for navigating to the
   * thread.
   */
  onClick: (threadId: string) => void;
}

/**
 * Single entry point for the caller to say "a reply just landed in
 * thread X." Gated on `app.notifyOnComplete`; the caller doesn't have
 * to check the setting itself.
 */
export function notifyTurnComplete(args: NotifyArgs): void {
  // Capture the gating state up front so the debug entry covers every
  // factor the function will branch on. Same factors appear in
  // notifyAskUser - keep them in sync. Read from runtime state rather
  // than constants so the drawer reflects the actual decision being
  // made on this call, not a stale snapshot.
  const supported = isSupported();
  const permission = supported ? Notification.permission : 'unsupported';
  const hidden = typeof document !== 'undefined' && document.hidden === true;
  const visibilityState =
    typeof document !== 'undefined' ? document.visibilityState : 'unknown';
  log.debug('notifyTurnComplete', {
    threadId: args.threadId,
    isActive: args.isActive,
    notifyOnComplete: app.notifyOnComplete,
    supported,
    permission,
    hidden,
    visibilityState,
  });
  // "Watching the stream" requires BOTH the thread being active AND
  // the tab being visible. If the tab is hidden the user is elsewhere -
  // they're not watching anything, and the OS notification is the only
  // signal they'll get that the reply landed. Suppressing it here just
  // because the active thread happens to match would silently deny the
  // notification the user explicitly opted in to.
  if (args.isActive && !hidden) {
    log.debug('notifyTurnComplete: skipped (thread active + tab visible)', {
      threadId: args.threadId,
    });
    return;
  }
  if (!app.notifyOnComplete) {
    // Feature disabled entirely - don't set an unread dot either. The
    // user has explicitly opted out of being told about background
    // completions.
    log.debug('notifyTurnComplete: skipped (notifyOnComplete=false)', {
      threadId: args.threadId,
    });
    return;
  }
  if (hidden && supported && permission === 'granted') {
    try {
      // Heading carries the full "Nak replied to X" sentence so the
      // user sees the conversation name in the prominent bold line
      // of the notification banner - macOS in particular collapses
      // the body to a single line at the default banner style, so
      // putting the title there would risk it being clipped.
      const heading = args.title
        ? `Nak replied to "${args.title}"`
        : 'Nak replied';
      const notif = new Notification(heading, {
        body: 'Your reply is ready.',
        icon: iconUrl(),
        tag: args.threadId,
      });
      notif.onclick = () => {
        try {
          window.focus();
        } catch {
          // focus() can throw on hostile popup-blocker environments;
          // fall through to the navigation so the user still lands on
          // the thread even if the window itself doesn't raise.
        }
        args.onClick(args.threadId);
        notif.close();
      };
      log.debug('notifyTurnComplete: fired OS notification', {
        threadId: args.threadId,
        tag: args.threadId,
      });
      return;
    } catch (err) {
      // Notification constructor can throw on some Android embedded
      // browsers despite reporting permission=granted. Fall back to
      // the in-app dot so the completion still surfaces somewhere.
      log.warn('notifyTurnComplete: Notification constructor threw', {
        threadId: args.threadId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  } else {
    // Spell out which precondition failed - the most common cause of
    // "I don't see notifications" reports is one of these three:
    // tab in foreground, browser missing the API entirely, or
    // permission not granted on this device.
    log.debug('notifyTurnComplete: falling back to unread dot', {
      threadId: args.threadId,
      reason: !hidden
        ? 'document is visible (tab in foreground)'
        : !supported
          ? 'browser lacks Notification API'
          : `permission is ${permission} (not granted)`,
    });
  }
  markThreadUnread(args.threadId);
}

/**
 * Maximum body length for the ask_user notification. iOS PWA
 * notifications silently truncate long bodies; capping at ~120 chars
 * keeps the question visible on every platform. Android and desktop
 * are more forgiving but the cap is uniform for simplicity.
 */
const ASK_USER_BODY_MAX_CHARS = 120;

export interface NotifyAskUserArgs {
  threadId: string;
  /** Thread title, used as the notification heading. */
  title: string;
  /** The clarifying question text, used as the body. */
  question: string;
  /** True iff this thread is the one the user is currently viewing. */
  isActive: boolean;
  onClick: (threadId: string) => void;
}

/**
 * Sibling of `notifyTurnComplete` for the ask_user suspended-loop
 * state: an OS notification when the tab is backgrounded so the user
 * knows the model is asking them something, with the question itself
 * as the body so they can decide whether to switch back without first
 * unlocking and reopening the app. Tagged distinctly from
 * `notifyTurnComplete` so a later completion in the same thread does
 * not collapse this notification away.
 *
 * Falls back to the in-app unread dot when the OS path isn't
 * available (permission denied, document visible elsewhere, browser
 * lacks Notification API). The pending question card in the message
 * list is the durable signal regardless - this is a nudge, not the
 * notification of record.
 */
export function notifyAskUser(args: NotifyAskUserArgs): void {
  const supported = isSupported();
  const permission = supported ? Notification.permission : 'unsupported';
  const hidden = typeof document !== 'undefined' && document.hidden === true;
  const visibilityState =
    typeof document !== 'undefined' ? document.visibilityState : 'unknown';
  log.debug('notifyAskUser', {
    threadId: args.threadId,
    isActive: args.isActive,
    notifyOnComplete: app.notifyOnComplete,
    supported,
    permission,
    hidden,
    visibilityState,
  });
  // Same "watching = active AND visible" rule as notifyTurnComplete.
  // See that function's comment for the reasoning.
  if (args.isActive && !hidden) {
    log.debug('notifyAskUser: skipped (thread active + tab visible)', {
      threadId: args.threadId,
    });
    return;
  }
  if (!app.notifyOnComplete) {
    log.debug('notifyAskUser: skipped (notifyOnComplete=false)', {
      threadId: args.threadId,
    });
    return;
  }
  if (hidden && supported && permission === 'granted') {
    try {
      const truncated =
        args.question.length > ASK_USER_BODY_MAX_CHARS
          ? args.question.slice(0, ASK_USER_BODY_MAX_CHARS - 1).trimEnd() + '…'
          : args.question;
      const notif = new Notification(args.title || 'Question for you', {
        body: truncated || 'The assistant is waiting for an answer.',
        icon: iconUrl(),
        // Distinct prefix so completion + ask notifications don't
        // collapse onto each other - the user might have both states
        // pending across two threads.
        tag: `ask:${args.threadId}`,
      });
      notif.onclick = () => {
        try {
          window.focus();
        } catch {
          // focus() can throw on hostile popup-blocker environments;
          // fall through so the user still lands on the thread.
        }
        args.onClick(args.threadId);
        notif.close();
      };
      log.debug('notifyAskUser: fired OS notification', {
        threadId: args.threadId,
        tag: `ask:${args.threadId}`,
      });
      return;
    } catch (err) {
      // Notification constructor occasionally throws on Android
      // embedded browsers despite reporting permission=granted; fall
      // back to the unread dot so the pending question still surfaces.
      log.warn('notifyAskUser: Notification constructor threw', {
        threadId: args.threadId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  } else {
    log.debug('notifyAskUser: falling back to unread dot', {
      threadId: args.threadId,
      reason: !hidden
        ? 'document is visible (tab in foreground)'
        : !supported
          ? 'browser lacks Notification API'
          : `permission is ${permission} (not granted)`,
    });
  }
  markThreadUnread(args.threadId);
}

function markThreadUnread(threadId: string): void {
  if (notifications.unread.has(threadId)) return;
  const next = new Set(notifications.unread);
  next.add(threadId);
  notifications.unread = next;
}
