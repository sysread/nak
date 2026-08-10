import { describe, it, expect } from 'vitest';
import {
  HISTORY_PREVIEW,
  visibleHistory,
  disclosureLabel,
} from '../src/lib/ui/history-disclosure';

const rows = (n: number) => Array.from({ length: n }, (_, i) => `row-${i}`);

describe('visibleHistory', () => {
  it('shows everything and hides nothing below the preview size', () => {
    const view = visibleHistory(rows(3), false);
    expect(view.shown).toHaveLength(3);
    expect(view.hidden).toBe(0);
  });

  it('shows everything at exactly the preview size', () => {
    const view = visibleHistory(rows(HISTORY_PREVIEW), false);
    expect(view.shown).toHaveLength(HISTORY_PREVIEW);
    expect(view.hidden).toBe(0);
  });

  it('truncates to the preview and reports the remainder', () => {
    const view = visibleHistory(rows(12), false);
    expect(view.shown).toHaveLength(HISTORY_PREVIEW);
    expect(view.hidden).toBe(12 - HISTORY_PREVIEW);
  });

  // The preview must be the head of the list: callers hand in a group
  // already sorted newest-first, so truncating from the tail is what
  // makes the collapsed view show the most recent history.
  it('previews the head of the list', () => {
    const view = visibleHistory(rows(12), false);
    expect(view.shown).toEqual(['row-0', 'row-1', 'row-2', 'row-3', 'row-4']);
  });

  it('shows the whole list when expanded', () => {
    const view = visibleHistory(rows(12), true);
    expect(view.shown).toHaveLength(12);
    expect(view.hidden).toBe(0);
  });

  it('handles an empty group', () => {
    expect(visibleHistory([], false)).toEqual({ shown: [], hidden: 0 });
  });
});

describe('disclosureLabel', () => {
  it('names the hidden count so the tail is visible before expanding', () => {
    expect(disclosureLabel(7)).toBe('Show 7 more');
  });

  it('singularizes one hidden row', () => {
    expect(disclosureLabel(1)).toBe('Show 1 more');
  });

  it('offers to re-collapse when nothing is hidden', () => {
    expect(disclosureLabel(0)).toBe('Show fewer');
  });
});
