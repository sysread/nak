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
  recordFileBadgeLabel,
  recordSlug,
  recordExportFilename,
  recordsEmptyMessage,
  collectTags,
  todayIso,
  recordFileIsImage,
  formatRecordFileMeta,
  partitionRecordFiles,
  describeLink,
  linkCandidates,
  validateLinkLabel,
  validateRecordForm,
} from '../src/lib/ui/wiki-records';
import {
  buildRecordChangelogMessage,
  buildRecordFileChangelogMessage,
  buildRecordLinkChangelogMessage,
  MAX_RECORD_LINK_LABEL_CHARS,
  MAX_WIKI_RECORD_CONTENT_CHARS,
} from '../src/lib/wiki';
import type { WikiRecordFile, WikiRecordLinkView } from '../src/lib/supabase';

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
    fileCount: 0,
    ...over,
  };
}

function makeFile(over: Partial<WikiRecordFile> = {}): WikiRecordFile {
  return {
    id: 'file-1',
    record_id: 'rec-1',
    position: 0,
    filename: 'crumb.jpg',
    mime_type: 'image/jpeg',
    size_bytes: 1024,
    storage_path: 'u/file-1/crumb.jpg',
    extracted_text: null,
    created_at: '2026-06-17T00:00:00Z',
    ...over,
  };
}

