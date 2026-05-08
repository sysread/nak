/**
 * Schema-only export for memory_unrelate. Impl lives in
 * `./memory_unrelate`.
 */
export const memoryUnrelateSchema = {
  name: 'memory_unrelate',
  description:
    'Remove a directed edge between two memories. Hard-delete; no soft ' +
    "version. `id` is the relation row's id (not a memory id) - surfaced " +
    'when the relation appears in search or opening-recall output. Returns ' +
    '{deleted: true}.',
  shortDescription: 'delete a memory relation',
  parameters: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: 'UUID of the relation row (NOT a memory id) to delete.',
      },
    },
    required: ['id'],
    additionalProperties: false,
  },
} as const;
