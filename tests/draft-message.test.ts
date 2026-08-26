/**
 * Coverage for the draft-message primitive
 * (src/lib/ui/draft-message.ts). Pure function - plain vitest, no
 * mount, no harness.
 */
import { describe, it, expect } from 'vitest';
import type { Message } from '../src/lib/supabase';
import { findDraftMessage } from '../src/lib/ui/draft-message';

let seq = 0;
function msg(over: Partial<Message>): Message {
  seq += 1;
  return {
    id: `m${seq}`,
    thread_id: 't1',
    role: 'user',
    content: '',
    created_at: '2024-01-01T00:00:00Z',
    ...over,
  } as Message;
}

describe('findDraftMessage', () => {
  it('returns null when no draft exists', () => {
    const messages = [msg({ id: 'u1', status: null }), msg({ id: 'a1', role: 'assistant', status: 'complete' })];
    expect(findDraftMessage(messages)).toBeNull();
  });

  it('finds a draft at the tail', () => {
    const u = msg({ id: 'u1', status: null });
    const a = msg({ id: 'a1', role: 'assistant', status: 'complete' });
    const draft = msg({ id: 'd1', status: 'draft', content: 'edited text' });
    expect(findDraftMessage([u, a, draft])).toBe(draft);
  });

  it('finds a draft even when not at the tail (defensive)', () => {
    const draft = msg({ id: 'd1', status: 'draft', content: 'mid draft' });
    const u2 = msg({ id: 'u2', status: null });
    expect(findDraftMessage([draft, u2])).toBe(draft);
  });

  it('returns the first draft when multiple exist (should not happen but safe)', () => {
    const d1 = msg({ id: 'd1', status: 'draft', content: 'first' });
    const d2 = msg({ id: 'd2', status: 'draft', content: 'second' });
    expect(findDraftMessage([d1, d2])).toBe(d1);
  });

  it('ignores non-draft statuses', () => {
    const messages = [
      msg({ id: 's1', role: 'assistant', status: 'streaming' }),
      msg({ id: 'c1', role: 'assistant', status: 'complete' }),
      msg({ id: 'e1', role: 'assistant', status: 'error' }),
    ];
    expect(findDraftMessage(messages)).toBeNull();
  });

  it('returns null on an empty list', () => {
    expect(findDraftMessage([])).toBeNull();
  });
});
