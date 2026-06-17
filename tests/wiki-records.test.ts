/**
 * Unit coverage for the wiki-records UI primitives. Pure functions - no
 * runes, no DOM - tested via plain vitest. The companion
 * `src/components/WikiRecords.svelte` wires these into Svelte
 * reactivity (the list rune, the onWikiRecordChange subscription, the
 * compose form, the markup).
 */
import { describe, it, expect } from 'vitest';
import type { WikiRecord } from '../src/lib/supabase';
import {
  formatRecordDate,
  contentPreview,
  parseTags,
  serializeTags,
  recordsHeadline,
  recordSlug,
  recordExportFilename,
  recordsEmptyMessage,
  collectTags,
  todayIso,
} from '../src/lib/ui/wiki-records';

function makeRecord(over: Partial<WikiRecord> = {}): WikiRecord {
  return {
    id: 'rec-0001-2222-3333-444455556666',
    article_id: 'art-1',
    date: '2026-06-17',
    content: 'Baked a loaf',
    tags: [],
    source_conversation_id: null,
    created_at: '2026-06-17T00:00:00Z',
    updated_at: '2026-06-17T00:00:00Z',
    ...over,
  };
}

describe('formatRecordDate', () => {
  it('renders an ISO date as "Mon D, YYYY"', () => {
    // Locale-dependent month name; assert the stable parts.
    const out = formatRecordDate('2026-06-17');
    expect(out).toContain('2026');
    expect(out).toContain('17');
  });
  it('returns the raw string when unparseable', () => {
    expect(formatRecordDate('not-a-date')).toBe('not-a-date');
  });
  it('does not roll to the prior day (parses as local, not UTC)', () => {
    // A bare YYYY-MM-DD parsed via new Date() is UTC midnight, which can
    // render the 16th in a negative-offset locale. The local-parse guard
    // keeps the day stable.
    expect(formatRecordDate('2026-06-17')).toContain('17');
  });
});

describe('contentPreview', () => {
  it('collapses whitespace and truncates with an ellipsis', () => {
    const out = contentPreview('a\n\n  b   c'.repeat(40), 10);
    expect(out.length).toBeLessThanOrEqual(11); // 10 + ellipsis
    expect(out.endsWith('…')).toBe(true);
    expect(out).not.toContain('\n');
  });
  it('returns short content unchanged', () => {
    expect(contentPreview('short', 100)).toBe('short');
  });
});

describe('parseTags / serializeTags', () => {
  it('splits, trims, dedupes (case-insensitive), and drops blanks', () => {
    expect(parseTags(' bread , Bread, , sourdough ')).toEqual(['bread', 'sourdough']);
  });
  it('round-trips through serializeTags', () => {
    expect(serializeTags(parseTags('a, b, c'))).toBe('a, b, c');
  });
  it('caps the tag count', () => {
    const many = Array.from({ length: 40 }, (_, i) => `t${i}`).join(',');
    expect(parseTags(many).length).toBeLessThanOrEqual(24);
  });
});

describe('recordsHeadline', () => {
  it('drops the count when empty', () => {
    expect(recordsHeadline(0)).toBe('Records');
  });
  it('shows the count otherwise', () => {
    expect(recordsHeadline(12)).toBe('Records (12)');
  });
});

describe('recordSlug / recordExportFilename', () => {
  it('slugs the content body', () => {
    expect(recordSlug(makeRecord({ content: 'Baked a Loaf!' }))).toBe('baked-a-loaf');
  });
  it('falls back to the id tail for empty/non-latin bodies', () => {
    expect(recordSlug(makeRecord({ content: '日本語', id: 'abcd1234-rest' }))).toBe('abcd1234');
  });
  it('builds a dated filename', () => {
    expect(recordExportFilename(makeRecord({ date: '2026-06-17', content: 'Loaf' }))).toBe(
      '2026-06-17-loaf.md',
    );
  });
});

describe('recordsEmptyMessage', () => {
  it('distinguishes search / filter / empty', () => {
    expect(recordsEmptyMessage({ filtered: false, searching: true })).toMatch(/search/i);
    expect(recordsEmptyMessage({ filtered: true, searching: false })).toMatch(/filter/i);
    expect(recordsEmptyMessage({ filtered: false, searching: false })).toMatch(/no records yet/i);
  });
});

describe('collectTags', () => {
  it('returns the sorted distinct tag set', () => {
    const recs = [
      makeRecord({ id: '1', tags: ['b', 'a'] }),
      makeRecord({ id: '2', tags: ['a', 'c'] }),
    ];
    expect(collectTags(recs)).toEqual(['a', 'b', 'c']);
  });
});

describe('todayIso', () => {
  it('returns a YYYY-MM-DD string', () => {
    expect(todayIso()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
