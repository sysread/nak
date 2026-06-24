/**
 * Unit coverage for the pure wiki-export Markdown/ZIP builders. The
 * download wrappers (DOM + object URLs) are browser-only and not tested
 * here; these cover the string/byte assembly the wrappers hand off.
 */
import { describe, it, expect } from 'vitest';
import { unzipSync, strFromU8 } from 'fflate';
import type { WikiArticle, WikiRecord } from '../src/lib/supabase';
import {
  buildRecordMarkdown,
  buildArticleMarkdown,
  buildArticleZip,
  articleSlug,
} from '../src/lib/wiki-export';

function makeRecord(over: Partial<WikiRecord> = {}): WikiRecord {
  return {
    id: 'rec-1234abcd-0000-0000-0000-000000000000',
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

function makeArticle(over: Partial<WikiArticle> = {}): WikiArticle {
  return {
    id: 'art-1',
    title: 'Sourdough project',
    content: 'A long-running bake log.',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-06-17T00:00:00Z',
    ...over,
  };
}

describe('buildRecordMarkdown', () => {
  it('prepends date + tags front matter', () => {
    const md = buildRecordMarkdown(makeRecord({ tags: ['bread', 'hydration'] }));
    expect(md).toContain('date: 2026-06-17');
    expect(md).toContain('tags: [bread, hydration]');
    expect(md).toContain('Baked a loaf');
  });
  it('omits the tags line when there are none', () => {
    expect(buildRecordMarkdown(makeRecord({ tags: [] }))).not.toContain('tags:');
  });
});

describe('buildArticleMarkdown', () => {
  it('prepends an H1 title when the body has none', () => {
    expect(buildArticleMarkdown(makeArticle())).toMatch(/^# Sourdough project/);
  });
  it('leaves an existing leading H1 alone', () => {
    const md = buildArticleMarkdown(makeArticle({ content: '# Custom\n\nbody' }));
    expect(md.startsWith('# Custom')).toBe(true);
  });
});

describe('articleSlug', () => {
  it('slugs the title', () => {
    expect(articleSlug(makeArticle({ title: 'Sourdough Project!' }))).toBe('sourdough-project');
  });
});

describe('buildArticleZip', () => {
  it('packs article.md plus one file per record under records/', () => {
    const zip = buildArticleZip(makeArticle(), [
      makeRecord({ id: 'a', date: '2026-06-17', content: 'First bake' }),
      makeRecord({ id: 'b', date: '2026-06-18', content: 'Second bake' }),
    ]);
    const entries = unzipSync(zip);
    const names = Object.keys(entries).sort();
    expect(names).toContain('article.md');
    expect(names.filter((n) => n.startsWith('records/')).length).toBe(2);
    expect(strFromU8(entries['article.md'])).toContain('Sourdough project');
  });
  it('disambiguates colliding record filenames so none are dropped', () => {
    // Same date + identical-slugging content would collide on one name.
    const zip = buildArticleZip(makeArticle(), [
      makeRecord({ id: 'a', date: '2026-06-17', content: 'Bake' }),
      makeRecord({ id: 'b', date: '2026-06-17', content: 'Bake' }),
    ]);
    const recordFiles = Object.keys(unzipSync(zip)).filter((n) => n.startsWith('records/'));
    expect(recordFiles.length).toBe(2);
    expect(new Set(recordFiles).size).toBe(2);
  });
});
