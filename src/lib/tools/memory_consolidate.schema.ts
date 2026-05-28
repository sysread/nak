/**
 * Schema-only export for memory_consolidate. Impl lives in
 * `./memory_consolidate`. Shipped only in `memoryLibrarianToolbox` -
 * NOT in the reflection or main-chat memory toolboxes. Consolidation
 * is a librarian-only privilege; the per-thread agents work at the
 * row level and never need to collapse two memories into one.
 */
import { MAX_MEMORY_DATA_CHARS } from '../memories';

export const memoryConsolidateSchema = {
  name: 'memory_consolidate',
  description:
    'Collapse two memories that turned out to encode the same fact. ' +
    'The survivor keeps the supplied label and data and adopts the ' +
    'STRONGER of the two confidence values (no bump - consolidation ' +
    'preserves existing evidence rather than manufacturing new). The ' +
    "loser's confidence is halved (soft-delete via the standard " +
    "invalidate semantic; recoverable). Any memory_conversation rows " +
    'and memory_relations edges pointing at the loser are redirected ' +
    "to the survivor, with self-loops and duplicates dropped. Use " +
    'this only when you are confident the two rows are the same ' +
    'fact - prefer memory_relate (supports/specialises/etc.) when ' +
    'they are merely adjacent. Returns ' +
    '{survivor_id, confidence}.',
  shortDescription: 'merge two duplicates into one',
  parameters: {
    type: 'object',
    properties: {
      survivor_id: {
        type: 'string',
        description: 'UUID of the memory that should remain (with the consolidated wording).',
      },
      loser_id: {
        type: 'string',
        description: 'UUID of the memory to soft-delete in favor of the survivor.',
      },
      label: {
        type: 'string',
        minLength: 1,
        maxLength: 80,
        description:
          'Consolidated short name for the survivor. May reuse the survivor or loser label, ' +
          'or be a new wording that better captures both rows.',
      },
      data: {
        type: 'string',
        minLength: 1,
        maxLength: MAX_MEMORY_DATA_CHARS,
        description:
          `Consolidated body for the survivor (max ${MAX_MEMORY_DATA_CHARS} chars). ` +
          'May combine details from both rows; should not introduce facts ' +
          'absent from both originals.',
      },
    },
    required: ['survivor_id', 'loser_id', 'label', 'data'],
    additionalProperties: false,
  },
} as const;
