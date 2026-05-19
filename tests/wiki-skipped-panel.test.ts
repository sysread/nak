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
