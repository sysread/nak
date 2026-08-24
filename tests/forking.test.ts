import { describe, expect, it } from 'vitest';
import {
  FORK_TITLE_SIGIL,
  forkTitle,
  isValidForkPoint,
  pickForkPoint,
  PLACEHOLDER_TITLE,
  stripForkTitlePrefix,
  subscriptNumber,
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

describe('fork titles', () => {
  it('renders ordinals as subscript digits', () => {
    expect(subscriptNumber(1)).toBe('₁');
    expect(subscriptNumber(12)).toBe('₁₂');
    // Clamped to a positive integer - a drifting count can't render an
    // empty or negative subscript.
    expect(subscriptNumber(0)).toBe('₁');
  });

  it('marks the nth fork of a titled source', () => {
    expect(forkTitle('Sourdough basics', 1)).toBe(
      `${FORK_TITLE_SIGIL}₁ Sourdough basics`
    );
    expect(forkTitle('Sourdough basics', 3)).toBe(
      `${FORK_TITLE_SIGIL}₃ Sourdough basics`
    );
  });

  it('re-marks the base title when forking a fork (no sigil stacking)', () => {
    const firstFork = forkTitle('Sourdough basics', 2);
    expect(forkTitle(firstFork, 1)).toBe(
      `${FORK_TITLE_SIGIL}₁ Sourdough basics`
    );
  });

  it('passes the placeholder through unmarked so auto-title still claims the fork', () => {
    expect(forkTitle(PLACEHOLDER_TITLE, 1)).toBe(PLACEHOLDER_TITLE);
  });

  it('stripForkTitlePrefix only strips a well-formed leading marker', () => {
    expect(stripForkTitlePrefix(`${FORK_TITLE_SIGIL}₁₀ T`)).toBe('T');
    expect(stripForkTitlePrefix('plain title')).toBe('plain title');
    // Sigil without a subscript is user content, not a marker.
    expect(stripForkTitlePrefix(`${FORK_TITLE_SIGIL} T`)).toBe(
      `${FORK_TITLE_SIGIL} T`
    );
  });
});

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
