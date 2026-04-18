/**
 * Persist a new memory for the current user. Returns the created row so
 * the LLM can reference its id in a follow-up update/delete without a
 * second search.
 */
import type { ToolDef } from './types';

export const memoryCreate: ToolDef = {
  name: 'memory_create',
  description:
    "Save a new memory for the user. `label` is a short handle " +
    "(1-80 chars); `data` is the full content. Returns the created " +
    '{id, label, data, updated_at}.',
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
        description: 'Full content of the memory.',
      },
    },
    required: ['label', 'data'],
    additionalProperties: false,
  },
  async execute(args, ctx) {
    const label = typeof args.label === 'string' ? args.label.trim() : '';
    const data = typeof args.data === 'string' ? args.data : '';
    if (!label) throw new Error('label is required');
    if (!data) throw new Error('data is required');
    return ctx.supabase.createMemory(label, data);
  },
};
