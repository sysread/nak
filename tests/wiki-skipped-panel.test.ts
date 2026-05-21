/**
 * Unit coverage for the wiki-skipped-panel UI primitives. Pure
 * functions - no runes, no DOM - tested via plain vitest. The
 * companion `src/components/WikiSkippedPanel.svelte` composes
 * these with the async load orchestration, the `onWikiChange`
 * subscription, and the markup.
 */
import { describe, it, expect } from 'vitest';
import {
  displayTitle,
  formatSkipTimestamp,
  retryResultHeadline,
} from '../src/lib/ui/wiki-skipped-panel';

describe('formatSkipTimestamp', () => {
  it('renders a locale-aware compact stamp', () => {
    const out = formatSkipTimestamp('2026-05-19T15:42:00Z');
    expect(out).toBeTruthy();
    expect(out).toMatch(/2026/);
    expect(out).toMatch(/May/);
  });

  it('falls back to the raw ISO on parse failure', () => {
    // Same defensive shape as formatChangelogStamp - keep the
    // raw string visible so a downstream sorter still has
    // something to grip onto, rather than rendering the
    // useless "Invalid Date".
    expect(formatSkipTimestamp('not-an-iso')).toBe('not-an-iso');
  });
});

describe('displayTitle', () => {
  it('returns the title verbatim when present', () => {
    expect(displayTitle('Dishwasher repair')).toBe('Dishwasher repair');
  });

  it('renders the bracketed sentinel for null titles', () => {
    expect(displayTitle(null)).toBe('[untitled conversation]');
  });

  it('keeps an empty-string title (auto-title can briefly land "")', () => {
    // Treat empty distinctly from null - if the auto-title
    // worker has produced an empty string (vs "still pending"
    // null), the user sees the empty button rather than the
    // sentinel.
    expect(displayTitle('')).toBe('');
  });
});

describe('retryResultHeadline', () => {
  it('calls out a zero-edit run distinctly so users know nothing landed', () => {
    // The motivating fix: silently dropping the row when
    // toolCalls === 0 left users wondering why Retry appeared
    // to do nothing. The headline has to say "no edits" out
    // loud, not just imply it by absence.
    expect(retryResultHeadline(0)).toBe(
      'Retry done. The agent decided no edits were warranted.',
    );
  });

  it('uses the singular noun phrase for exactly one edit', () => {
    expect(retryResultHeadline(1)).toBe('Retry done. 1 wiki edit landed.');
  });

  it('uses the plural noun phrase with the count for two or more', () => {
    expect(retryResultHeadline(2)).toBe('Retry done. 2 wiki edits landed.');
    expect(retryResultHeadline(7)).toBe('Retry done. 7 wiki edits landed.');
  });

  it('treats negative counts as the zero-edit case', () => {
    // The agent path never returns a negative count, but
    // rendering "Retry done. -1 wiki edits landed." would be
    // the most embarrassing shape if the upstream contract ever
    // shifts.
    expect(retryResultHeadline(-1)).toBe(
      'Retry done. The agent decided no edits were warranted.',
    );
  });
});
