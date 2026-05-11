/**
 * Shared semantic-search pipeline for the user wiki. Parallel to
 * `src/lib/memories.ts` and `src/lib/journal-events.ts` family - the
 * UI (`src/components/WikiList.svelte`, `src/screens/Wiki.svelte`) and
 * the LLM-facing tool (`src/lib/tools/wiki_search.ts`) both call
 * `searchWikiArticlesSemantic` so the user finds what the assistant
 * finds.
 *
 * The merge contract lives in `SupabaseService.searchWikiArticles`:
 * vector hits first (RPC), then ILIKE hits the vector path missed,
 * deduped by id and capped at `limit`. This module's only job is to
 * embed the query via Venice (when available) and hand the embedding
 * to the supabase method.
 *
 * Why the silent Venice fallback: a transient Venice error here would
 * otherwise blank the drawer. ILIKE-only is strictly better than a
 * hard error from the user's POV.
 */

import type { SupabaseService, WikiArticle } from './supabase';
import type { VeniceClient } from './venice';
import { VENICE_EMBEDDING_MODEL, padEmbeddingForStorage } from './models';

export interface SearchWikiDeps {
  supabase: SupabaseService;
  venice: VeniceClient | null;
  signal?: AbortSignal;
}

/**
 * Length ceiling on the article title. Defensive cap so a corrupt or
 * model-generated title can't balloon the prompt or break the
 * sidebar layout. The `(user_id, title)` unique index has no length
 * limit at the DB layer; this is the application-side bound.
 */
export const MAX_WIKI_TITLE_CHARS = 200;

/**
 * Length ceiling on the article body. Mirrors the journal's
 * `MAX_JOURNAL_CONTENT_CHARS = 16000`. The embedding source includes
 * title + content so the cap also protects the embedding input from
 * blowing past the embedding model's window.
 */
export const MAX_WIKI_CONTENT_CHARS = 16000;

export async function searchWikiArticlesSemantic(
  query: string,
  limit: number,
  deps: SearchWikiDeps,
): Promise<WikiArticle[]> {
  const { supabase, venice, signal } = deps;
  const trimmed = query.trim();

  // Empty query: alphabetical listing. searchWikiArticles short-
  // circuits to listWikiArticles in this branch.
  if (trimmed.length === 0) {
    return supabase.searchWikiArticles({ query: '', queryEmbedding: null, limit });
  }

  // No Venice client: ILIKE-only.
  if (!venice) {
    return supabase.searchWikiArticles({ query: trimmed, queryEmbedding: null, limit });
  }

  let rawEmbedding: number[] | undefined;
  try {
    const response = await venice.embed({
      model: VENICE_EMBEDDING_MODEL,
      input: trimmed,
      signal,
    });
    rawEmbedding = response.data[0]?.embedding;
  } catch {
    // Silent fallback - see file-level comment.
    return supabase.searchWikiArticles({ query: trimmed, queryEmbedding: null, limit });
  }

  if (!rawEmbedding || rawEmbedding.length === 0) {
    return supabase.searchWikiArticles({ query: trimmed, queryEmbedding: null, limit });
  }

  // Pad to the column's storage dim (2048). Cosine-invariant.
  const queryEmbedding = padEmbeddingForStorage(rawEmbedding);
  return supabase.searchWikiArticles({
    query: trimmed,
    queryEmbedding,
    limit,
  });
}

/**
 * Source-conversation links inside article content.
 *
 * The wiki agents are encouraged to anchor facts in the conversation
 * they came from by inserting Markdown links of the form
 * `[label](?cid=<uuid>)`. The relative `?cid=` URL hits the existing
 * routing layer that already handles thread navigation.
 *
 * The contract for the agents:
 *   - Autonomous agent: only the current thread's id is valid (passed
 *     into the prompt explicitly).
 *   - Librarian: only thread ids returned from `conversation_search`
 *     are valid.
 *
 * As defense-in-depth, every wiki_create / wiki_update tool call
 * runs the article content through `extractCidLinkIds` and then
 * validates the extracted ids via `findUnknownCidLinks` before
 * persisting. Any link to a thread that doesn't exist for the
 * current user surfaces as an actionable tool-error, and the agent
 * retries without the fabricated link.
 */

/**
 * Match a relative `?cid=<value>` URL inside a Markdown link target.
 * The value is captured up to the next `&`, `"`, `)`, `]`, whitespace,
 * or end-of-string. Returns the candidate values (NOT yet validated
 * as UUIDs - the validator handles that).
 *
 * Permissive on purpose: a link that has the wrong shape is filtered
 * out by the UUID-format check below rather than missed by a too-strict
 * regex.
 */
const CID_LINK_RE = /\?cid=([^&\s)\]"']+)/gi;

/**
 * Strict UUID v4-ish shape (8-4-4-4-12 hex). The threads table uses
 * `gen_random_uuid()`, which produces v4. A non-UUID id can't exist
 * in the table, so we drop those without a round-trip.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Extract every `?cid=<uuid>` value from article content. Deduplicates
 * the result so the validator doesn't issue the same id twice. Skips
 * candidates that don't match UUID shape - those are either typos or
 * deliberate fakery; either way they'll fail validation.
 */
function extractCidLinkIds(content: string): string[] {
  if (!content) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const match of content.matchAll(CID_LINK_RE)) {
    const candidate = match[1];
    if (!candidate) continue;
    if (!UUID_RE.test(candidate)) {
      // Malformed shape - record it so the validator can flag it
      // even though it won't be in the DB lookup result.
      if (!seen.has(candidate)) {
        seen.add(candidate);
        out.push(candidate);
      }
      continue;
    }
    const lc = candidate.toLowerCase();
    if (!seen.has(lc)) {
      seen.add(lc);
      out.push(lc);
    }
  }
  return out;
}

/**
 * Validate every `?cid=<uuid>` link in article content. Returns the
 * array of ids that DO NOT correspond to a thread the current user
 * owns. Empty array means every link is valid (or there are no
 * links).
 *
 * Callers (wiki_create, wiki_update) should reject the tool call
 * when this returns a non-empty array, surfacing the unknown ids
 * back to the model so it can retry without them.
 */
export async function findUnknownCidLinks(
  supabase: { findExistingThreadIds(ids: readonly string[]): Promise<Set<string>> },
  content: string,
): Promise<string[]> {
  const candidates = extractCidLinkIds(content);
  if (candidates.length === 0) return [];
  // Don't bother round-tripping ids that aren't UUID-shaped - those
  // can't exist in the threads table by construction.
  const validShape = candidates.filter((c) => UUID_RE.test(c));
  const malformed = candidates.filter((c) => !UUID_RE.test(c));
  const existing =
    validShape.length === 0
      ? new Set<string>()
      : await supabase.findExistingThreadIds(validShape);
  const missing = validShape.filter((id) => !existing.has(id));
  return [...malformed, ...missing];
}
