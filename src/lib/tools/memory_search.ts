/**
 * Find existing memories by a text query. Backed by pg's ILIKE on
 * `label || data` — fine for small-N user-scoped notes. A `vector`
 * column exists on the table and will take over once the embedding
 * path lands, but the tool surface stays the same.
 *
 * An empty/missing query lists everything (most-recent first), so the
 * LLM can ask "what do you remember about me?" with one call.
 */
import type { ToolDef } from './types';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

export const memorySearch: ToolDef = {
  name: 'memory_search',
  description:
    "Search the user's saved memories by substring. Returns an array of " +
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
          'Substring to match against the memory label and data ' +
          '(case-insensitive). Empty or omitted returns all memories.',
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
    return ctx.supabase.searchMemories(query, limit);
  },
};
