/**
 * Find existing memories by a query. With `query` non-empty we run a
 * cosine-similarity search against the pgvector column; with `query`
 * empty we list everything most-recent-first.
 *
 * The tool surface matches the pre-volitional-layer shape for the id/
 * label/data fields but now also carries `confidence`, `confidence_tag`
 * ([corroborated]/[hedged]/[shaky]/null), and a `relations` array
 * hydrated from the memory graph. The LLM sees the node's trust level
 * and its outbound edges in one round-trip rather than having to poll
 * per-row.
 *
 * The semantic-search pipeline (embed -> pad -> RPC + ILIKE merge)
 * lives in `src/lib/memories.ts` so the Memories browse UI can reuse
 * it verbatim. Keeping both call sites on one implementation prevents
 * drift where the model sees different results than the human browsing
 * the same table. The tool then layers relation-hydration and tag
 * classification on top; the UI does its own graph render from the
 * same supabase.listMemoryRelationsFor primitive.
 */
import type { ToolDef } from './types';
import type { MemoryRelation } from '../supabase';
import {
  searchMemoriesSemantic,
  classifyMemoryConfidence,
  type MemoryConfidenceTag,
} from '../memories';
import { createLogger } from '../logger.svelte';

const log = createLogger('memory-search');

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

/**
 * Max outbound edges rendered per matched memory in the tool result.
 * Same rationale as opening-recall's fan-out cap: keep the LLM's
 * round-trip payload bounded when one memory is very well-connected.
 */
const SEARCH_RELATION_FANOUT = 5;

export const memorySearch: ToolDef = {
  name: 'memory_search',
  description:
    "Search the user's saved memories by meaning. Returns an array of " +
    '{id, label, data, confidence, confidence_tag, updated_at, relations}. ' +
    '`confidence_tag` is one of "corroborated"/"hedged"/"shaky" or null ' +
    '(neutral). `relations` is the outbound edges for this memory ' +
    '(supports/contradicts/generalises/specialises) with the target ' +
    "memory's label/data inlined. Leave `query` empty to list every " +
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
    const memories = await searchMemoriesSemantic(query, limit, {
      supabase: ctx.supabase,
      venice: ctx.venice,
      signal: ctx.signal,
    });
    // Debug breadcrumb: every call logs the query (or "(list-all)" for
    // the empty-query browse path) and the resulting match count.
    // Surfaces in the log drawer regardless of caller (main chat,
    // reflection agent, recall agent), so a "recall returned nothing"
    // investigation can see exactly which paraphrases the recall model
    // tried and how each one scored.
    const queryLabel = query.length > 0 ? `"${query}"` : '(list-all)';
    log.debug(
      `search ${queryLabel} (limit=${limit}) -> ${memories.length} matches`
    );
    // Hydrate outbound edges in one batched RPC. Failures degrade
    // silently to "no relations" - the search result is still useful
    // without the graph layer, and the model can follow up with
    // memory_search again if edges would change its plan.
    let relationsByFrom = new Map<string, MemoryRelation[]>();
    if (memories.length > 0) {
      try {
        const ids = memories.map((m) => m.id);
        const edges = await ctx.supabase.listMemoryRelationsFor(ids);
        for (const edge of edges) {
          const list = relationsByFrom.get(edge.from_memory_id);
          if (list) list.push(edge);
          else relationsByFrom.set(edge.from_memory_id, [edge]);
        }
      } catch {
        // Swallow and continue with no edges; see above for why this
        // is preferable to failing the whole search.
        relationsByFrom = new Map();
      }
    }
    return memories.map((m) => {
      const tag: MemoryConfidenceTag = classifyMemoryConfidence(m.confidence);
      const edges = (relationsByFrom.get(m.id) ?? []).slice(
        0,
        SEARCH_RELATION_FANOUT
      );
      return {
        id: m.id,
        label: m.label,
        data: m.data,
        confidence: m.confidence,
        confidence_tag: tag,
        updated_at: m.updated_at,
        relations: edges.map((e) => ({
          id: e.id,
          kind: e.kind,
          note: e.note,
          target: {
            id: e.to_memory_id,
            label: e.to_label,
            data: e.to_data,
            confidence: e.to_confidence,
            confidence_tag: classifyMemoryConfidence(e.to_confidence),
          },
        })),
      };
    });
  },
};
