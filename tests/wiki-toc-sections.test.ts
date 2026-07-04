/**
 * Unit coverage for the wiki article ToC primitives: the heading
 * outline (nesting + visibility gates + slug-text cleaning) and the
 * section-link assembly. Pure - the Wiki.svelte ToC nav wires the
 * returned values into markup and the section elements carry the
 * matching anchor ids.
 */
import { describe, it, expect } from 'vitest';
import type { HeadingEntry } from '../src/lib/markdown';
import {
  buildSectionTocLinks,
  nestHeadings,
  headingOutlineVisible,
  tocVisible,
  cleanHeadingText,
  WIKI_SOURCES_ANCHOR,
  WIKI_SEE_ALSO_ANCHOR,
  WIKI_RECORDS_ANCHOR,
} from '../src/lib/ui/wiki-toc-sections';

function h(level: number, text: string): HeadingEntry {
  return { level, text, slug: text.toLowerCase().replace(/\s+/g, '-') };
}

describe('nestHeadings', () => {
  it('nests each heading under the nearest preceding lower level', () => {
    const tree = nestHeadings([h(1, 'A'), h(2, 'B'), h(3, 'C'), h(2, 'D')]);
    expect(tree).toHaveLength(1);
    expect(tree[0].text).toBe('A');
    expect(tree[0].children.map((n) => n.text)).toEqual(['B', 'D']);
    expect(tree[0].children[0].children.map((n) => n.text)).toEqual(['C']);
  });

  it('keeps siblings flat at the same level', () => {
    const tree = nestHeadings([h(2, 'A'), h(2, 'B'), h(2, 'C')]);
    expect(tree.map((n) => n.text)).toEqual(['A', 'B', 'C']);
    expect(tree.every((n) => n.children.length === 0)).toBe(true);
  });

  it('attaches an outline jump (H1 -> H3) to the closest ancestor without a placeholder', () => {
    const tree = nestHeadings([h(1, 'A'), h(3, 'C')]);
    expect(tree).toHaveLength(1);
    expect(tree[0].children.map((n) => n.text)).toEqual(['C']);
  });

  it('promotes a heading shallower than everything before it to the top level', () => {
    const tree = nestHeadings([h(2, 'Deep'), h(1, 'Top')]);
    expect(tree.map((n) => n.text)).toEqual(['Deep', 'Top']);
  });

  it('returns an empty tree for no headings', () => {
    expect(nestHeadings([])).toEqual([]);
  });
});

describe('ToC visibility gates', () => {
  it('hides the heading outline below two headings - a one-item outline is noise', () => {
    expect(headingOutlineVisible(0)).toBe(false);
    expect(headingOutlineVisible(1)).toBe(false);
    expect(headingOutlineVisible(2)).toBe(true);
  });

  it('lets section links relax the outline gate for the whole panel', () => {
    expect(tocVisible(0, 0)).toBe(false);
    expect(tocVisible(1, 0)).toBe(false);
    // A short article with records still gets navigation.
    expect(tocVisible(0, 1)).toBe(true);
    expect(tocVisible(2, 0)).toBe(true);
  });
});

describe('cleanHeadingText', () => {
  it('strips the inline formatting chars extractHeadings strips', () => {
    expect(cleanHeadingText('**Bold** and `code`')).toBe('Bold and code');
    expect(cleanHeadingText('_em_ ~strike~')).toBe('em strike');
  });

  it('trims surrounding whitespace', () => {
    expect(cleanHeadingText('  Plain  ')).toBe('Plain');
  });
});

describe('buildSectionTocLinks', () => {
  it('emits a link only for each present section, in document order', () => {
    const links = buildSectionTocLinks({
      hasSources: true,
      hasSeeAlso: true,
      recordCount: 3,
    });
    expect(links.map((l) => l.label)).toEqual(['Sources', 'See also', 'Records']);
    expect(links.map((l) => l.id)).toEqual([
      WIKI_SOURCES_ANCHOR,
      WIKI_SEE_ALSO_ANCHOR,
      WIKI_RECORDS_ANCHOR,
    ]);
  });

  it('omits absent sections', () => {
    expect(
      buildSectionTocLinks({ hasSources: false, hasSeeAlso: true, recordCount: 0 }).map(
        (l) => l.label,
      ),
    ).toEqual(['See also']);
  });

  it('suppresses the Records link when the article has no records', () => {
    expect(
      buildSectionTocLinks({ hasSources: false, hasSeeAlso: false, recordCount: 0 }),
    ).toEqual([]);
    expect(
      buildSectionTocLinks({ hasSources: false, hasSeeAlso: false, recordCount: 1 }).map(
        (l) => l.label,
      ),
    ).toEqual(['Records']);
  });

  it('uses prefixed anchor ids that cannot collide with bare heading slugs', () => {
    // A content heading literally titled "Sources" slugs to "sources";
    // the section anchor is "wiki-sources" so the two never clash.
    expect(WIKI_SOURCES_ANCHOR).toBe('wiki-sources');
    expect(WIKI_SEE_ALSO_ANCHOR).toBe('wiki-see-also');
    expect(WIKI_RECORDS_ANCHOR).toBe('wiki-records');
  });
});
