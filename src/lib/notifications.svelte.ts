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

function markThreadUnread(threadId: string): void {
  if (notifications.unread.has(threadId)) return;
  const next = new Set(notifications.unread);
  next.add(threadId);
  notifications.unread = next;
}
