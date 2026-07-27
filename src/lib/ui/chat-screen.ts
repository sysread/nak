/**
 * UI-behavior primitives scoped to the Chat screen
 * (src/screens/Chat.svelte). Pure functions only - no runes, no
 * Svelte imports, no DOM. The screen composes these with its own
 * framework-native reactivity; in particular the browser reads
 * (navigator platform sniffing, the 1Hz countdown tick) stay in the
 * component and only their results flow through here.
 *
 * Sibling modules split the chat surface by feature: message-blocks,
 * thread-buckets, incomplete-turn, last-error, recovery-banner,
 * streaming-bubble, reasoning-panel, and friends each own one
 * concern. This module owns the small screen-level decisions that
 * fit none of them.
 *
 * Named `chat-screen.ts` (not `chat.ts`) because `src/lib/chat/` is
 * the domain home - the chat-loop orchestration lives there.
 */

/**
 * Seconds left in a rate-limit wait, rounded up so the countdown
 * never shows 0 while a fraction of a second still remains, and
 * floored at 0 so the template can guard the "resuming in Ns" suffix
 * on a positive value rather than null-checking a separate variable.
 * `waitUntil` is the slot's wake time (epoch ms) or null when no
 * wait is active.
 */
export function rateLimitRemainingSeconds(
  waitUntil: number | null,
  nowMs: number
): number {
  if (waitUntil === null) return 0;
  return Math.max(0, Math.ceil((waitUntil - nowMs) / 1000));
}

/**
 * True when a platform string names a Mac. The caller supplies the
 * string from `navigator.userAgentData.platform` (modern) or
 * `navigator.platform` (legacy fallback) - the navigator read stays
 * in the component; only the classification lives here.
 */
export function isMacPlatform(platform: string): boolean {
  return /mac/i.test(platform);
}

/**
 * Composer-placeholder hint naming the submit shortcut for the
 * platform. Cmd+Enter (U+2318) on macOS, Ctrl+Enter everywhere else
 * - mirroring the onKeydown submit-modifier set, where metaKey is
 * the Command key on macOS and the rarely-pressed Super/Windows key
 * elsewhere.
 *
 * The verb tracks what the keystroke actually does right now: while a
 * reply is streaming the same chord queues the draft for after the
 * turn instead of sending it (see queueMessage in Chat.svelte). The
 * placeholder is the only place that shortcut is discoverable, so it
 * has to say "queues" during the window where it queues.
 */
export function sendHintLabel(isMac: boolean, streaming: boolean): string {
  const chord = isMac ? '\u2318-enter' : 'ctrl-enter';
  return streaming ? `${chord} queues` : `${chord} sends`;
}

/**
 * Disabled state + tooltip for the top-bar "New conversation" button.
 *
 * In the transcript view the button is disabled on an empty thread -
 * clicking it would just mint a second empty draft. While the Daily
 * digest panel covers the transcript, that gating inverts: the button
 * stays enabled and acts as "back to the conversation", because with
 * the transcript hidden a greyed-out primary action reads as "you
 * cannot leave the digest" (the digest toggle icon is the only other
 * way out and does not read as an exit).
 */
export function newThreadButtonState(
  currentIsEmpty: boolean,
  digestOpen: boolean
): { disabled: boolean; title: string } {
  if (digestOpen) {
    return {
      disabled: false,
      title: currentIsEmpty
        ? 'Back to the conversation'
        : 'Start a new conversation',
    };
  }
  return {
    disabled: currentIsEmpty,
    title: currentIsEmpty
      ? "You're already on an empty thread."
      : 'Start a new conversation',
  };
}
