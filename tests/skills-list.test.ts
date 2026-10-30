/**
 * Unit coverage for the skills sidebar listing's UI primitives.
 * Pure functions - no runes, no DOM - tested via plain vitest.
 *
 * The companion `src/components/SkillList.svelte` is the only caller
 * that wires these into Svelte reactivity (the debounced `$effect`
 * that re-runs `runSkillsSearch`, the infinite-scroll sentinel, the
 * markup). The panel's browse list reuses `rowSnippet` for its rows.
 */
import { describe, it, expect } from 'vitest';
import {
  ROW_SNIPPET_CHARS,
  SEARCH_DEBOUNCE_MS,
  emptyMessage,
  rowSnippet,
} from '../src/lib/ui/skills-list';

describe('SEARCH_DEBOUNCE_MS', () => {
  it('matches the cross-drawer 200ms convention', () => {
    // Pinned so a fork that changes one of the drawer-tab debounces
    // surfaces here - we want typing-burst latency to read uniformly
    // across the chats / memories / recipes / wiki / skills tabs.
    // Each module declaring its own copy is the convention, not an
    // accident to deduplicate.
    expect(SEARCH_DEBOUNCE_MS).toBe(200);
  });
});

describe('emptyMessage', () => {
  it('says "no matches" when a search returned nothing', () => {
    expect(emptyMessage('release')).toBe('No matches.');
  });

  it('points at the create affordance when the store is empty', () => {
    expect(emptyMessage('')).toBe(
      'No skills yet. Create one with the New skill button.',
    );
  });

  it('treats whitespace-only queries as the empty case', () => {
    // A stray space from a previous search should not flip the
    // empty-state to "No matches." - the search predicate's trim
    // means there's no actual filter active.
    expect(emptyMessage('   ')).toBe(
      'No skills yet. Create one with the New skill button.',
    );
  });
});

describe('rowSnippet', () => {
  it('passes a short description through untouched', () => {
    expect(rowSnippet('Use when drafting release notes.')).toBe(
      'Use when drafting release notes.',
    );
  });

  it('trims and collapses whitespace to a single line', () => {
    // Descriptions are model-authored and may contain newlines; the
    // sidebar row is single-line, so a newline run must not render
    // as a stacked row.
    expect(rowSnippet('  Use   when drafting\n\n  release notes.  ')).toBe(
      'Use when drafting release notes.',
    );
  });

  it('truncates at the snippet ceiling with a plain-dots suffix', () => {
    const long = 'x'.repeat(ROW_SNIPPET_CHARS + 10);
    const out = rowSnippet(long);
    expect(out.length).toBe(ROW_SNIPPET_CHARS);
    expect(out.endsWith('...')).toBe(true);
    // Everything before the suffix is description text, not padding.
    expect(out.slice(0, -3)).toBe('x'.repeat(ROW_SNIPPET_CHARS - 3));
  });

  it('keeps a description exactly at the ceiling whole', () => {
    const exact = 'y'.repeat(ROW_SNIPPET_CHARS);
    expect(rowSnippet(exact)).toBe(exact);
  });

  it('returns empty for an all-whitespace description', () => {
    // The caller hides the snippet span entirely on an empty result,
    // so the row does not render a dangling ellipsis.
    expect(rowSnippet('   ')).toBe('');
  });
});
