/**
 * Schema-only export for memory_create. Impl lives in `./memory_create`.
 */
import { MAX_MEMORY_DATA_CHARS } from '../embeddings/types';
import { MAX_MEMORY_CHANGELOG_MESSAGE_CHARS } from '../memories';

export const memoryCreateSchema = {
  name: 'memory_create',
  description:
    'Save a new memory. label is a short handle (1-80 chars); data is ' +
    `the full content (max ${MAX_MEMORY_DATA_CHARS} chars - split if longer). ` +
    'Optional confidence (1.0..10.0, default 1.0) lets you mark a memory ' +
    'as already-corroborated; raise above default only with converging ' +
    'evidence in the current exchange. message is a required one-line ' +
    'summary of what you saved and why - it lands in the memory ' +
    'changelog the user reviews. Returns the created ' +
    '{id, label, data, confidence, updated_at}.',
  shortDescription: 'save a new note',
  parameters: {
    type: 'object',
    properties: {
      label: {
        type: 'string',
        minLength: 1,
        maxLength: 80,
        description: 'Short name for the memory.',
      },
      data: {
        type: 'string',
        minLength: 1,
        maxLength: MAX_MEMORY_DATA_CHARS,
        description: `Full content (max ${MAX_MEMORY_DATA_CHARS} chars).`,
      },
      confidence: {
        type: 'number',
        minimum: 1.0,
        maximum: 10.0,
        description:
          'Optional initial confidence (1.0..10.0, default 1.0). ' +
          'Raise only with converging evidence in the current exchange.',
      },
      message: {
        type: 'string',
        minLength: 1,
        maxLength: MAX_MEMORY_CHANGELOG_MESSAGE_CHARS,
        description:
          'One-line, commit-style summary of what this memory captures ' +
          'and why you saved it. Lands in the memory changelog.',
      },
    },
    required: ['label', 'data', 'message'],
    additionalProperties: false,
  },
} as const;
