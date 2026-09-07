/**
 * Schema-only export for memory_update. Impl lives in `./memory_update`.
 */
import { MAX_MEMORY_DATA_CHARS } from '../memories';
import { MAX_MEMORY_CHANGELOG_MESSAGE_CHARS } from '../memories';

export const memoryUpdateSchema = {
  name: 'memory_update',
  // Only id is required; every omitted field is left unchanged. The
  // changelog message defaults server-side, mirroring memory_create -
  // models were observed skipping it (or inventing a param to carry it)
  // and round-tripping the rejection when it was required.
  description:
    'Update a memory by id (use memory_search to find the id). Only id ' +
    'is required; provide at least one of label or data to change, and ' +
    'omit everything else. A refine tightens or holds steady - the new ' +
    'data is never longer than the body it replaces. For confidence, ' +
    'prefer memory_reaffirm / memory_doubt for incremental ' +
    'evidence-based nudges; memory_update sets it only to correct a ' +
    'value that is outright wrong. Returns the updated row.',
  shortDescription: 'edit a saved note',
  parameters: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: 'Required. UUID of the memory (from memory_search).',
      },
      label: { type: 'string', minLength: 1, maxLength: 80 },
      data: { type: 'string', minLength: 1, maxLength: MAX_MEMORY_DATA_CHARS },
      message: {
        type: 'string',
        minLength: 1,
        maxLength: MAX_MEMORY_CHANGELOG_MESSAGE_CHARS,
        description:
          'Optional. One-line, commit-style summary of what changed and ' +
          'why; lands in the memory changelog. Omit to auto-derive from ' +
          'the label.',
      },
      confidence: {
        type: 'number',
        minimum: 1.0,
        maximum: 10.0,
        description:
          'Optional. Directly set confidence: a decimal >= 1.0 and ' +
          '<= 10.0 (e.g. 2.5). NOT a 0-1 probability. Prefer ' +
          'memory_reaffirm / memory_doubt for incremental nudges; use ' +
          'this to correct a confidence that is outright wrong.',
      },
    },
    required: ['id'],
    additionalProperties: false,
  },
} as const;
