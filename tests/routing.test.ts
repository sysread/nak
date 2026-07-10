import { describe, it, expect, beforeEach } from 'vitest';
import { parseUrl, buildSearch, navigate, route, __test } from '../src/lib/routing.svelte';

describe('routing: parseUrl', () => {
  beforeEach(() => {
    __test.reset();
  });

  it('returns all-null for an empty search string', () => {
    expect(parseUrl('')).toEqual({
      cid: null,
      drawer: null,
      modal: null,
      recipe: null,
      doc: null,
      memory: null,
      wiki_article_id: null,
      document_id: null,
      samskara_id: null,
      digest: null,
    });
  });

  it('reads every routed key', () => {
    const r = parseUrl(
      '?cid=abc&drawer=recipes&modal=help&recipe=xyz&doc=user/foo.md&memory=mem1&wiki_article_id=art1&document_id=doc1&samskara_id=sam1&digest=1'
    );
    expect(r).toEqual({
      cid: 'abc',
      drawer: 'recipes',
      modal: 'help',
      recipe: 'xyz',
      doc: 'user/foo.md',
      memory: 'mem1',
      wiki_article_id: 'art1',
      document_id: 'doc1',
      samskara_id: 'sam1',
      digest: '1',
    });
  });

  it('rejects unknown enum values', () => {
    // Prevents a stale link like ?modal=bogus from flipping the modal
    // flag into an inconsistent state - unknown values fall through as
    // null rather than corrupt the route model.
    const r = parseUrl('?modal=bogus&drawer=invalid');
    expect(r.modal).toBeNull();
    expect(r.drawer).toBeNull();
  });

  it('accepts memories as a drawer tab, not a modal', () => {
    // Memories used to live behind ?modal=memories. It graduated to a
    // sibling drawer tab (chats / recipes / memories / wiki), so
    // the URL key flipped and any stale ?modal=memories link parses
    // back as null rather than re-opening the long-gone modal.
    const drawer = parseUrl('?drawer=memories');
    expect(drawer.drawer).toBe('memories');
    const stale = parseUrl('?modal=memories');
    expect(stale.modal).toBeNull();
  });

  it('ignores unknown keys (share=pending etc.)', () => {
    const r = parseUrl('?share=pending&cid=abc');
    expect(r.cid).toBe('abc');
    // Non-routed keys just don't appear in the parsed route; they ride
    // through via buildSearch below, not via parseUrl.
  });

  it('treats empty string values as null', () => {
    const r = parseUrl('?cid=&modal=');
    expect(r.cid).toBeNull();
    expect(r.modal).toBeNull();
  });
});

describe('routing: buildSearch', () => {
  beforeEach(() => {
    __test.reset();
  });

  it('returns an empty string for an all-null route', () => {
    // Guard against a stray "?" being written onto the URL when there's
    // nothing to serialize.
    expect(buildSearch(route, '')).toBe('');
  });

  it('emits only the keys that are set', () => {
    const out = buildSearch(
      { cid: 'abc', drawer: null, modal: 'settings', recipe: null, doc: null, memory: null, wiki_article_id: null, document_id: null, samskara_id: null, digest: null },
      '',
    );
    expect(out).toBe('?cid=abc&modal=settings');
  });

  it('preserves unknown keys on the current search (share=pending survives)', () => {
    // Critical for Web Share Target: the SW redirects incoming shares
    // to ?share=pending, and our routing pushes must not strip that
    // flag before Chat.svelte's share-drain has a chance to read it.
    const out = buildSearch(
      { cid: 'abc', drawer: null, modal: null, recipe: null, doc: null, memory: null, wiki_article_id: null, document_id: null, samskara_id: null, digest: null },
      '?share=pending&foo=bar',
    );
    expect(out).toContain('share=pending');
    expect(out).toContain('foo=bar');
    expect(out).toContain('cid=abc');
  });

  it('overwrites stale routed keys on the current search', () => {
    // Old value for a routed key must be replaced, not duplicated.
    const out = buildSearch(
      { cid: 'new', drawer: null, modal: null, recipe: null, doc: null, memory: null, wiki_article_id: null, document_id: null, samskara_id: null, digest: null },
      '?cid=old&share=pending',
    );
    // URLSearchParams.set overwrites, URLSearchParams.append would not.
    const params = new URLSearchParams(out.slice(1));
    expect(params.getAll('cid')).toEqual(['new']);
    expect(params.get('share')).toBe('pending');
  });

  it('clears routed keys when the field goes null', () => {
    const out = buildSearch(
      { cid: null, drawer: null, modal: null, recipe: null, doc: null, memory: null, wiki_article_id: null, document_id: null, samskara_id: null, digest: null },
      '?cid=was-here&share=pending',
    );
    expect(out).not.toContain('cid=');
    expect(out).toContain('share=pending');
  });
});

describe('routing: navigate', () => {
  beforeEach(() => {
    __test.reset();
    // jsdom starts at about:blank - give us a stable starting URL so
    // pushState has somewhere to serialize against.
    history.replaceState(null, '', '/');
  });

  it('mutates `route` and pushes a new history entry', () => {
    const before = history.length;
    navigate({ modal: 'settings' });
    expect(route.modal).toBe('settings');
    expect(history.length).toBe(before + 1);
    expect(location.search).toBe('?modal=settings');
  });

  it('skips the push when nothing changed', () => {
    navigate({ modal: 'settings' });
    const after = history.length;
    // Second call with the same value should be a no-op on history.
    navigate({ modal: 'settings' });
    expect(history.length).toBe(after);
  });

  it('uses replaceState when opts.replace is true', () => {
    navigate({ modal: 'settings' });
    const before = history.length;
    navigate({ drawer: 'recipes' }, { replace: true });
    expect(history.length).toBe(before);
    expect(route.drawer).toBe('recipes');
    // Key order in the output is buildSearch's insertion order (cid,
    // drawer, modal, recipe, doc), not the order callers set them in.
    const params = new URLSearchParams(location.search);
    expect(params.get('modal')).toBe('settings');
    expect(params.get('drawer')).toBe('recipes');
  });

  it('round-trips through parseUrl(location.search)', () => {
    navigate({ cid: 'abc', modal: 'help', doc: 'user/foo.md' });
    const parsed = parseUrl();
    expect(parsed).toMatchObject({
      cid: 'abc',
      modal: 'help',
      doc: 'user/foo.md',
    });
  });

  it('clears a key when passed null, leaves others alone', () => {
    navigate({ cid: 'abc', modal: 'settings' });
    navigate({ modal: null });
    expect(route.modal).toBeNull();
    expect(route.cid).toBe('abc');
    expect(location.search).toBe('?cid=abc');
  });
});
