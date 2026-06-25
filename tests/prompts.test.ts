import { describe, it, expect } from 'vitest';
import {
  addPrompt,
  createPrompt,
  deletePrompt,
  promptsMatch,
  reorderPrompts,
  updatePrompt,
} from '../src/lib/ui/prompts';
import type { SystemPrompt } from '../src/lib/supabase';

function p(id: string, over: Partial<SystemPrompt> = {}): SystemPrompt {
  return { id, name: id, body: '', enabledByDefault: false, ...over };
}

describe('createPrompt', () => {
  it('mints a uuid-id empty prompt', () => {
    const fresh = createPrompt();
    expect(fresh.id).toMatch(/[0-9a-f-]{36}/);
    expect(fresh.body).toBe('');
    expect(fresh.enabledByDefault).toBe(false);
  });
});

describe('addPrompt', () => {
  it('appends without mutating the input', () => {
    const list = [p('a')];
    const next = addPrompt(list);
    expect(next).toHaveLength(2);
    expect(next[0]).toBe(list[0]);
    expect(list).toHaveLength(1);
  });
});

describe('updatePrompt', () => {
  it('patches only the matching id', () => {
    const list = [p('a'), p('b')];
    const next = updatePrompt(list, 'b', { name: 'renamed' });
    expect(next[0]).toBe(list[0]);
    expect(next[1].name).toBe('renamed');
    expect(next[1]).not.toBe(list[1]);
  });
  it('is a no-op for an unknown id', () => {
    const list = [p('a')];
    expect(updatePrompt(list, 'zzz', { name: 'x' })).toEqual(list);
  });
});

describe('deletePrompt', () => {
  it('removes by id', () => {
    expect(deletePrompt([p('a'), p('b')], 'a')).toEqual([p('b')]);
  });
});

describe('reorderPrompts', () => {
  const list = [p('a'), p('b'), p('c'), p('d')];
  it('moves an earlier item later', () => {
    expect(reorderPrompts(list, 0, 2).map((x) => x.id)).toEqual([
      'b',
      'c',
      'a',
      'd',
    ]);
  });
  it('moves a later item earlier', () => {
    expect(reorderPrompts(list, 3, 1).map((x) => x.id)).toEqual([
      'a',
      'd',
      'b',
      'c',
    ]);
  });
  it('returns an unchanged copy for a no-op or out-of-range move', () => {
    expect(reorderPrompts(list, 1, 1).map((x) => x.id)).toEqual([
      'a',
      'b',
      'c',
      'd',
    ]);
    expect(reorderPrompts(list, -1, 2)).toEqual(list);
    expect(reorderPrompts(list, 0, 9)).toEqual(list);
  });
});

describe('promptsMatch', () => {
  it('compares by value, not reference', () => {
    expect(promptsMatch([p('a')], [p('a')])).toBe(true);
  });
  it('detects a field difference', () => {
    expect(promptsMatch([p('a')], [p('a', { body: 'x' })])).toBe(false);
  });
  it('detects a length difference', () => {
    expect(promptsMatch([p('a')], [p('a'), p('b')])).toBe(false);
  });
});
