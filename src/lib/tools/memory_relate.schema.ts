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
    'Link two memories with a directed edge. `kind` is one of ' +
    'supports/contradicts/generalises/specialises. `note` is an ' +
    'optional short rationale (up to 500 chars) describing the link. ' +
    'Relations show up next to their source memory when it surfaces in ' +
    'retrieval. Self-loops are rejected; repeated edges (same ' +
    'from/to/kind) collapse to a no-op. Returns {id, kind}.',
  shortDescription: 'link two memories',
  parameters: {
    type: 'object',
    properties: {
      from_id: {
        type: 'string',
        description: 'UUID of the source memory (the edge originates here).',
      },
      to_id: {
        type: 'string',
        description: 'UUID of the target memory (the edge points here).',
      },
      kind: {
        type: 'string',
        enum: [...RELATION_KINDS],
        description:
          'Relation kind. supports=target reinforces source; ' +
          'contradicts=target disagrees with source; ' +
          'generalises=target is a broader form; ' +
          'specialises=target is a narrower/concrete case.',
      },
      note: {
        type: 'string',
        maxLength: MEMORY_RELATE_MAX_NOTE_CHARS,
        description: 'Optional short rationale for the link.',
      },
    },
    required: ['from_id', 'to_id', 'kind'],
    additionalProperties: false,
  },
} as const;
