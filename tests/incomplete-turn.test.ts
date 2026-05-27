/**
 * Unit coverage for the incomplete-turn classification primitive.
 * Pure function - no runes, no DOM - tested via plain vitest. The
 * companion `src/screens/Chat.svelte` uses it both to decide whether
 * to show the "response appears to have been cut off" banner and to
 * decide whether the retry must replace the tail or continue from it.
 */
import { describe, it, expect } from 'vitest';
import type { Message } from '../src/lib/supabase';
import { isReasoningOnlyStall } from '../src/lib/ui/incomplete-turn';

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
});
