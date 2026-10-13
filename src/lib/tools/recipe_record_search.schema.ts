/**
 * Schema-only export for recipe_record_search. Impl lives in
 * `./recipe_record_search` (edge:
 * supabase/functions/venice/tools/recipe_record_search.ts).
 */
export const recipeRecordSearchSchema = {
  name: 'recipe_record_search',
  description:
    "Search across ALL the user's cooking records (every recipe): " +
    'meaning-ranked vector hits MERGED with substring hits (both ' +
    'legs always run, so a literal keyword the vector missed still ' +
    'surfaces). Provide a natural-language query; optional ' +
    "recipe_id scopes the search to " +
    'one recipe\'s log and optional outcome filters to success / ' +
    'mixed / failure ("failed rye bakes across everything"). When ' +
    'the embedder is unreachable the tool degrades to substring ' +
    'matching instead of returning empty - a ' +
    'deliberate divergence from the wiki record search, which goes ' +
    'quiet while embedding is down - so a blank result here means ' +
    'genuinely nothing matched. Also the dedup affordance on ' +
    'capture: search before recipe_record_create when the user ' +
    'describes a cook that may already be logged. Prefer ' +
    "recipe_record_list when you already know the recipe and just " +
    'want its timeline. Returns {records: [{id, recipe_id, date, ' +
    'content, tags, outcome, source_conversation_id, created_at, ' +
    'updated_at, similarity}]} - the vector hits merged with ' +
    'substring hits (both always run; the ILIKE leg also covers ' +
    'embedder-down).',
  shortDescription: 'semantic search over cooking records',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        minLength: 1,
        description: 'Required. Natural-language description of what to find.',
      },
      limit: {
        type: 'number',
        description: 'Optional. Max records to return (default 10, max 30).',
      },
      recipe_id: {
        type: 'string',
        description: 'Optional. UUID to scope the search to one recipe\'s log.',
      },
      outcome: {
        type: 'string',
        enum: ['success', 'mixed', 'failure'],
        description: 'Optional. Only records classified with this outcome.',
      },
    },
    required: ['query'],
    additionalProperties: false,
  },
} as const;
