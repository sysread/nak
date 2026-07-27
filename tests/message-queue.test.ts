/**
 * Coverage for the send-while-streaming queue's UI primitives
 * (src/lib/ui/message-queue.ts). Pure functions - plain vitest, no
 * mount; the queue array itself lives on the ExchangeSlot and the
 * keystroke wiring lives in Chat.svelte.
 */
import { describe, it, expect } from 'vitest';
import {
  queuedAttachmentSummary,
  queuedHeadline,
  sendButtonState,
  shouldDrainQueue,
  type QueuedMessage,
} from '../src/lib/ui/message-queue';

const IDLE = {
  sending: false,
  queuedCount: 0,
  stopSettled: false,
  composerEmpty: false,
  archived: false,
  respondingElsewhere: false,
};

describe('sendButtonState', () => {
  it('sends when idle with something to send', () => {
    expect(sendButtonState(IDLE)).toEqual({
      mode: 'send',
      disabled: false,
      title: 'Send',
      ariaLabel: 'Send',
    });
  });

  it('disables the idle send on an empty composer, an archive, or a foreign claim', () => {
    expect(sendButtonState({ ...IDLE, composerEmpty: true }).disabled).toBe(true);
    expect(sendButtonState({ ...IDLE, archived: true }).disabled).toBe(true);
    expect(sendButtonState({ ...IDLE, respondingElsewhere: true }).disabled).toBe(true);
  });

  it('explains the idle disable in the tooltip, foreign claim first', () => {
    expect(sendButtonState({ ...IDLE, archived: true }).title).toBe(
      'Archived - restore to continue'
    );
    expect(
      sendButtonState({ ...IDLE, archived: true, respondingElsewhere: true }).title
    ).toBe('Another device is responding to this conversation');
  });

  it('becomes a plain stop while a turn streams with nothing queued', () => {
    expect(sendButtonState({ ...IDLE, sending: true })).toEqual({
      mode: 'stop',
      disabled: false,
      title: 'Stop response',
      ariaLabel: 'Stop response',
    });
  });

  it('ignores the send-path disable rules while streaming - stop must stay clickable', () => {
    const streaming = {
      ...IDLE,
      sending: true,
      composerEmpty: true,
      archived: true,
      respondingElsewhere: true,
    };
    expect(sendButtonState(streaming).disabled).toBe(false);
    expect(sendButtonState({ ...streaming, queuedCount: 2 }).disabled).toBe(false);
  });

  it('disables stop only once the abort has already landed', () => {
    expect(sendButtonState({ ...IDLE, sending: true, stopSettled: true }).disabled).toBe(
      true
    );
  });

  it('becomes stop-and-continue once messages are queued behind the stream', () => {
    expect(sendButtonState({ ...IDLE, sending: true, queuedCount: 1 })).toEqual({
      mode: 'continue',
      disabled: false,
      title: 'Stop and send 1 queued message now',
      ariaLabel: 'Stop response and send 1 queued message',
    });
    expect(sendButtonState({ ...IDLE, sending: true, queuedCount: 3 }).title).toBe(
      'Stop and send 3 queued messages now'
    );
  });

  it('stays a plain send when messages are queued but no turn is running', () => {
    // The drain empties the queue at the tail of every settled turn, so
    // this pairs with the one case that keeps a queue past the turn: a
    // turn that ended on an error. The button must go back to meaning
    // "send what is in the composer" there, not offer to stop nothing.
    expect(sendButtonState({ ...IDLE, queuedCount: 2 }).mode).toBe('send');
  });
});

describe('shouldDrainQueue', () => {
  const live = { archived: false };

  it('drains a non-empty queue on a clean settled turn', () => {
    expect(shouldDrainQueue(1, false, live)).toBe(true);
    expect(shouldDrainQueue(3, false, live)).toBe(true);
  });

  it('does nothing when nothing is queued', () => {
    expect(shouldDrainQueue(0, false, live)).toBe(false);
  });

  it('holds the queue back when the turn left an error banner', () => {
    // The rule with the most consequence: a rate-limit exhaustion or a
    // cross-device preemption must not be buried under a fresh turn that
    // would likely fail the same way. The queue is HELD, not dropped -
    // the caller leaves it on the slot for a later successful turn.
    expect(shouldDrainQueue(2, true, live)).toBe(false);
  });

  it('drains after a deliberate stop, which is not an error', () => {
    // runExchange's catch clears the slot's streamingError on a
    // user-initiated abort, so a stop reaches the tail looking clean.
    // This is what gives the stop button its "and send mine now"
    // meaning - if a stop registered as an error here, the queue would
    // silently never fire.
    expect(shouldDrainQueue(1, false, live)).toBe(true);
  });

  it('refuses a thread that vanished, is archived, or was never materialized', () => {
    expect(shouldDrainQueue(1, false, null)).toBe(false);
    expect(shouldDrainQueue(1, false, { archived: true })).toBe(false);
    expect(shouldDrainQueue(1, false, { archived: false, isDraft: true })).toBe(false);
  });
});

describe('queuedHeadline', () => {
  it('says what happens next rather than only counting', () => {
    expect(queuedHeadline(1)).toBe('Queued - sends when this reply finishes');
    expect(queuedHeadline(3)).toBe('3 queued - send when this reply finishes');
  });
});

describe('queuedAttachmentSummary', () => {
  const entry = (text: string, attachmentCount: number): QueuedMessage => ({
    id: 'q1',
    text,
    // The primitive only counts them, so the shape below is irrelevant
    // to it; cast keeps the test from restating the whole
    // LocalAttachment record.
    attachments: Array.from({ length: attachmentCount }, () => ({})) as never,
  });

  it('is null when the message carries no files', () => {
    expect(queuedAttachmentSummary(entry('just words', 0))).toBeNull();
    expect(queuedAttachmentSummary(entry('', 0))).toBeNull();
  });

  it('counts the files alongside text as well as on a text-free message', () => {
    expect(queuedAttachmentSummary(entry('look at this', 1))).toBe('1 attachment');
    expect(queuedAttachmentSummary(entry('', 4))).toBe('4 attachments');
  });
});
