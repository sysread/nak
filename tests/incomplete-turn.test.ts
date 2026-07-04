/**
 * Unit coverage for the incomplete-turn classification primitive.
 * Pure function - no runes, no DOM - tested via plain vitest. The
 * companion `src/screens/Chat.svelte` uses it both to decide whether
 * to show the "response appears to have been cut off" banner and to
 * decide whether the retry must replace the tail or continue from it.
 */
import { describe, it, expect } from 'vitest';
import type { Message } from '../src/lib/supabase';
import {
  classifyIncompleteTurnTail,
  isReasoningOnlyStall,
  isCutOffPartialText,
} from '../src/lib/ui/incomplete-turn';
import { ASK_USER_PENDING_FLAG, ASK_USER_ANSWERED_FLAG } from '../src/lib/ask-user';

function msg(over: Partial<Message>): Message {
  return {
    id: 'm1',
    thread_id: 't1',
    role: 'assistant',
    content: '',
    created_at: '2024-01-01T00:00:00Z',
    ...over,
  } as Message;
}

describe('isReasoningOnlyStall', () => {
  it('is true for an assistant row with reasoning but no content or tool calls', () => {
    expect(isReasoningOnlyStall(msg({ content: '', reasoning: 'thinking...' }))).toBe(true);
  });

  it('treats whitespace-only content as empty', () => {
    expect(isReasoningOnlyStall(msg({ content: '   \n', reasoning: 'thinking...' }))).toBe(true);
  });

  it('is false when there is visible content', () => {
    expect(isReasoningOnlyStall(msg({ content: 'Here is the answer.', reasoning: 'thinking...' }))).toBe(false);
  });

  it('is false when reasoning is empty or whitespace', () => {
    expect(isReasoningOnlyStall(msg({ content: '', reasoning: '' }))).toBe(false);
    expect(isReasoningOnlyStall(msg({ content: '', reasoning: '  ' }))).toBe(false);
    expect(isReasoningOnlyStall(msg({ content: '', reasoning: null }))).toBe(false);
  });

  it('is false when the row carries tool calls (a real tool round, not a stall)', () => {
    expect(
      isReasoningOnlyStall(
        msg({
          content: '',
          reasoning: 'thinking...',
          tool_calls: [
            { id: 'c1', type: 'function', function: { name: 'web_search', arguments: '{}' } },
          ],
        })
      )
    ).toBe(false);
  });

  it('is false for non-assistant roles', () => {
    expect(isReasoningOnlyStall(msg({ role: 'user', content: '', reasoning: 'x' }))).toBe(false);
    expect(isReasoningOnlyStall(msg({ role: 'tool', content: '', reasoning: 'x' }))).toBe(false);
  });

  it('is false for a user-initiated stop during a reasoning-only stretch (status aborted)', () => {
    // A stop that landed before any visible text produces a marker-only
    // row whose reasoning survives. That is a deliberate endpoint, not a
    // stall to re-roll - the status gate, not the incidental marker,
    // keeps it off the retry path (and keeps a second device in agreement).
    expect(
      isReasoningOnlyStall(msg({ content: '', reasoning: 'thinking...', status: 'aborted' }))
    ).toBe(false);
  });
});

