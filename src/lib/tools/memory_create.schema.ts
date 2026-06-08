/**
 * Schema-only export for memory_create. Impl lives in `./memory_create`.
 */
import { MAX_MEMORY_DATA_CHARS } from '../memories';
import { MAX_MEMORY_CHANGELOG_MESSAGE_CHARS } from '../memories';

export const memoryCreateSchema = {
  name: 'memory_create',
  // Description leads with the three REQUIRED fields named together
  // (label, data, message) before the one optional field. Models were
  // observed omitting `message` and then asserting the spec didn't
  // define it - the failure mode was the required `message` being
  // buried mid-paragraph after the optional `confidence`, and the
  // trailing return-shape list (which omits `message`, since the
  // changelog summary is not part of the memory row) reading as the
  // authoritative field set. Naming all three required inputs up front
  // and dropping the field-by-field return list removes both cues.
  description:
    'Save a new memory. Three required fields: label (short handle, ' +
    `1-80 chars), data (the full content, max ${MAX_MEMORY_DATA_CHARS} ` +
    'chars - split if longer), and message (a one-line, commit-style ' +
    'summary of what you saved and why, which lands in the memory ' +
    'changelog the user reviews). Optional confidence (1.0..10.0, ' +
    'default 1.0) marks a memory as already-corroborated; raise above ' +
    'default only with converging evidence in the current exchange. ' +
    'Returns the created memory row.',
  shortDescription: 'save a new note',
  // Property order mirrors the required-first framing in the
  // description: the three required fields lead, optional `confidence`
  // trails. An optional field sitting between required ones invites
  // models to treat the later required field as optional too.
  parameters: {
    type: 'object',
    properties: {
      label: {
        type: 'string',
        minLength: 1,
        maxLength: 80,
        description: 'Required. Short name for the memory.',
      },
      data: {
        type: 'string',
        minLength: 1,
        maxLength: MAX_MEMORY_DATA_CHARS,
        description: `Required. Full content (max ${MAX_MEMORY_DATA_CHARS} chars).`,
      },
      message: {
        type: 'string',
        minLength: 1,
        maxLength: MAX_MEMORY_CHANGELOG_MESSAGE_CHARS,
        description:
          'Required. One-line, commit-style summary of what this memory ' +
          'captures and why you saved it. Lands in the memory changelog.',
      },
      confidence: {
        type: 'number',
        minimum: 1.0,
        maximum: 10.0,
        description:
          'Optional initial confidence (1.0..10.0, default 1.0). ' +
          'Raise only with converging evidence in the current exchange.',
      },
    },
    required: ['label', 'data', 'message'],
    additionalProperties: false,
  },
} as const;
