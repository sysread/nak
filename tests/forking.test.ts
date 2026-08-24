import { describe, expect, it } from 'vitest';
import {
  isValidForkPoint,
  pickForkPoint,
  type ForkPointCandidate,
} from '../src/lib/forking';

function row(over: Partial<ForkPointCandidate>): ForkPointCandidate {
  return {
    id: 'm1',
    role: 'user',
    tool_calls: null,
    status: null,
    ...over,
  };
}

describe('isValidForkPoint', () => {
  it('accepts user rows', () => {
    expect(isValidForkPoint(row({ role: 'user' }))).toBe(true);
  });

  it('accepts terminal assistant rows (no tool calls)', () => {
    expect(isValidForkPoint(row({ role: 'assistant', tool_calls: null }))).toBe(true);
    expect(isValidForkPoint(row({ role: 'assistant', tool_calls: [] }))).toBe(true);
  });

  it('rejects mid-round assistant rows carrying tool calls', () => {
    expect(
      isValidForkPoint(row({ role: 'assistant', tool_calls: [{ id: 'c1' }] }))
    ).toBe(false);
  });

  it('rejects tool and system rows', () => {
    expect(isValidForkPoint(row({ role: 'tool' }))).toBe(false);
    expect(isValidForkPoint(row({ role: 'system' }))).toBe(false);
  });

  it('rejects a still-streaming assistant row - its content is not settled', () => {
    expect(
      isValidForkPoint(row({ role: 'assistant', status: 'streaming' }))
    ).toBe(false);
  });

  it('accepts settled terminal statuses (aborted / error rows are conversation content)', () => {
    expect(isValidForkPoint(row({ role: 'assistant', status: 'complete' }))).toBe(true);
    expect(isValidForkPoint(row({ role: 'assistant', status: 'aborted' }))).toBe(true);
  });
});

describe('pickForkPoint', () => {
  it('picks the newest row when it qualifies', () => {
    const picked = pickForkPoint([
      row({ id: 'newest', role: 'assistant' }),
      row({ id: 'older', role: 'user' }),
    ]);
    expect(picked?.id).toBe('newest');
  });

  it('walks past a dangling tool row and a mid-round assistant to the anchor', () => {
    const picked = pickForkPoint([
      row({ id: 'dangling-tool', role: 'tool' }),
      row({ id: 'mid-round', role: 'assistant', tool_calls: [{ id: 'c1' }] }),
      row({ id: 'anchor', role: 'user' }),
    ]);
    expect(picked?.id).toBe('anchor');
  });

  it('walks past a streaming tail row', () => {
    const picked = pickForkPoint([
      row({ id: 'inflight', role: 'assistant', status: 'streaming' }),
      row({ id: 'anchor', role: 'user' }),
    ]);
    expect(picked?.id).toBe('anchor');
  });

  it('returns null when nothing qualifies (empty or all mid-round)', () => {
    expect(pickForkPoint([])).toBeNull();
    expect(
      pickForkPoint([
        row({ role: 'tool' }),
        row({ role: 'assistant', tool_calls: [{ id: 'c1' }] }),
      ])
    ).toBeNull();
  });
});
