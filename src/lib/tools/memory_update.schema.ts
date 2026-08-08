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
    'Update a memory by id (use memory_search to find the id). Only id is ' +
    'required. Provide at least one of label or data to change; any field ' +
    'you omit is left unchanged ' +
    `(data capped at ${MAX_MEMORY_DATA_CHARS} chars, and never longer than ` +
    'the body you are replacing - a refine tightens or holds steady, it does ' +
    'not accrete). Optional message is a one-line, commit-style summary of ' +
    'what changed and why, which lands in the memory changelog the user ' +
    'reviews; omit it to auto-derive one from the label. This tool does NOT ' +
    'change confidence - use memory_reaffirm or memory_doubt for that. ' +
    'Returns the updated row.',
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
    },
    required: ['id'],
    additionalProperties: false,
  },
} as const;
