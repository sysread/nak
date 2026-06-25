/**
 * UI-behavior primitives for citation rendering - shared by web-search
 * citations (external URLs on an assistant message) and context-recall
 * citations (internal-route links to a memory / conversation / wiki
 * article). Both normalize into `DisplayCitation` so a single
 * `CitationsPanel.svelte` renders one shape; the kind-to-route, label,
 * and pluralization decisions live here, not in the component (per
 * `src/components/CLAUDE.md`).
 *
 * Pure functions only - no runes, no DOM, no Svelte imports.
 */
import type { Citation } from '$lib/venice';
import type { ContextRecallCitation } from '$lib/context-recall';
import type { Route } from '$lib/routing.svelte';

/** The normalized row `CitationsPanel` renders. */
export interface DisplayCitation {
  /** 1-based; matches the `^N^` superscript in the body. */
  index: number;
  /** Link text. */
  label: string;
  /** Destination: an absolute URL (web) or a `?key=id` in-app route. */
  href: string;
  /** External URLs open in a new tab; internal routes navigate in-app. */
  external: boolean;
  /** Muted sub-line: the source date (web) or the source kind (recall). */
  meta?: string | null;
  /** Optional longer snippet (web search only). */
  snippet?: string | null;
}

/** Map a web-search `Citation` onto the display shape. */
export function webCitationToDisplay(c: Citation): DisplayCitation {
  return {
    index: c.index,
    label: c.title || c.url,
    href: c.url,
    external: true,
    meta: c.date ?? null,
    snippet: c.content ?? null,
  };
}

/** Human label for a recall citation's source kind. */
export function recallKindLabel(kind: ContextRecallCitation['kind']): string {
  switch (kind) {
    case 'memory':
      return 'memory';
    case 'conversation':
      return 'prior conversation';
    case 'wiki':
      return 'wiki article';
  }
}

/** The in-app `?key=id` route a recall citation links to. */
export function recallCitationHref(c: ContextRecallCitation): string {
  const id = encodeURIComponent(c.id);
  switch (c.kind) {
    case 'memory':
      return `?memory=${id}`;
    case 'conversation':
      return `?cid=${id}`;
    case 'wiki':
      return `?wiki_article_id=${id}`;
  }
}

/** Map a context-recall citation onto the display shape. */
export function recallCitationToDisplay(
  c: ContextRecallCitation,
): DisplayCitation {
  return {
    index: c.index,
    label: c.label || recallKindLabel(c.kind),
    href: recallCitationHref(c),
    external: false,
    meta: recallKindLabel(c.kind),
    snippet: null,
  };
}

/**
 * Parse a recall citation's `?key=id` href into a `navigate()` patch.
 * Clears `modal` (closing the Recall diagnostics modal) and switches to
 * the drawer/surface that owns the target. Returns null for an href that
 * isn't one of the three known internal routes, so a click handler can
 * ignore non-citation links.
 */
export function parseRecallCitationNav(href: string): Partial<Route> | null {
  const m = /^\?(memory|cid|wiki_article_id)=(.+)$/.exec(href);
  if (!m) return null;
  const id = decodeURIComponent(m[2]);
  switch (m[1]) {
    case 'memory':
      return { drawer: 'memories', memory: id, modal: null };
    case 'cid':
      return { cid: id, drawer: null, modal: null };
    case 'wiki_article_id':
      return { drawer: 'wiki', wiki_article_id: id, modal: null };
  }
  return null;
}

/** Toggle-button label for the sources panel ("3 sources" / "1 source"). */
export function sourcesLabel(count: number): string {
  if (count <= 0) return 'Sources';
  return `${count} source${count === 1 ? '' : 's'}`;
}
