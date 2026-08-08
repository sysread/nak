/**
 * Schema-only export for memory_create. Impl lives in `./memory_create`.
 */
import { MAX_MEMORY_DATA_CHARS } from '../memories';
import { MAX_MEMORY_CHANGELOG_MESSAGE_CHARS } from '../memories';

export const memoryCreateSchema = {
  name: 'memory_create',
  // Two required fields lead the description: label (the handle) and data
  // (the content). `message` is the changelog summary the user reviews, not
  // part of the memory; it is optional and defaults to a label-derived line
  // server-side when omitted. It is named last and explicitly as optional so
  // it does not read as a third place the content belongs - models were
  // observed dumping the full body into `message` and then round-tripping
  // its 200-char cap.
  description:
    'Save a new memory. Two required fields: label (short handle, ' +
    `1-80 chars) and data (the full content, max ${MAX_MEMORY_DATA_CHARS} ` +
    'chars - split if longer). Optional message is a one-line, commit-style ' +
    'summary of what you saved and why, which lands in the memory changelog ' +
    'the user reviews; omit it to auto-derive one from the label. Optional ' +
    'confidence is a decimal on a 1-10 scale (>= 1.0 and <= 10.0, e.g. ' +
    '2.5; default 1.0), NOT a 0-1 probability - values below 1.0 are ' +
    'rejected. It marks a memory as already-' +
    'corroborated; raise above default only with converging evidence in the ' +
    'current exchange. Returns the created memory row.',
  shortDescription: 'save a new note',
  // Property order: the two required fields lead, optional fields trail.
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
          'Optional. One-line, commit-style summary of what this memory ' +
          'captures and why you saved it; lands in the memory changelog. ' +
          'Omit to auto-derive from the label. Not a place for the content - ' +
          'that goes in data.',
      },
      // Models were observed reading this as a 0-1 probability and
      // round-tripping the below-minimum rejection repeatedly; the
      // description names the scale and the wrong reading explicitly.
      confidence: {
        type: 'number',
        minimum: 1.0,
        maximum: 10.0,
        description:
          'Optional initial confidence: a decimal >= 1.0 and <= 10.0 ' +
          '(e.g. 2.5; default 1.0). ' +
          'NOT a 0-1 probability - values below 1.0 are rejected. ' +
          'Raise only with converging evidence in the current exchange.',
      },
    },
    required: ['label', 'data'],
    additionalProperties: false,
  },
} as const;
