/**
 * Unit coverage for the digest-panel UI primitives and the
 * conversation-digest row coercer. Pure functions - no runes, no
 * DOM - tested via plain vitest. The companion
 * `src/components/DigestPanel.svelte` is the only caller that wires
 * the primitives into Svelte reactivity.
 */
import { describe, it, expect } from 'vitest';
import {
  PAGE_SIZE,
  conversationCountLabel,
  formatDigestDate,
  isExhausted,
} from '../src/lib/ui/digest-panel';
import { coerceConversationDigest } from '../src/lib/supabase/types/digests';

describe('formatDigestDate', () => {
  it('renders a YYYY-MM-DD as a long local date, not a UTC-shifted one', () => {
    // Field-by-field parse means the label always carries the literal
    // calendar day, regardless of the host timezone (new Date('...')
    // string parsing would bucket to UTC midnight and shift a day for
    // hosts west of Greenwich).
    const label = formatDigestDate('2026-07-09');
    expect(label).toContain('2026');
    expect(label).toContain('9');
    expect(label).toMatch(/July/);
  });

  it('falls back to the raw string on a malformed date', () => {
    expect(formatDigestDate('not-a-date')).toBe('not-a-date');
    expect(formatDigestDate('2026-7-9')).toBe('2026-7-9');
  });
});

describe('conversationCountLabel', () => {
  it('pluralizes and names the empty placeholder case', () => {
    expect(conversationCountLabel(0)).toBe('No conversations');
    expect(conversationCountLabel(1)).toBe('1 conversation');
    expect(conversationCountLabel(3)).toBe('3 conversations');
  });
});

describe('isExhausted', () => {
  it('is true only when the page came back short', () => {
    expect(isExhausted(PAGE_SIZE)).toBe(false);
    expect(isExhausted(PAGE_SIZE - 1)).toBe(true);
    expect(isExhausted(0)).toBe(true);
    expect(isExhausted(2, 2)).toBe(false);
  });
});

describe('coerceConversationDigest', () => {
  it('coerces a well-formed row', () => {
    const digest = coerceConversationDigest({
      id: 'd1',
      digest_date: '2026-07-09',
      summary: 'A day of work.',
      threads: [
        { thread_id: 't1', title: 'Build the digest', summary: 'Built it.' },
      ],
      created_at: '2026-07-10T05:53:00Z',
    });
    expect(digest).not.toBeNull();
    expect(digest!.threads).toHaveLength(1);
    expect(digest!.threads[0].title).toBe('Build the digest');
  });

  it('drops malformed thread entries instead of failing the row', () => {
    const digest = coerceConversationDigest({
      id: 'd1',
      digest_date: '2026-07-09',
      summary: 's',
      threads: [
        null,
        42,
        { title: 'missing id', summary: 'x' },
        { thread_id: 't2', summary: 'kept with fallback title' },
      ],
      created_at: '2026-07-10T05:53:00Z',
    });
    expect(digest!.threads).toHaveLength(1);
    expect(digest!.threads[0]).toEqual({
      thread_id: 't2',
      title: 'Untitled',
      summary: 'kept with fallback title',
    });
  });

  it('returns null when id or digest_date is missing', () => {
    expect(coerceConversationDigest({ digest_date: '2026-07-09' })).toBeNull();
    expect(coerceConversationDigest({ id: 'd1' })).toBeNull();
  });

  it('tolerates a non-array threads column', () => {
    const digest = coerceConversationDigest({
      id: 'd1',
      digest_date: '2026-07-09',
      summary: 's',
      threads: 'oops',
      created_at: '2026-07-10T05:53:00Z',
    });
    expect(digest!.threads).toEqual([]);
  });
});
