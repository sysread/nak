/**
 * Schema-only export for memory_relate. Impl lives in `./memory_relate`.
 */
export const RELATION_KINDS = [
  'supports',
  'contradicts',
  'generalises',
  'specialises',
] as const;

export type RelationKind = (typeof RELATION_KINDS)[number];

export const MEMORY_RELATE_MAX_NOTE_CHARS = 500;

export const memoryRelateSchema = {
  name: 'memory_relate',
  description:
    'Link two memories with a directed edge (supports / contradicts / ' +
    'generalises / specialises). Optional note (up to 500 chars) ' +
    'records the rationale. Relations surface next to their source ' +
    'memory in retrieval. Self-loops rejected; duplicate edges ' +
    '(same from/to/kind) collapse to no-op. Returns {id, kind}.',
  shortDescription: 'link two memories',
  parameters: {
    type: 'object',
    properties: {
      from_id: {
        type: 'string',
        description: 'UUID of the source memory (edge originates here).',
      },
      to_id: {
        type: 'string',
        description: 'UUID of the target memory (edge points here).',
      },
      kind: {
        type: 'string',
        enum: [...RELATION_KINDS],
        description:
          'supports = target reinforces source; contradicts = target ' +
          'disagrees; generalises = target is broader; specialises = ' +
          'target is narrower.',
      },
      note: {
        type: 'string',
        maxLength: MEMORY_RELATE_MAX_NOTE_CHARS,
        description: 'Optional rationale for the link.',
      },
    },
    required: ['from_id', 'to_id', 'kind'],
    additionalProperties: false,
  },
} as const;
