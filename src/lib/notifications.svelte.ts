/**
 * Thin wrapper around the Web Notifications API plus an in-app "unread
 * thread" Set. Owns the policy for "did a completion finish in a thread
 * the user isn't currently looking at, and if so, how do we tell them":
 *
 *   - If the completed thread IS the active one, do nothing. The user
 *     is already watching the stream.
 *   - If the document is hidden (tab backgrounded, PWA minimised, screen
 *     locked), and the user has both toggled the setting on AND granted
 *     Notification permission, fire an OS-level Notification tagged with
 *     the threadId. Same tag means a second completion on the same thread
 *     collapses into a single notification instead of stacking - the user
 *     only cares that SOMETHING landed, not how many rounds it took.
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
  /** Thread title, used as the notification heading. */
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
  if (args.isActive) return;
  if (!app.notifyOnComplete) {
    // Feature disabled entirely - don't set an unread dot either. The
    // user has explicitly opted out of being told about background
    // completions.
    return;
  }
  const hidden = typeof document !== 'undefined' && document.hidden === true;
  if (hidden && isSupported() && Notification.permission === 'granted') {
    try {
      const notif = new Notification(args.title || 'New reply', {
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
      return;
    } catch {
      // Notification constructor can throw on some Android embedded
      // browsers despite reporting permission=granted. Fall back to
      // the in-app dot so the completion still surfaces somewhere.
    }
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
  if (args.isActive) return;
  if (!app.notifyOnComplete) return;
  const hidden = typeof document !== 'undefined' && document.hidden === true;
  if (hidden && isSupported() && Notification.permission === 'granted') {
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
      return;
    } catch {
      // Notification constructor occasionally throws on Android
      // embedded browsers despite reporting permission=granted; fall
      // back to the unread dot so the pending question still surfaces.
    }
  }
  markThreadUnread(args.threadId);
}

function markThreadUnread(threadId: string): void {
  if (notifications.unread.has(threadId)) return;
  const next = new Set(notifications.unread);
  next.add(threadId);
  notifications.unread = next;
}
