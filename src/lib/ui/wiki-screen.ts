/**
 * UI-behavior primitives scoped to the Wiki screen
 * (src/screens/Wiki.svelte). Pure functions only - no runes, no Svelte
 * imports, no DOM. The screen composes these with its own
 * framework-native reactivity (the wikiStore reads, the route watch,
 * the supabase orchestration, and the markup).
 *
 * Sibling modules split the wiki surface by feature: `wiki-list.ts`
 * owns the sidebar listing, `wiki-toc-sections.ts` the article ToC,
 * `wiki-manual.ts` the "Ask agent to update" preview,
 * `wiki-librarian-run.ts` the manual librarian strip,
 * `wiki-changelog-panel.ts` / `wiki-skipped-panel.ts` their panels.
 * This module owns the decisions that are the screen's own: which
 * loaded row the route resolves to, form validation + error copy for
 * the direct-edit flows, the edit form's save-state footer, the
 * offline/favorite button copy, and the article-body link routing.
 *
 * Named `wiki-screen.ts` (not `wiki.ts`) because `src/lib/wiki.ts` is
 * the domain module - the char ceilings and semantic search helper.
 */

import {
  MAX_WIKI_TITLE_CHARS,
  MAX_WIKI_CONTENT_CHARS,
  MAX_WIKI_CHANGELOG_MESSAGE_CHARS,
} from '$lib/wiki';
import type { WikiArticle } from '../supabase';

// ---------------------------------------------------------------
// Selected-article resolution
// ---------------------------------------------------------------

/**
 * Resolve the routed article id against the rows the screen can
 * render, in precedence order: the loaded result list, then the
 * Favorites bucket (offline-sync mirrors favorites even when the
 * browse list hasn't paged them in), then the read-through fallback
 * row - but only when that row actually matches the id, so a stale
 * fetch for a previously-routed article can't render under the new
 * route. Returns null when nothing matches (still fetching, offline
 * and not saved, or genuinely gone).
 *
 * The read-through effect calls this with `fetched: null` to ask the
 * narrower question "is the id already in the loaded sets" before
 * spending a fetch on it.
 */
export function resolveSelectedArticle(
  id: string | null,
  results: readonly WikiArticle[],
  favorites: readonly WikiArticle[],
  fetched: WikiArticle | null,
): WikiArticle | null {
  if (!id) return null;
  return (
    results.find((a) => a.id === id) ??
    favorites.find((a) => a.id === id) ??
    (fetched?.id === id ? fetched : null)
  );
}

// ---------------------------------------------------------------
// Form validation (edit / compose / delete)
// ---------------------------------------------------------------

/**
 * Validate the required one-line changelog message every direct
 * mutation demands - the user's manual equivalent of the `message`
 * arg the wiki_update / wiki_delete tools require of the agents.
 * `context` picks the verb in the "add a message first" nudge so the
 * copy names the action the user is mid-way through. Expects a
 * pre-trimmed message (the caller trims because it also sends the
 * trimmed text to the changelog write). Returns the error to display,
 * or null when the message passes.
 */
export function changelogMessageError(
  message: string,
  context: 'saving' | 'deleting',
): string | null {
  if (!message) {
    return `Add a one-line change message before ${
      context === 'saving' ? 'saving' : 'deleting'
    }.`;
  }
  if (message.length > MAX_WIKI_CHANGELOG_MESSAGE_CHARS) {
    return `Change message must be ${MAX_WIKI_CHANGELOG_MESSAGE_CHARS} chars or fewer.`;
  }
  return null;
}

/**
 * First validation error for the edit and compose forms' three
 * fields, or null when the draft is saveable. Check order matches the
 * forms' visual order (title, content, message) so the reported error
 * is always the topmost offending field. Expects a pre-trimmed title
 * and message; content is taken verbatim - trailing whitespace in an
 * article body is the user's call. The caps mirror the wiki tool
 * schemas (see $lib/wiki) so the UI rejects early instead of bouncing
 * off a Supabase error.
 */
export function articleFormError(
  title: string,
  content: string,
  message: string,
): string | null {
  if (!title) return 'Title is required.';
  if (title.length > MAX_WIKI_TITLE_CHARS) {
    return `Title must be ${MAX_WIKI_TITLE_CHARS} chars or fewer.`;
  }
  if (!content) return 'Content is required.';
  if (content.length > MAX_WIKI_CONTENT_CHARS) {
    return `Content must be ${MAX_WIKI_CONTENT_CHARS} chars or fewer.`;
  }
  return changelogMessageError(message, 'saving');
}

