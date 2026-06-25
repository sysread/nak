/**
 * Schema-only export for memory_get. Impl lives function-side in
 * `supabase/functions/venice/tools/memory_get.ts`.
 *
 * Mirror of conversation_get / wiki_get against the `memories` table:
 * a primary-key fetch of one stored memory once the model knows which
 * id it wants - from a recall-block citation or a memory_search hit.
 */
export const memoryGetSchema = {
  name: 'memory_get',
  description:
    'Fetch a stored memory by id. Returns ' +
    '{found: true, memory: {id, label, data, confidence, created_at, ' +
    'updated_at}} or {found: false}. Use this to check a recalled fact ' +
    'against the verbatim stored memory before asserting a specific ' +
    '(a number, name, date, or decision) - the recall block is a ' +
    'compressed paraphrase, this is the source row. Ids come from the ' +
    'recall block citations or from memory_search. Prefer this over ' +
    'memory_search when you already know the id - a primary-key fetch ' +
    'is cheaper than a vector search.',
  shortDescription: 'fetch a stored memory by id',
  parameters: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description:
          'UUID of the memory (from a recall block citation or ' +
          'memory_search).',
      },
    },
    required: ['id'],
    additionalProperties: false,
  },
} as const;
