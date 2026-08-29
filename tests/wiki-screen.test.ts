/**
 * Unit coverage for the Wiki screen's UI primitives. Pure functions -
 * no runes, no DOM, no reactive state - tested via plain vitest.
 *
 * The companion `src/screens/Wiki.svelte` is the only caller that
 * wires these into Svelte reactivity; a port to another framework
 * would re-use this module untouched.
 */
import { describe, it, expect } from 'vitest';
import {
  MAX_WIKI_TITLE_CHARS,
  MAX_WIKI_CONTENT_CHARS,
  MAX_WIKI_CHANGELOG_MESSAGE_CHARS,
} from '../src/lib/wiki';
import type { WikiArticle } from '../src/lib/supabase';
import {
  resolveSelectedArticle,
  articleFormError,
  changelogMessageError,
  createArticleErrorMessage,
  editSaveNotice,
  favoriteButtonTitle,
  favoriteAriaLabel,
  offlineActionTitle,
  sourceThreadLabel,
  wikiHrefRoutePatch,
} from '../src/lib/ui/wiki-screen';

function makeArticle(over: Partial<WikiArticle> = {}): WikiArticle {
  return {
    id: 'a1',
    title: 'Maya',
    content: '# Maya\n\nThe user\'s sister.',
    favorite: false,
    created_at: '2026-06-01T00:00:00Z',
    updated_at: '2026-06-01T00:00:00Z',
    ...over,
  };
}

describe('resolveSelectedArticle', () => {
  const inResults = makeArticle({ id: 'r1' });
  const inFavorites = makeArticle({ id: 'f1' });
  const fetched = makeArticle({ id: 'x1' });

  it('returns null when nothing is routed', () => {
    expect(resolveSelectedArticle(null, [inResults], [inFavorites], fetched)).toBeNull();
  });

  it('prefers the loaded result list', () => {
    expect(resolveSelectedArticle('r1', [inResults], [inFavorites], fetched)).toBe(
      inResults,
    );
  });

  it('falls back to the Favorites bucket when the browse list misses', () => {
    expect(resolveSelectedArticle('f1', [inResults], [inFavorites], fetched)).toBe(
      inFavorites,
    );
  });

  it('falls back to the read-through row only when its id matches', () => {
    expect(resolveSelectedArticle('x1', [inResults], [inFavorites], fetched)).toBe(
      fetched,
    );
    // A stale fetch for a previously-routed article must not render
    // under the new route.
    expect(resolveSelectedArticle('y1', [inResults], [inFavorites], fetched)).toBeNull();
  });

  it('answers "already loaded" when called with fetched: null', () => {
    expect(resolveSelectedArticle('r1', [inResults], [], null)).toBe(inResults);
    expect(resolveSelectedArticle('x1', [inResults], [], null)).toBeNull();
  });
});

describe('changelogMessageError', () => {
  it('requires a message, naming the action in flight', () => {
    expect(changelogMessageError('', 'saving')).toBe(
      'Add a one-line change message before saving.',
    );
    expect(changelogMessageError('', 'deleting')).toBe(
      'Add a one-line change message before deleting.',
    );
  });

  it('rejects an overlong message with the cap in the copy', () => {
    const long = 'x'.repeat(MAX_WIKI_CHANGELOG_MESSAGE_CHARS + 1);
    expect(changelogMessageError(long, 'saving')).toBe(
      `Change message must be ${MAX_WIKI_CHANGELOG_MESSAGE_CHARS} chars or fewer.`,
    );
  });

  it('passes a message at exactly the cap', () => {
    expect(
      changelogMessageError('x'.repeat(MAX_WIKI_CHANGELOG_MESSAGE_CHARS), 'saving'),
    ).toBeNull();
  });
});

describe('articleFormError', () => {
  it('checks fields in the form\'s visual order', () => {
    expect(articleFormError('', '', '')).toBe('Title is required.');
    expect(articleFormError('T', '', '')).toBe('Content is required.');
    expect(articleFormError('T', 'C', '')).toBe(
      'Add a one-line change message before saving.',
    );
    expect(articleFormError('T', 'C', 'm')).toBeNull();
  });

  it('rejects overlong fields with the caps in the copy', () => {
    expect(articleFormError('x'.repeat(MAX_WIKI_TITLE_CHARS + 1), 'C', 'm')).toBe(
      `Title must be ${MAX_WIKI_TITLE_CHARS} chars or fewer.`,
    );
    expect(articleFormError('T', 'x'.repeat(MAX_WIKI_CONTENT_CHARS + 1), 'm')).toBe(
      `Content must be ${MAX_WIKI_CONTENT_CHARS} chars or fewer.`,
    );
  });

  it('takes content verbatim - whitespace-only content is content', () => {
    // The caller trims title and message but not content: trailing
    // whitespace in an article body is the user's call.
    expect(articleFormError('T', '  ', 'm')).toBeNull();
  });
});

