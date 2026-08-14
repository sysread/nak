// Per-source embed-text composition for the server-side backfill route.
//
// Each embeddable table feeds the embedding model a single string built from a
// columns. The composition (which columns, in what order, with what soft
// boundary, capped at what length) is load-bearing: a row embedded here must
// produce the *same* vector it would have in the browser worker, or cosine
// search ranking drifts between old rows and new ones.
//
// These builders are a deliberate TypeScript port of the browser source
// adapters that used to live in src/lib/embeddings/sources/*. They stay in TS
// rather than moving into the SQL claim RPCs on purpose: JS String.slice counts
// UTF-16 code units while Postgres left()/substr count characters, so an emoji
// (astral-plane) sitting on a truncation boundary would make a SQL-composed
// string differ by a code point from the historical browser-composed one. The
// claim RPCs return the raw columns; we compose here so the cap semantics match
// byte-for-byte. See docs/dev/in-progress/venice-edge-functions/embeddings.md.

// Defensive truncation so a historical row can't loop the backfill on an
// input the model rejects for context overflow.
//
// This deliberately does NOT track MAX_MEMORY_DATA_CHARS in
// src/lib/memories.ts, which the write boundary lowered to 2500. Lowering
// the truncation here too would re-embed every legacy row longer than 2500
// on a truncated body, and a row's vector must not depend on when it
// happened to be embedded - that is the ranking drift the file preamble
// warns about. The write cap bounds what NEW content can be; this bound
// only exists to keep the model from choking on a pre-cap row.
const MAX_MEMORY_EMBED_CHARS = 8000;

// Recipes have no application-side length cap (cooklang is the source of truth
// and can run several kilobytes), so the truncation lives only here.
const MAX_RECIPE_EMBED_CHARS = 16000;

import { MAX_WIKI_CONTENT_CHARS, MAX_WIKI_RECORD_CONTENT_CHARS } from './wiki-limits.ts';

// Substrate situation/outcome have no schema-level cap yet; these match the
// memory-side order of magnitude and leave headroom for tokenizer inflation.
const MAX_SUBSTRATE_SITUATION_CHARS = 6000;
const MAX_SUBSTRATE_OUTCOME_CHARS = 2000;

// Follow-ups are short by construction (question 200 / context 500 at the
// tool boundary - see _shared/followups.ts); the cap here is a defensive
// backstop only.
const MAX_FOLLOWUP_EMBED_CHARS = 2000;


/**
 * Compose the string the embedding model sees for a memory row. The label carries a lot
 * of semantic weight for short notes ("gym PIN", "mom's birthday") so it leads
 * verbatim; the double-newline is a soft boundary that biases the model to weigh
 * label against body rather than smearing them.
 */
export function buildMemoryEmbedInput(label: string, data: string): string {
  const body =
    data.length > MAX_MEMORY_EMBED_CHARS ? data.slice(0, MAX_MEMORY_EMBED_CHARS) : data;
  return `${label}\n\n${body}`;
}

/**
 * Compose the text Venice embeds for a recipe. Title leads (a recipe titled
 * "kombucha" should match "fermented tea" via the title path), then the
 * optional free-form source line, then the cooklang body, double-newline
 * between blocks.
 */
export function buildRecipeEmbedInput(
  title: string,
  source: string | null,
  cooklang: string
): string {
  const blocks: string[] = [title];
  if (source && source.trim().length > 0) blocks.push(source.trim());
  blocks.push(cooklang);
  const joined = blocks.join('\n\n');
  return joined.length > MAX_RECIPE_EMBED_CHARS
    ? joined.slice(0, MAX_RECIPE_EMBED_CHARS)
    : joined;
}

/**
 * Compose the text Venice embeds for a wiki article. Title carries the topical
 * load, so it leads verbatim with a double-newline before the body.
 */
export function buildWikiEmbedInput(title: string, content: string): string {
  const body =
    content.length > MAX_WIKI_CONTENT_CHARS ? content.slice(0, MAX_WIKI_CONTENT_CHARS) : content;
  return `${title}\n\n${body}`;
}

/**
 * Compose the text Venice embeds for a wiki record. The ISO date leads
 * verbatim (so "what happened in March" can match temporally) with a
 * double-newline before the body. Tags are deliberately excluded - they
 * are a filtering facet, not semantic content, and folding them in would
 * let a noisy tag dominate the vector.
 */
export function buildWikiRecordEmbedInput(date: string, content: string): string {
  const body =
    content.length > MAX_WIKI_RECORD_CONTENT_CHARS
      ? content.slice(0, MAX_WIKI_RECORD_CONTENT_CHARS)
      : content;
  return `${date}\n\n${body}`;
}

