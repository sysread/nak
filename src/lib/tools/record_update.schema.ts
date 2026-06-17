/**
 * Schema-only export for record_update. Impl lives in `./record_update`
 * (edge: supabase/functions/venice/tools/record_update.ts).
 */
import {
  MAX_WIKI_RECORD_CONTENT_CHARS,
  MAX_WIKI_RECORD_TAGS,
  MAX_WIKI_RECORD_TAG_CHARS,
} from '../wiki';

function formatRecordUpdateArgs(args: Record<string, unknown>): string {
  const lines: string[] = [];
  if (typeof args.id === 'string') lines.push(`**Record:** ${args.id}`);
  if (typeof args.date === 'string' && args.date) lines.push(`**Date:** ${args.date}`);
  if (Array.isArray(args.tags)) {
    lines.push(`**Tags:** ${args.tags.map((t) => String(t)).join(', ') || '(cleared)'}`);
  }
  if (typeof args.content === 'string' && args.content) {
    lines.push('', args.content);
  }
  return lines.join('\n');
}

export const recordUpdateSchema = {
  name: 'record_update',
  description:
    "Edit an existing record's date, content, or tags. Provide id (from " +
    'record_list or record_search) and any subset of date, content, tags. ' +
    'Omitted fields are left unchanged; passing tags replaces the whole ' +
    'array. Returns the updated record row.',
  shortDescription: 'edit a record',
  formatArgs: formatRecordUpdateArgs,
  parameters: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: 'Required. UUID of the record to edit.',
      },
      date: {
        type: 'string',
        description: 'Optional. New ISO 8601 date ("YYYY-MM-DD").',
      },
      content: {
        type: 'string',
        minLength: 1,
        maxLength: MAX_WIKI_RECORD_CONTENT_CHARS,
        description: `Optional. New Markdown body (max ${MAX_WIKI_RECORD_CONTENT_CHARS} chars).`,
      },
      tags: {
        type: 'array',
        items: { type: 'string', maxLength: MAX_WIKI_RECORD_TAG_CHARS },
        maxItems: MAX_WIKI_RECORD_TAGS,
        description: 'Optional. Replacement tag array (replaces all existing tags).',
      },
    },
    required: ['id'],
    additionalProperties: false,
  },
} as const;