describe('createArticleErrorMessage', () => {
  it('rephrases the unique(user_id, title) violation', () => {
    expect(
      createArticleErrorMessage(
        'duplicate key value violates unique constraint "wiki_articles_user_id_title_key"',
      ),
    ).toBe('An article with that title already exists.');
    expect(createArticleErrorMessage('violates unique constraint')).toBe(
      'An article with that title already exists.',
    );
  });

  it('passes other errors through verbatim', () => {
    expect(createArticleErrorMessage('network timeout')).toBe('network timeout');
  });
});

describe('editSaveNotice', () => {
  it('renders nothing while idle or saving', () => {
    // Saving renders nothing because the Save button's own
    // progressive caption covers the in-flight state.
    expect(editSaveNotice({ kind: 'idle' })).toBeNull();
    expect(editSaveNotice({ kind: 'saving' })).toBeNull();
  });

  it('shows the unsaved-changes hint on a dirty draft', () => {
    expect(editSaveNotice({ kind: 'dirty' })).toEqual({
      text: 'Unsaved changes.',
      className: 'subtle',
    });
  });

  it('surfaces errors verbatim with the error styling', () => {
    expect(editSaveNotice({ kind: 'error', message: 'boom' })).toEqual({
      text: 'boom',
      className: 'error',
    });
  });
});

describe('favorite button copy', () => {
  it('explains the offline lockout first', () => {
    expect(favoriteButtonTitle(false, false)).toBe('Reconnect to change locks');
    expect(favoriteButtonTitle(false, true)).toBe('Reconnect to change locks');
  });

  it('names the save-offline and agent-edit-lock pairing', () => {
    expect(favoriteButtonTitle(true, true)).toBe(
      'Saved offline & locked from agent edits (unlock)',
    );
    expect(favoriteButtonTitle(true, false)).toBe(
      'Save offline & lock from agent edits (lock)',
    );
  });

  it('labels the action the click performs for screen readers', () => {
    expect(favoriteAriaLabel(true)).toBe('Unlock article');
    expect(favoriteAriaLabel(false)).toBe('Lock article');
  });
});

describe('offlineActionTitle', () => {
  it('is undefined online - no tooltip on a working button', () => {
    expect(offlineActionTitle(true, 'edit')).toBeUndefined();
    expect(offlineActionTitle(true, 'ask-agent')).toBeUndefined();
    expect(offlineActionTitle(true, 'delete')).toBeUndefined();
  });

  it('names the blocked action offline', () => {
    expect(offlineActionTitle(false, 'edit')).toBe('Reconnect to edit');
    expect(offlineActionTitle(false, 'ask-agent')).toBe('Reconnect to run the agent');
    expect(offlineActionTitle(false, 'delete')).toBe('Reconnect to delete');
  });

  it('names the agent-edit lock when the article is locked', () => {
    expect(offlineActionTitle(true, 'ask-agent', true)).toBe(
      'Article is locked - unlock it to enable agent edits',
    );
    // The lock takes priority over the offline check - a locked
    // article shows the lock message even when offline.
    expect(offlineActionTitle(false, 'ask-agent', true)).toBe(
      'Article is locked - unlock it to enable agent edits',
    );
    // Unlocked articles are unaffected by the new parameter.
    expect(offlineActionTitle(true, 'ask-agent', false)).toBeUndefined();
  });
});

describe('sourceThreadLabel', () => {
  it('falls back for a thread the user never named', () => {
    expect(sourceThreadLabel('')).toBe('(untitled thread)');
  });

  it('passes a real title through', () => {
    expect(sourceThreadLabel('Sourdough troubleshooting')).toBe(
      'Sourdough troubleshooting',
    );
  });
});

describe('wikiHrefRoutePatch', () => {
  it('maps a cid source link onto the chat surface, clearing the wiki tab', () => {
    expect(wikiHrefRoutePatch('?cid=t-123')).toEqual({
      cid: 't-123',
      drawer: null,
      wiki_article_id: null,
    });
  });

  it('returns null for hrefs with no recognised routed key', () => {
    expect(wikiHrefRoutePatch('?foo=bar')).toBeNull();
    expect(wikiHrefRoutePatch('?')).toBeNull();
  });

  it('keeps an empty cid value - the param being present is the signal', () => {
    // URLSearchParams reports `?cid=` as an empty string, not null;
    // the mapping keys on presence, matching the original handler.
    expect(wikiHrefRoutePatch('?cid=')).toEqual({
      cid: '',
      drawer: null,
      wiki_article_id: null,
    });
  });
});
