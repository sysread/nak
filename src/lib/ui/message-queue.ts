/**
 * UI-behavior primitives for the composer's send-while-streaming
 * queue: the messages a user banks with the submit-modifier Enter
 * while a reply is still generating, and the copy that tells them
 * what the send/stop button will do about it.
 *
 * Pure functions only - no runes, no Svelte imports, no DOM. The
 * queue itself lives on the per-thread `ExchangeSlot`
 * (`src/lib/exchange/exchange-slot.svelte.ts`) because it is
 * thread-scoped state, and `Chat.svelte` owns the keystroke wiring
 * and the drain. See `docs/dev/chat.md` ("Queued messages") for the
 * end-to-end flow.
 */

import type { LocalAttachment } from '../attachments';
import type { Thread } from '../supabase';

/**
 * One banked composer draft. `attachments` carries the same
 * already-uploaded LocalAttachment chips a direct send would have
 * consumed, so a queued message that fires later produces byte-identical
 * rows to one sent immediately. `id` is client-only - the DB row does
 * not exist until the queue drains.
 */
export interface QueuedMessage {
  id: string;
  text: string;
  attachments: LocalAttachment[];
}

/**
 * Whether a settled turn should fire the messages queued behind it.
 * Called from `maybeDrainQueuedMessages` (Chat.svelte) at the tail of
 * every path that ends a turn.
 *
 * `hasStreamingError` is the load-bearing one, and it is a deliberate
 * "no" rather than an oversight. A turn that ended on a rate-limit
 * exhaustion, a cross-device preemption, or a commit conflict has put a
 * banner in front of the user that a fresh turn would immediately bury,
 * and the retry would most likely fail the same way. The queue is not
 * dropped - it stays on the slot, still rendered as cards, and drains at
 * the tail of whichever later turn succeeds. A user-initiated stop is
 * NOT an error (runExchange's catch clears the slot's error on an abort
 * with no claim loss), so stopping deliberately DOES drain - that is
 * what makes the stop button's "and send mine now" meaning work.
 *
 * `thread` is null when the row vanished mid-turn (deleted on another
 * device); a draft can't be a drain target because a queue can only be
 * created against an in-flight turn, which implies a materialized row.
 */
export function shouldDrainQueue(
  queuedCount: number,
  hasStreamingError: boolean,
  thread: Pick<Thread, 'archived'> & { isDraft?: boolean } | null
): boolean {
  if (queuedCount === 0) return false;
  if (hasStreamingError) return false;
  if (!thread || thread.isDraft === true || thread.archived) return false;
  return true;
}

/**
 * What the send/stop button is currently for. Three modes rather than
 * the two the button had before the queue existed:
 *
 *   'send'     - idle. Fire what's in the composer.
 *   'stop'     - a turn is streaming and nothing is queued. Cancel it,
 *                keeping whatever the model has produced so far.
 *   'continue' - a turn is streaming AND messages are queued. Same
 *                cancel (completed tool rounds and partial text are
 *                still preserved server-side), but the queue fires
 *                immediately after instead of waiting for a reply the
 *                user has stopped caring about.
 */
type SendButtonMode = 'send' | 'stop' | 'continue';

interface SendButtonInputs {
  sending: boolean;
  queuedCount: number;
  /** True once the abort controller is gone - a stop already landed. */
  stopSettled: boolean;
  /** Composer has neither text nor a ready attachment. */
  composerEmpty: boolean;
  archived: boolean;
  respondingElsewhere: boolean;
}

interface SendButtonState {
  mode: SendButtonMode;
  disabled: boolean;
  title: string;
  ariaLabel: string;
}

/**
 * Resolve the dual-purpose composer button's mode, disabled state, and
 * labels in one pass.
 *
 * While a turn is in flight the send-path disabled rules (empty
 * composer, archived thread, another device responding) are deliberately
 * ignored: stop must always be clickable once a response is running,
 * regardless of what the user has typed next.
 */
export function sendButtonState(inputs: SendButtonInputs): SendButtonState {
  const { sending, queuedCount, stopSettled, composerEmpty, archived, respondingElsewhere } =
    inputs;
  if (sending && queuedCount > 0) {
    return {
      mode: 'continue',
      disabled: stopSettled,
      title: `Stop and send ${queuedLabel(queuedCount)} now`,
      ariaLabel: `Stop response and send ${queuedLabel(queuedCount)}`,
    };
  }
  if (sending) {
    return {
      mode: 'stop',
      disabled: stopSettled,
      title: 'Stop response',
      ariaLabel: 'Stop response',
    };
  }
  return {
    mode: 'send',
    disabled: composerEmpty || archived || respondingElsewhere,
    title: respondingElsewhere
      ? 'Another device is responding to this conversation'
      : archived
        ? 'Archived - restore to continue'
        : 'Send',
    ariaLabel: 'Send',
  };
}

/** "1 queued message" / "N queued messages" - the noun the button titles interpolate. */
function queuedLabel(count: number): string {
  return count === 1 ? '1 queued message' : `${count} queued messages`;
}

/**
 * Heading above the queued-card stack in the transcript. Names what
 * happens next rather than just counting, because the cards look like
 * sent messages and the distinction (these have NOT gone out yet) is
 * the whole point of rendering them.
 */
export function queuedHeadline(count: number): string {
  return count === 1
    ? 'Queued - sends when this reply finishes'
    : `${count} queued - send when this reply finishes`;
}

/**
 * Sub-line naming the files riding with a queued message, or null when
 * it carries none. A count rather than the chip tray the composer shows:
 * the card is a reminder of what is pending, not an editing surface -
 * the way to change the files is to un-queue the message, which puts
 * the chips back in the composer. It renders for a text-carrying entry
 * too, because a queued message can be attachments-only (a user can
 * queue "look at this" with no text at all) and a card that showed
 * nothing in that case would read as empty.
 */
export function queuedAttachmentSummary(entry: QueuedMessage): string | null {
  const n = entry.attachments.length;
  if (n === 0) return null;
  return n === 1 ? '1 attachment' : `${n} attachments`;
}
