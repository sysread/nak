/**
 * Schema-only export for memory_unrelate. Impl lives in
 * `./memory_unrelate`.
 */
export const memoryUnrelateSchema = {
  name: 'memory_unrelate',
  description:
    'Remove a directed edge between two memories. Hard-delete; no ' +
    "soft version. id is the relation row's UUID (not a memory id) - " +
    'surfaced when the relation appears in search. Returns ' +
    '{deleted: true}.',
  shortDescription: 'delete a memory relation',
  parameters: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: 'UUID of the relation row (NOT a memory id).',
      },
    },
    required: ['id'],
    additionalProperties: false,
  },
} as const;
