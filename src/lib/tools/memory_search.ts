/**
 * Find existing memories by a query. With `query` non-empty we run a
 * cosine-similarity search against the pgvector column; with `query`
 * empty we list everything most-recent-first.
 *
 * The tool surface is unchanged by design — the LLM can't tell vector
 * search apart from ILIKE, and keeping the parameters identical means
 * the rest of the chat plumbing (system-prompt catalog, tool registry,
 * threaded state) didn't move.
 *
 * The actual semantic-search pipeline (embed → pad → RPC + ILIKE
 * merge) lives in `src/lib/memories.ts` so the Memories browse UI can
 * reuse it verbatim. Keeping both call sites on one implementation
 * prevents drift where the model sees different results than the
 * human browsing the same table.
 */
import type { ToolDef } from './types';
import { searchMemoriesSemantic } from '../memories';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

export const memorySearch: ToolDef = {
  name: 'memory_search',
  description:
    "Search the user's saved memories by meaning. Returns an array of " +
    '{id, label, data, updated_at}. Leave `query` empty to list every ' +
    'memory. Use this before memory_update / memory_delete to find the ' +
    'id of the memory you want to target.',
  shortDescription: "search the user's saved notes",
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description:
          'Natural-language query. Semantic (embedding) match — paraphrases ' +
          'and synonyms work, not just substrings. Empty or omitted returns ' +
          'all memories.',
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: MAX_LIMIT,
        description: `Max results to return (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}).`,
      },
    },
    additionalProperties: false,
  },
  async execute(args, ctx) {
    const query = typeof args.query === 'string' ? args.query.trim() : '';
    const rawLimit = typeof args.limit === 'number' ? args.limit : DEFAULT_LIMIT;
    const limit = Math.max(1, Math.min(MAX_LIMIT, Math.floor(rawLimit)));
    return searchMemoriesSemantic(query, limit, {
      supabase: ctx.supabase,
      venice: ctx.venice,
      signal: ctx.signal,
    });
  },
};
