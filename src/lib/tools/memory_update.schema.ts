/**
 * Schema-only export for memory_update. Impl lives in `./memory_update`.
 */
import { MAX_MEMORY_DATA_CHARS } from '../memories';
import { MAX_MEMORY_CHANGELOG_MESSAGE_CHARS } from '../memories';

export const memoryUpdateSchema = {
  name: 'memory_update',
  // Required fields (id, message) named before the optional content
  // fields. The required `message` previously trailed the optional
  // label/data in both the prose and the property list, which let
  // models skip it as if it were optional like the fields ahead of it.
  description:
    'Update a memory by id (use memory_search to find the id). Two ' +
    'required fields: id, and message (a one-line, commit-style summary ' +
    'of what changed and why, which lands in the memory changelog the ' +
    'user reviews). Then provide at least one of label or data to change ' +
    `(data capped at ${MAX_MEMORY_DATA_CHARS} chars); omit either to ` +
    'leave it unchanged. Returns the updated row.',
  shortDescription: 'edit a saved note',
  // Required fields lead, optional content fields trail - an optional
  // field between required ones invites models to treat the later
  // required field as optional too.
  parameters: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: 'Required. UUID of the memory (from memory_search).',
      },
      message: {
        type: 'string',
        minLength: 1,
        maxLength: MAX_MEMORY_CHANGELOG_MESSAGE_CHARS,
        description:
          'Required. One-line, commit-style summary of what changed and ' +
          'why. Lands in the memory changelog.',
      },
      label: { type: 'string', minLength: 1, maxLength: 80 },
      data: { type: 'string', minLength: 1, maxLength: MAX_MEMORY_DATA_CHARS },
    },
    required: ['id', 'message'],
    additionalProperties: false,
  },
} as const;
