import { describe, expect, it } from 'vitest';
import { canForkAtMessage, computeForkRangeIds } from '../src/lib/ui/fork';
import type { Message } from '../src/lib/supabase';

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

describe('canForkAtMessage', () => {
  it('offers the button on user rows and terminal assistant rows', () => {
    expect(canForkAtMessage(msg({ role: 'user' }))).toBe(true);
    expect(canForkAtMessage(msg({ role: 'assistant' }))).toBe(true);
    expect(canForkAtMessage(msg({ role: 'assistant', tool_calls: [] }))).toBe(true);
  });

  it('hides it on mid-round assistant rows and tool rows', () => {
    expect(
      canForkAtMessage(
        msg({
          role: 'assistant',
          tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{}' } }],
        }),
      ),
    ).toBe(false);
    expect(canForkAtMessage(msg({ role: 'tool' }))).toBe(false);
  });

  it('hides it on a still-streaming assistant row', () => {
    expect(canForkAtMessage(msg({ role: 'assistant', status: 'streaming' }))).toBe(false);
    expect(canForkAtMessage(msg({ role: 'assistant', status: 'aborted' }))).toBe(true);
  });

  it('hides it on synthetic recovery rows - their sentinel ids have no DB row to fork from', () => {
    expect(canForkAtMessage(msg({ role: 'user', synthetic: true }))).toBe(false);
  });
});

describe('computeForkRangeIds', () => {
  const conversation = [
    msg({ id: 'u1', role: 'user' }),
    msg({ id: 'a1' }),
    msg({ id: 'u2', role: 'user' }),
    msg({ id: 'a2' }),
  ];

  it('outlines every row after the fork point, excluding the point itself', () => {
    expect(computeForkRangeIds(conversation, 'a1')).toEqual(['u2', 'a2']);
    expect(computeForkRangeIds(conversation, 'u1')).toEqual(['a1', 'u2', 'a2']);
  });

  it('returns empty at the transcript tail - a tail fork leaves nothing behind', () => {
    expect(computeForkRangeIds(conversation, 'a2')).toEqual([]);
  });

  it('returns empty for an unknown id or an ineligible row', () => {
    expect(computeForkRangeIds(conversation, 'nope')).toEqual([]);
    const withTool = [
      msg({ id: 'u1', role: 'user' }),
      msg({
        id: 'a1',
        role: 'assistant',
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{}' } }],
      }),
      msg({ id: 't1r', role: 'tool' }),
    ];
    expect(computeForkRangeIds(withTool, 'a1')).toEqual([]);
  });
});
