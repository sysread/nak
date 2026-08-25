import { describe, expect, it } from 'vitest';
import {
  canForkAtMessage,
  computeForkRangeIds,
  deleteForkAnchor,
  deleteFromTitle,
  regenerateTitle,
  sharedRowIds,
} from '../src/lib/ui/fork';
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

describe('sharedRowIds', () => {
  const none = new Set<string>();

  it('marks inherited prefix rows as shared', () => {
    const rows = [
      msg({ id: 'p1', thread_id: 'parent', role: 'user' }),
      msg({ id: 'p2', thread_id: 'parent' }),
      msg({ id: 'o1', thread_id: 'own', role: 'user' }),
      msg({ id: 'o2', thread_id: 'own' }),
    ];
    expect(sharedRowIds(rows, 'own', none)).toEqual(new Set(['p1', 'p2']));
  });

  it('marks own rows at-or-before the latest child fork point', () => {
    const rows = [
      msg({ id: 'u1', role: 'user' }),
      msg({ id: 'a1' }),
      msg({ id: 'u2', role: 'user' }),
      msg({ id: 'a2' }),
    ];
    expect(sharedRowIds(rows, 't1', new Set(['a1']))).toEqual(new Set(['u1', 'a1']));
    // The latest fork point wins - the region is a prefix, so an
    // earlier fork point adds nothing beyond the later one.
    expect(sharedRowIds(rows, 't1', new Set(['u1', 'u2']))).toEqual(
      new Set(['u1', 'a1', 'u2'])
    );
  });

  it('combines inherited rows with a later child fork point', () => {
    const rows = [
      msg({ id: 'p1', thread_id: 'parent', role: 'user' }),
      msg({ id: 'o1', thread_id: 'own' }),
      msg({ id: 'o2', thread_id: 'own', role: 'user' }),
      msg({ id: 'o3', thread_id: 'own' }),
    ];
    // A child forked at o1 pushes the boundary past the inherited seam.
    expect(sharedRowIds(rows, 'own', new Set(['o1']))).toEqual(
      new Set(['p1', 'o1'])
    );
  });

  it('is empty for an unforked own-only transcript', () => {
    const rows = [msg({ id: 'u1', role: 'user' }), msg({ id: 'a1' })];
    expect(sharedRowIds(rows, 't1', none)).toEqual(new Set());
  });
});

describe('deleteForkAnchor', () => {
  it('anchors on the immediate predecessor when it qualifies', () => {
    const rows = [
      msg({ id: 'u1', role: 'user' }),
      msg({ id: 'a1' }),
      msg({ id: 'u2', role: 'user' }),
    ];
    expect(deleteForkAnchor(rows, 'u2')?.id).toBe('a1');
  });

  it('walks past rows a fork cannot cut at', () => {
    const rows = [
      msg({ id: 'u1', role: 'user' }),
      msg({
        id: 'mid',
        role: 'assistant',
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{}' } }],
      }),
      msg({ id: 'tl', role: 'tool' }),
      msg({ id: 'u2', role: 'user' }),
    ];
    // The dangling tool row and the mid-round assistant fall out of
    // the fork along with the deleted range - a prefix ending
    // mid-exchange is not a coherent conversation.
    expect(deleteForkAnchor(rows, 'u2')?.id).toBe('u1');
  });

  it('walks past a synthetic recovery row', () => {
    const rows = [
      msg({ id: 'a1' }),
      msg({ id: 'synth', role: 'assistant', synthetic: true }),
      msg({ id: 'u2', role: 'user' }),
    ];
    expect(deleteForkAnchor(rows, 'u2')?.id).toBe('a1');
  });

  it('returns null with nothing anchorable before the range', () => {
    expect(deleteForkAnchor([msg({ id: 'u1', role: 'user' })], 'u1')).toBeNull();
    const onlyTool = [msg({ id: 'tl', role: 'tool' }), msg({ id: 'u2', role: 'user' })];
    expect(deleteForkAnchor(onlyTool, 'u2')).toBeNull();
    expect(deleteForkAnchor([], 'nope')).toBeNull();
  });
});

describe('shared-region tooltip copy', () => {
  it('mentions the fork only when the range is shared', () => {
    expect(deleteFromTitle(false)).not.toContain('fork');
    expect(deleteFromTitle(true)).toContain('continues in a new fork');
    expect(regenerateTitle(false)).not.toContain('fork');
    expect(regenerateTitle(true)).toContain('continues in a new fork');
  });
});
