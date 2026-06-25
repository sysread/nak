/**
 * Unit coverage for the citation display primitives shared by the
 * web-search citation panel and the context-recall citation panel:
 * the two source-shape mappers, the internal-route href + nav-patch
 * round trip, and the sources-count label.
 */
import { describe, it, expect } from 'vitest';
import {
  parseRecallCitationNav,
  recallCitationHref,
  recallCitationToDisplay,
  recallKindLabel,
  sourcesLabel,
  webCitationToDisplay,
} from '../src/lib/ui/citations';

describe('webCitationToDisplay', () => {
  it('maps a web citation to an external display row', () => {
    const d = webCitationToDisplay({
      index: 1,
      title: 'Doc',
      url: 'https://x',
      content: 'snip',
      date: '2026',
    });
    expect(d).toEqual({
      index: 1,
      label: 'Doc',
      href: 'https://x',
      external: true,
      meta: '2026',
      snippet: 'snip',
    });
  });

  it('falls back to the url when title is missing', () => {
    expect(webCitationToDisplay({ index: 2, url: 'https://y' }).label).toBe(
      'https://y'
    );
  });
});

describe('recall citation mapping', () => {
  it('builds the in-app href per kind', () => {
    expect(recallCitationHref({ index: 1, kind: 'memory', id: 'm1', label: 'L' })).toBe('?memory=m1');
    expect(recallCitationHref({ index: 1, kind: 'conversation', id: 'c1', label: 'L' })).toBe('?cid=c1');
    expect(recallCitationHref({ index: 1, kind: 'wiki', id: 'w1', label: 'L' })).toBe('?wiki_article_id=w1');
  });

  it('encodes the id into the href', () => {
    expect(recallCitationHref({ index: 1, kind: 'memory', id: 'a b', label: 'L' })).toBe('?memory=a%20b');
  });

  it('maps to an internal display row carrying the kind as meta', () => {
    const d = recallCitationToDisplay({ index: 3, kind: 'wiki', id: 'w1', label: 'Tangzhong' });
    expect(d).toEqual({
      index: 3,
      label: 'Tangzhong',
      href: '?wiki_article_id=w1',
      external: false,
      meta: 'wiki article',
      snippet: null,
    });
  });

  it('falls back to the kind label when the citation label is empty', () => {
    expect(recallCitationToDisplay({ index: 1, kind: 'memory', id: 'm1', label: '' }).label).toBe('memory');
  });

  it('labels each kind distinctly', () => {
    const labels = new Set([
      recallKindLabel('memory'),
      recallKindLabel('conversation'),
      recallKindLabel('wiki'),
    ]);
    expect(labels.size).toBe(3);
  });
});

describe('parseRecallCitationNav', () => {
  it('maps each route key to a navigate patch that closes the modal', () => {
    expect(parseRecallCitationNav('?memory=m1')).toEqual({ drawer: 'memories', memory: 'm1', modal: null });
    expect(parseRecallCitationNav('?cid=c1')).toEqual({ cid: 'c1', drawer: null, modal: null });
    expect(parseRecallCitationNav('?wiki_article_id=w1')).toEqual({ drawer: 'wiki', wiki_article_id: 'w1', modal: null });
  });

  it('decodes the id (round-trips with recallCitationHref)', () => {
    const href = recallCitationHref({ index: 1, kind: 'memory', id: 'a b', label: 'L' });
    expect(parseRecallCitationNav(href)).toEqual({ drawer: 'memories', memory: 'a b', modal: null });
  });

  it('returns null for an unknown or non-citation href', () => {
    expect(parseRecallCitationNav('?drawer=memories')).toBeNull();
    expect(parseRecallCitationNav('https://x')).toBeNull();
    expect(parseRecallCitationNav('#cite-1')).toBeNull();
  });
});

describe('sourcesLabel', () => {
  it('pluralizes by count', () => {
    expect(sourcesLabel(0)).toBe('Sources');
    expect(sourcesLabel(1)).toBe('1 source');
    expect(sourcesLabel(3)).toBe('3 sources');
  });
});