function makeLinkView(over: Partial<WikiRecordLinkView> = {}): WikiRecordLinkView {
  return {
    id: 'link-1',
    direction: 'outgoing',
    label: 'based on',
    record: { id: 'rec-2', article_id: 'art-1', date: '2026-06-10', content: 'Attempt 2' },
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
  it('strips Markdown syntax so the collapsed row reads as plain text', () => {
    // The reported bug: a record opening with **bold** showed the literal
    // asterisks in the single-line preview.
    expect(contentPreview('**Second cake-crumb revision of Fermented Bread Loaf.** After', 100)).toBe(
      'Second cake-crumb revision of Fermented Bread Loaf. After',
    );
  });
  it('strips headings, bullets, code, and links but keeps their text', () => {
    expect(contentPreview('# Title\n- first point\n`code` and [a link](http://x)', 200)).toBe(
      'Title first point code and a link',
    );
  });
  it('leaves snake_case identifiers intact', () => {
    expect(contentPreview('use record_file_attach here', 100)).toBe('use record_file_attach here');
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

describe('recordFileBadgeLabel', () => {
  it('returns null when the record has no files (no "0 files" badge)', () => {
    expect(recordFileBadgeLabel(0)).toBeNull();
    expect(recordFileBadgeLabel(-1)).toBeNull();
  });
  it('singularizes one file', () => {
    expect(recordFileBadgeLabel(1)).toBe('1 attached file');
  });
  it('pluralizes more than one', () => {
    expect(recordFileBadgeLabel(3)).toBe('3 attached files');
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

describe('buildRecordChangelogMessage', () => {
  it('leads with a verb + date and appends a content preview', () => {
    expect(buildRecordChangelogMessage('record_create', '2026-06-17', 'Baked a loaf')).toBe(
      'Added record (2026-06-17): Baked a loaf',
    );
    expect(buildRecordChangelogMessage('record_update', '2026-06-17', 'x')).toMatch(/^Edited record/);
    expect(buildRecordChangelogMessage('record_delete', '2026-06-17', 'x')).toMatch(/^Removed record/);
  });
  it('omits the preview when no content is given', () => {
    expect(buildRecordChangelogMessage('record_update', '2026-06-17')).toBe('Edited record (2026-06-17)');
  });
  it('collapses whitespace and stays within the 200-char column cap', () => {
    const msg = buildRecordChangelogMessage('record_create', '2026-06-17', 'a\n\n  b'.repeat(200));
    expect(msg.length).toBeLessThanOrEqual(200);
    expect(msg).not.toContain('\n');
  });
});

describe('recordFileIsImage', () => {
  it('detects images by mime prefix', () => {
    expect(recordFileIsImage({ mime_type: 'image/png' })).toBe(true);
    expect(recordFileIsImage({ mime_type: 'application/pdf' })).toBe(false);
    expect(recordFileIsImage({ mime_type: null })).toBe(false);
  });
});

describe('formatRecordFileMeta', () => {
  it('appends a humanized size when known', () => {
    expect(formatRecordFileMeta({ filename: 'a.pdf', size_bytes: 2048 })).toMatch(/^a\.pdf - /);
  });
  it('drops the separator when size is unknown', () => {
    expect(formatRecordFileMeta({ filename: 'a.pdf', size_bytes: null })).toBe('a.pdf');
  });
});

describe('partitionRecordFiles', () => {
  it('splits images from docs and pairs each with its resolved url', () => {
    const img = makeFile({ id: 'i', mime_type: 'image/jpeg' });
    const doc = makeFile({ id: 'd', filename: 'r.pdf', mime_type: 'application/pdf' });
    const urls = new Map([['i', 'https://signed/i']]);
    const { images, docs } = partitionRecordFiles([img, doc], urls);
    expect(images.map((v) => v.file.id)).toEqual(['i']);
    expect(images[0].url).toBe('https://signed/i');
    expect(docs.map((v) => v.file.id)).toEqual(['d']);
    // No URL resolved yet -> null, not dropped.
    expect(docs[0].url).toBeNull();
  });
});

describe('describeLink', () => {
  it('renders an outgoing edge with a forward arrow and the label', () => {
    const d = describeLink(makeLinkView({ direction: 'outgoing', label: 'based on' }));
    expect(d.arrow).toBe('->');
    expect(d.label).toBe('based on');
    expect(d.preview).toContain('Attempt 2');
  });
  it('renders an incoming edge with a back arrow', () => {
    expect(describeLink(makeLinkView({ direction: 'incoming' })).arrow).toBe('<-');
  });
  it('falls back to "linked" when the label is blank', () => {
    expect(describeLink(makeLinkView({ label: null })).label).toBe('linked');
    expect(describeLink(makeLinkView({ label: '   ' })).label).toBe('linked');
  });
});

describe('linkCandidates', () => {
  it('excludes the current record and already-linked records', () => {
    const a = makeRecord({ id: 'a' });
    const b = makeRecord({ id: 'b' });
    const c = makeRecord({ id: 'c' });
    const existing = [makeLinkView({ id: 'l', record: { ...makeLinkView().record, id: 'b' } })];
    const out = linkCandidates([a, b, c], 'a', existing);
    expect(out.map((r) => r.id)).toEqual(['c']);
  });
});

describe('validateRecordForm', () => {
  it('accepts trimmed content with a date-input-shaped date', () => {
    expect(validateRecordForm('Fed the starter.', '2026-06-17')).toBeNull();
  });

  it('rejects empty content (the caller passes content already trimmed)', () => {
    expect(validateRecordForm('', '2026-06-17')).toBe('Content is required.');
  });

  it('rejects over-length content with the cap in the message', () => {
    const long = 'x'.repeat(MAX_WIKI_RECORD_CONTENT_CHARS + 1);
    expect(validateRecordForm(long, '2026-06-17')).toBe(
      `Content must be ${MAX_WIKI_RECORD_CONTENT_CHARS} chars or fewer.`,
    );
    expect(
      validateRecordForm('x'.repeat(MAX_WIKI_RECORD_CONTENT_CHARS), '2026-06-17'),
    ).toBeNull();
  });

  it('rejects a date that is not YYYY-MM-DD shaped', () => {
    // A native date input yields either that shape or an empty
    // string; the empty string is the "no date picked" case.
    expect(validateRecordForm('ok', '')).toBe('Pick a valid date.');
    expect(validateRecordForm('ok', '06/17/2026')).toBe('Pick a valid date.');
  });

  it('checks content before date so the first missing field is reported', () => {
    expect(validateRecordForm('', '')).toBe('Content is required.');
  });
});

describe('validateLinkLabel', () => {
  it('accepts empty and short labels', () => {
    expect(validateLinkLabel('')).toBeNull();
    expect(validateLinkLabel('based on')).toBeNull();
  });
  it('rejects an over-length label', () => {
    expect(validateLinkLabel('x'.repeat(MAX_RECORD_LINK_LABEL_CHARS + 1))).toMatch(/or fewer/);
  });
});

describe('buildRecordFileChangelogMessage', () => {
  it('names the attach with the noun and filename', () => {
    expect(buildRecordFileChangelogMessage('attach', '2026-06-17', 'crumb.jpg', true)).toBe(
      'Attached image (2026-06-17): crumb.jpg',
    );
    expect(buildRecordFileChangelogMessage('remove', '2026-06-17', 'r.pdf', false)).toBe(
      'Removed file (2026-06-17): r.pdf',
    );
  });
});

describe('buildRecordLinkChangelogMessage', () => {
  it('includes the target snippet and the label on create', () => {
    expect(
      buildRecordLinkChangelogMessage('create', '2026-06-10', 'Attempt 2', 'based on'),
    ).toBe('Linked to (2026-06-10) Attempt 2 - based on');
  });
  it('omits the label on delete', () => {
    expect(buildRecordLinkChangelogMessage('delete', '2026-06-10', 'Attempt 2', 'based on')).toBe(
      'Removed link to (2026-06-10) Attempt 2',
    );
  });
});