/**
 * User-facing error for a failed article create. The
 * unique(user_id, title) constraint surfaces for human creates too,
 * and by the time it reaches the browser client it is message text,
 * not a structured code - rephrase it so the user sees actionable
 * copy rather than a Postgres error. Anything else passes through
 * verbatim.
 */
export function createArticleErrorMessage(raw: string): string {
  return /duplicate key|unique constraint/i.test(raw)
    ? 'An article with that title already exists.'
    : raw;
}

// ---------------------------------------------------------------
// Edit-form save state
// ---------------------------------------------------------------

/**
 * Save indicator for the inline edit form. No 'saved' kind on
 * purpose: a successful save closes the form (the form closing is
 * the success signal), so there is never a settled-success footer to
 * render. Parallel to MemorySaveState in memories.ts, which keeps
 * its form open and therefore does carry one.
 */
export type WikiEditSaveState =
  | { kind: 'idle' }
  | { kind: 'dirty' } // draft differs from the row on the server
  | { kind: 'saving' }
  | { kind: 'error'; message: string };

/**
 * The status line rendered under the edit form's fields, or null when
 * there is nothing to report (idle, and saving - the Save button's
 * own progressive caption covers the in-flight state). `className`
 * matches the global helpers the markup uses: `subtle` for the
 * unsaved-changes hint, `error` for validation and RPC failures.
 */
export function editSaveNotice(
  state: WikiEditSaveState,
): { text: string; className: 'subtle' | 'error' } | null {
  if (state.kind === 'error') {
    return { text: state.message, className: 'error' };
  }
  if (state.kind === 'dirty') {
    return { text: 'Unsaved changes.', className: 'subtle' };
  }
  return null;
}

// ---------------------------------------------------------------
// Article-view button copy
// ---------------------------------------------------------------

/**
 * Hover-title for the favorite (save-offline) star. Marking an
 * article favorite is what saves it offline, so the copy names both
 * halves of the operation - the star alone would read as a plain
 * bookmark. The toggle itself is a server write, hence the offline
 * variant.
 */
export function favoriteButtonTitle(online: boolean, favorite: boolean): string {
  if (!online) return 'Reconnect to change favorites';
  return favorite
    ? 'Saved offline (remove from favorites)'
    : 'Save offline (mark as favorite)';
}

/** Screen-reader label for the favorite star - the action the click
 *  performs, without the offline framing the sighted-user title
 *  carries (aria-pressed already conveys the current state). */
export function favoriteAriaLabel(favorite: boolean): string {
  return favorite ? 'Remove from favorites' : 'Mark as favorite';
}

/**
 * Hover-title for the article-header action buttons, or undefined
 * when no tooltip is needed. Edit, the agent update, and delete all
 * write to Supabase, so they disable offline - the title explains
 * the greyed-out button instead of letting the click fail on submit.
 */
export function offlineActionTitle(
  online: boolean,
  action: 'edit' | 'ask-agent' | 'delete',
): string | undefined {
  if (online) return undefined;
  if (action === 'edit') return 'Reconnect to edit';
  if (action === 'ask-agent') return 'Reconnect to run the agent';
  return 'Reconnect to delete';
}

// ---------------------------------------------------------------
// Sources list
// ---------------------------------------------------------------

/**
 * Display label for a Sources entry whose thread still exists. An
 * empty title is a thread the user never named - distinct from the
 * null title the caller branches on, which means the thread row is
 * gone (delete cascade not yet caught up by the sources sidecar).
 */
export function sourceThreadLabel(title: string): string {
  return title || '(untitled thread)';
}

// ---------------------------------------------------------------
// Article-body link routing
// ---------------------------------------------------------------

/**
 * Map a relative `?key=val` href from a rendered article body onto a
 * `navigate()` patch, or null when no routed key we recognise
 * appears (the caller swallows the click - a dead in-app link beats
 * a full page navigation). The wiki agents emit `[label](?cid=<id>)`
 * links to anchor facts to their source conversation; a cid patch
 * also clears the wiki tab so the user lands on the chat surface
 * rather than staying inside the wiki panel with a thread id behind
 * the scenes. Other routed keys can grow here as the agents adopt
 * them.
 */
export function wikiHrefRoutePatch(
  href: string,
): Record<string, string | null> | null {
  const params = new URLSearchParams(href);
  const patch: Record<string, string | null> = {};
  const cid = params.get('cid');
  if (cid !== null) {
    patch.cid = cid;
    patch.drawer = null;
    patch.wiki_article_id = null;
  }
  return Object.keys(patch).length === 0 ? null : patch;
}