describe('isCutOffPartialText', () => {
  it('is true for an error-status assistant row with visible content and no tool calls', () => {
    expect(
      isCutOffPartialText(msg({ content: 'Here is the first half of the ans', status: 'error' }))
    ).toBe(true);
  });

  it('is false when the row finished cleanly (status complete)', () => {
    // A legitimately short reply commits as 'complete' and must stay a
    // continuation point, never a replace target.
    expect(isCutOffPartialText(msg({ content: 'Yes.', status: 'complete' }))).toBe(false);
  });

  it('is false for a user-initiated stop (status aborted)', () => {
    // An aborted reply carries the interrupted marker and is a
    // deliberate endpoint, not a cutoff to re-roll.
    expect(
      isCutOffPartialText(msg({ content: 'partial...', status: 'aborted' }))
    ).toBe(false);
  });

  it('is false when status is missing (legacy rows / no terminal mark)', () => {
    expect(isCutOffPartialText(msg({ content: 'partial...', status: null }))).toBe(false);
    expect(isCutOffPartialText(msg({ content: 'partial...' }))).toBe(false);
  });

  it('treats whitespace-only content as empty (a reasoning-only stall, not partial text)', () => {
    expect(
      isCutOffPartialText(msg({ content: '  \n', status: 'error', reasoning: 'thinking...' }))
    ).toBe(false);
  });

  it('is false when the row carries tool calls (a continuation point, not a dead tail)', () => {
    expect(
      isCutOffPartialText(
        msg({
          content: 'about to call a tool',
          status: 'error',
          tool_calls: [
            { id: 'c1', type: 'function', function: { name: 'web_search', arguments: '{}' } },
          ],
        })
      )
    ).toBe(false);
  });

  it('is false for non-assistant roles', () => {
    expect(isCutOffPartialText(msg({ role: 'user', content: 'x', status: 'error' }))).toBe(false);
    expect(isCutOffPartialText(msg({ role: 'tool', content: 'x', status: 'error' }))).toBe(false);
  });
});

describe('classifyIncompleteTurnTail', () => {
  it('returns null for an empty transcript', () => {
    expect(classifyIncompleteTurnTail([])).toBeNull();
  });

  it('flags a bare user-message tail (first round never wrote anything)', () => {
    const user = msg({ id: 'u1', role: 'user', content: 'hi' });
    expect(classifyIncompleteTurnTail([user])).toBe(user);
  });

  it('flags a tool-row tail (tool round completed, next round never landed)', () => {
    const tail = msg({ id: 'r1', role: 'tool', content: '{"ok":1}' });
    expect(classifyIncompleteTurnTail([msg({ role: 'user' }), tail])).toBe(tail);
  });

  it('suppresses the pending ask_user sentinel tail (deliberate suspension, not a cut-off)', () => {
    const pending = msg({
      role: 'tool',
      content: JSON.stringify({
        [ASK_USER_PENDING_FLAG]: true,
        question: 'which?',
        options: [{ label: 'A', description: 'a' }],
      }),
    });
    expect(classifyIncompleteTurnTail([msg({ role: 'user' }), pending])).toBeNull();
  });

  it('keeps an answered/abandoned ask_user tail retry-able (it still lacks a follow-up turn)', () => {
    const answered = msg({
      role: 'tool',
      content: JSON.stringify({
        [ASK_USER_ANSWERED_FLAG]: true,
        answer: 'A',
        via: 'option',
      }),
    });
    expect(classifyIncompleteTurnTail([msg({ role: 'user' }), answered])).toBe(answered);
  });

  it('flags an assistant tail whose tool_calls never got result rows', () => {
    const tail = msg({
      content: '',
      tool_calls: [
        { id: 'c1', type: 'function', function: { name: 'web_search', arguments: '{}' } },
      ],
    });
    expect(classifyIncompleteTurnTail([msg({ role: 'user' }), tail])).toBe(tail);
  });

  it('flags a reasoning-only stall tail and clears a completed reply', () => {
    const stall = msg({ content: '', reasoning: 'thinking...' });
    expect(classifyIncompleteTurnTail([msg({ role: 'user' }), stall])).toBe(stall);
    const done = msg({ content: 'the answer' });
    expect(classifyIncompleteTurnTail([msg({ role: 'user' }), done])).toBeNull();
  });

  it('never flags an aborted tail - a deliberate stop is an endpoint on every device', () => {
    const stoppedMidTool = msg({
      status: 'aborted',
      content: '',
      tool_calls: [
        { id: 'c1', type: 'function', function: { name: 'web_search', arguments: '{}' } },
      ],
    });
    expect(classifyIncompleteTurnTail([msg({ role: 'user' }), stoppedMidTool])).toBeNull();
    const stoppedMidReasoning = msg({ status: 'aborted', content: '', reasoning: 'part...' });
    expect(
      classifyIncompleteTurnTail([msg({ role: 'user' }), stoppedMidReasoning])
    ).toBeNull();
  });
});