/**
 * Build the string Venice embeds for a samskara substrate row. Situation (the
 * assimilator's third-person observation) plus the optional outcome (what the
 * assistant did and how it landed) - outcome carries semantic weight separate
 * from situation, so a soft boundary keeps both visible.
 */
export function buildSubstrateEmbedInput(situation: string, outcome: string | null): string {
  const trimmedSituation =
    situation.length > MAX_SUBSTRATE_SITUATION_CHARS
      ? situation.slice(0, MAX_SUBSTRATE_SITUATION_CHARS)
      : situation;
  if (!outcome || outcome.length === 0) return trimmedSituation;
  const trimmedOutcome =
    outcome.length > MAX_SUBSTRATE_OUTCOME_CHARS
      ? outcome.slice(0, MAX_SUBSTRATE_OUTCOME_CHARS)
      : outcome;
  return `${trimmedSituation}\n\n${trimmedOutcome}`;
}

/**
 * Compose the text Venice embeds for a follow-up. Question leads (it names
 * the topic: "Ask how the lasagna turned out"), context trails behind a soft
 * boundary. The semantic axis matches the user re-raising the TOPIC, so both
 * halves carry signal.
 */
export function buildFollowupEmbedInput(question: string, context: string): string {
  const combined = context.trim().length > 0 ? `${question}\n\n${context}` : question;
  return combined.length > MAX_FOLLOWUP_EMBED_CHARS
    ? combined.slice(0, MAX_FOLLOWUP_EMBED_CHARS)
    : combined;
}

/**
 * One embeddable table, expressed declaratively so the backfill loop can walk
 * every source without per-table branching. `claimRpc` returns the next
 * pending row (globally, across all members - the RPCs are service-definer; see
 * the schema), `buildInput` shapes that row into Venice's input string, and
 * `saveRpc` writes the vector back if our claim still holds.
 *
 * `buildInput` reads its own columns off the loosely-typed RPC row - the row
 * shape is whatever the matching claim RPC returns, mirrored in the comments.
 */
export interface EmbedSource {
  name: string;
  claimRpc: string;
  saveRpc: string;
  buildInput: (row: Record<string, unknown>) => string;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const strOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/**
 * Registry of every table the backfill drains, in round-robin order. Adding a
 * new embeddable table is one entry here plus its claim/save RPC pair in
 * schema.sql.
 */
export const EMBED_SOURCES: EmbedSource[] = [
  {
    name: 'memories',
    claimRpc: 'claim_next_pending_memory', // returns (id, label, data, user_id)
    saveRpc: 'save_memory_embedding_if_claimed',
    buildInput: (row) => buildMemoryEmbedInput(str(row.label), str(row.data)),
  },
  {
    name: 'recipes',
    claimRpc: 'claim_next_pending_recipe', // returns (id, title, source, cooklang, user_id)
    saveRpc: 'save_recipe_embedding_if_claimed',
    buildInput: (row) =>
      buildRecipeEmbedInput(str(row.title), strOrNull(row.source), str(row.cooklang)),
  },
  {
    name: 'wiki',
    claimRpc: 'claim_next_pending_wiki_article', // returns (id, title, content, user_id)
    saveRpc: 'save_wiki_article_embedding_if_claimed',
    buildInput: (row) => buildWikiEmbedInput(str(row.title), str(row.content)),
  },
  {
    name: 'wiki-records',
    claimRpc: 'claim_next_pending_wiki_record', // returns (id, date, content, tags, user_id)
    saveRpc: 'save_wiki_record_embedding_if_claimed',
    // date arrives as an ISO 'YYYY-MM-DD' string over the RPC boundary.
    buildInput: (row) => buildWikiRecordEmbedInput(str(row.date), str(row.content)),
  },
  {
    name: 'samskara-substrate',
    claimRpc: 'samskara_claim_next_substrate_embed', // returns (id, situation, outcome, user_id)
    saveRpc: 'samskara_save_substrate_embedding_if_claimed',
    buildInput: (row) => buildSubstrateEmbedInput(str(row.situation), strOrNull(row.outcome)),
  },
  {
    name: 'followups',
    claimRpc: 'claim_next_pending_followup', // returns (id, question, context, user_id)
    saveRpc: 'save_followup_embedding_if_claimed',
    buildInput: (row) => buildFollowupEmbedInput(str(row.question), str(row.context)),
  },
  {
    name: 'thread-chunks',
    claimRpc: 'claim_next_pending_thread_chunk', // returns (id, content, user_id)
    saveRpc: 'save_thread_chunk_embedding_if_claimed',
    // The only source whose input needs no composition: the rechunk unit
    // already rendered and sized this text (see
    // _shared/thread-transcript.ts), so re-truncating it here would
    // silently shorten what the chunker deliberately packed to the
    // model's budget. Passed through verbatim on purpose.
    buildInput: (row) => str(row.content),
  },
];
