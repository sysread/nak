/**
 * Schema-only export for memory_save - the create/update-merged memory
 * write (see ./upsert.ts for the routing contract). Impl lives in
 * `./memory_save` on the edge side.
 */
import { MAX_MEMORY_DATA_CHARS } from '../memories';
import { MAX_MEMORY_CHANGELOG_MESSAGE_CHARS } from '../memories';

export const memorySaveSchema = {
  name: 'memory_save',
  // Two required fields lead the description: label (the handle) and data
  // (the content). `message` is the changelog summary the user reviews, not
  // part of the memory; it is optional and defaults to a label-derived line
  // server-side when omitted. It is named last and explicitly as optional so
  // it does not read as a third place the content belongs - models were
  // observed dumping the full body into `message` and then round-tripping
  // its 200-char cap.
  description:
    'Save a memory: create a new one, or update an existing one by id. ' +
    'Omit id to create (label + data required); pass id (from ' +
    'memory_search) to update, providing only the fields that change. ' +
    'A refine tightens or holds steady - new data is never longer than ' +
    'the body it replaces. For confidence, prefer memory_reaffirm / ' +
    'memory_doubt for incremental evidence-based nudges; memory_save ' +
    'sets it only to correct a value that is outright wrong (a ' +
    'confidence-only patch is fine). Returns the saved memory row.',
  shortDescription: 'save a note',
  // Property order: id leads when present, the two create-required
  // fields next, optional fields trail.
  parameters: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description:
          'UUID of the memory to update (from memory_search). Omit to ' +
          'create a new memory.',
      },
      label: {
        type: 'string',
        minLength: 1,
        maxLength: 80,
        description: 'Short name for the memory. Required on create.',
      },
      data: {
        type: 'string',
        minLength: 1,
        maxLength: MAX_MEMORY_DATA_CHARS,
        description:
          `Full content (max ${MAX_MEMORY_DATA_CHARS} chars; split across ` +
          'multiple memories rather than truncating). Required on create.',
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
          'Optional confidence: a decimal >= 1.0 and <= 10.0 ' +
          '(e.g. 2.5; default 1.0). ' +
          'NOT a 0-1 probability - values below 1.0 are rejected. ' +
          'Raise only with converging evidence in the current exchange.',
      },
    },
    required: ['label', 'data'],
    additionalProperties: false,
  },
} as const;
