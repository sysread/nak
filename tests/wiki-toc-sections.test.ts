/**
 * Unit coverage for the wiki article ToC section-link assembly. Pure -
 * the Wiki.svelte ToC nav wires the returned list into markup and the
 * section elements carry the matching anchor ids.
 */
import { describe, it, expect } from 'vitest';
import {
  buildSectionTocLinks,
  WIKI_SOURCES_ANCHOR,
  WIKI_SEE_ALSO_ANCHOR,
  WIKI_RECORDS_ANCHOR,
} from '../src/lib/ui/wiki-toc-sections';

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
