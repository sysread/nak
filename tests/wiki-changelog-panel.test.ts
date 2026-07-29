/**
 * Unit coverage for the wiki-changelog-panel UI primitives.
 * Pure functions - no runes, no DOM, no reactive state - tested
 * via plain vitest. The companion
 * `src/components/WikiChangelogPanel.svelte` is the only caller
 * that wires these into Svelte reactivity (the page-list rune,
 * the `onWikiChange` subscription, the async fetch
 * orchestration, the markup).
 */
import { describe, it, expect } from 'vitest';
import type { WikiChangelogEntry } from '../src/lib/supabase';
import {
  PAGE_SIZE,
  canOpenArticle,
  formatChangelogStamp,
  isExhausted,
  kindLabel,
  wikiSizeDelta,
} from '../src/lib/ui/wiki-changelog-panel';

function makeEntry(
  overrides: Partial<WikiChangelogEntry> = {}
): WikiChangelogEntry {
  return {
    id: 'e1',
    user_id: 'u1',
    article_id: 'a1',
    kind: 'create',
    title_at_change: 'Article title',
    message: 'created',
    created_at: '2026-05-19T12:00:00Z',
    ...overrides,
  } as WikiChangelogEntry;
}

describe('PAGE_SIZE', () => {
  it('is the documented 50-row screenful', () => {
    expect(PAGE_SIZE).toBe(50);
  });
});

describe('kindLabel', () => {
  it('maps each article kind to its past-tense chip label', () => {
    expect(kindLabel('create')).toBe('Added');
    expect(kindLabel('update')).toBe('Edited');
    expect(kindLabel('delete')).toBe('Deleted');
  });

  it('qualifies record kinds so they read apart from article kinds', () => {
    expect(kindLabel('record_create')).toBe('Added record');
    expect(kindLabel('record_update')).toBe('Edited record');
    expect(kindLabel('record_delete')).toBe('Removed record');
  });
});

describe('formatChangelogStamp', () => {
  it('renders a locale-aware compact stamp', () => {
    const out = formatChangelogStamp('2026-05-19T15:42:00Z');
    expect(out).toBeTruthy();
    expect(out).toMatch(/2026/);
    expect(out).toMatch(/May/);
  });

  it('falls back to the raw ISO on parse failure rather than "Invalid Date"', () => {
    // A bad ISO string should not produce a useless rendering -
    // the raw input is at least sortable.
    expect(formatChangelogStamp('not-an-iso')).toBe('not-an-iso');
  });
});

describe('canOpenArticle', () => {
  it('is true when the article still exists and the kind is not delete', () => {
    expect(canOpenArticle(makeEntry({ kind: 'create' }))).toBe(true);
    expect(canOpenArticle(makeEntry({ kind: 'update' }))).toBe(true);
  });

  it('is false on a delete-kind entry even when article_id is still set', () => {
    // Belt-and-braces: the FK set-null fires on delete so this
    // case should be unreachable, but the rule "don't link a
    // delete row" is enforced explicitly so a race or future
    // schema change can't sneak a link through.
    expect(canOpenArticle(makeEntry({ kind: 'delete' }))).toBe(false);
  });

  it('is false when article_id has been cleared', () => {
    expect(canOpenArticle(makeEntry({ article_id: null }))).toBe(false);
  });

  it('opens for record kinds - the parent article survives a record write', () => {
    // record_delete removes a record, not the article, so the row still
    // links through to the (surviving) parent.
    expect(canOpenArticle(makeEntry({ kind: 'record_create' }))).toBe(true);
    expect(canOpenArticle(makeEntry({ kind: 'record_update' }))).toBe(true);
    expect(canOpenArticle(makeEntry({ kind: 'record_delete' }))).toBe(true);
  });
});

describe('isExhausted', () => {
  it('is true when the page came back smaller than the page size', () => {
    expect(isExhausted(10, 50)).toBe(true);
  });

  it('is false when the page came back full', () => {
    expect(isExhausted(50, 50)).toBe(false);
  });

  it('defaults to comparing against PAGE_SIZE', () => {
    expect(isExhausted(49)).toBe(true);
    expect(isExhausted(50)).toBe(false);
  });

  it('treats a zero-row page as exhausted', () => {
    expect(isExhausted(0, 50)).toBe(true);
  });
});

describe('wikiSizeDelta', () => {
  function entry(before: number | null, after: number | null) {
    return { chars_before: before, chars_after: after };
  }

  it('renders a signed, thousands-separated label', () => {
    expect(wikiSizeDelta(entry(1000, 2400))?.label).toBe('+1,400');
    expect(wikiSizeDelta(entry(4000, 1500))?.label).toBe('-2,500');
  });

  it('carries the signed magnitude for the caller to style direction', () => {
    expect(wikiSizeDelta(entry(1000, 2400))?.chars).toBe(1400);
    expect(wikiSizeDelta(entry(4000, 1500))?.chars).toBe(-2500);
  });

  // A pre-columns row has unrecoverable historical sizes. Rendering
  // anything here would imply a zero-length body that never existed.
  // Also covers file/link record writes that pass null for both.
  it('shows nothing when either size is unknown', () => {
    expect(wikiSizeDelta(entry(null, 2400))).toBeNull();
    expect(wikiSizeDelta(entry(1000, null))).toBeNull();
    expect(wikiSizeDelta(entry(null, null))).toBeNull();
  });

  // 0 is a real recorded value, unlike null: a create has nothing before
  // it and a delete nothing after, and both are worth showing.
  it('treats a recorded zero as a real size, not a missing one', () => {
    expect(wikiSizeDelta(entry(0, 1800))?.label).toBe('+1,800');
    expect(wikiSizeDelta(entry(1800, 0))?.label).toBe('-1,800');
  });

  it('stays quiet on a label-only edit and on sub-noise churn', () => {
    expect(wikiSizeDelta(entry(2000, 2000))).toBeNull();
    expect(wikiSizeDelta(entry(2000, 2050))).toBeNull();
    expect(wikiSizeDelta(entry(2000, 1950))).toBeNull();
  });

  it('emphasizes only the large moves', () => {
    expect(wikiSizeDelta(entry(2000, 2200))?.significant).toBe(false);
    expect(wikiSizeDelta(entry(2000, 4000))?.significant).toBe(true);
    expect(wikiSizeDelta(entry(6000, 2000))?.significant).toBe(true);
  });
});
