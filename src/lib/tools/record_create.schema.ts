/**
 * Schema-only export for record_create. Impl lives in `./record_create`
 * (edge: supabase/functions/venice/tools/record_create.ts).
 *
 * Carries a `formatArgs` override so the tool-call detail panel renders
 * the date + tags as a header and the Markdown content as a section,
 * rather than burying the body in a generic field bullet.
 */
import {
  MAX_WIKI_RECORD_CONTENT_CHARS,
  MAX_WIKI_RECORD_TAGS,
  MAX_WIKI_RECORD_TAG_CHARS,
} from '../wiki';

function formatRecordWriteArgs(args: Record<string, unknown>): string {
  const lines: string[] = [];
  if (typeof args.date === 'string' && args.date) lines.push(`**Date:** ${args.date}`);
  if (Array.isArray(args.tags) && args.tags.length > 0) {
    lines.push(`**Tags:** ${args.tags.map((t) => String(t)).join(', ')}`);
  }
  if (typeof args.content === 'string' && args.content) {
    lines.push('', args.content);
  }
  return lines.join('\n');
}

export const recordCreateSchema = {
  name: 'record_create',
  description:
    'Create a dated record linked to a wiki article. Records document ' +
    'discrete events, experiments, observations, or milestones for a ' +
    'topic (the journey), distinct from the article body (the current ' +
    'state). Provide article_id (from wiki_search / wiki_list), date ' +
    '(ISO 8601, e.g. "2026-06-17", the day the event occurred), content ' +
    `(Markdown, max ${MAX_WIKI_RECORD_CONTENT_CHARS} chars), and optional ` +
    'tags for filtering. Returns the created record row.',
  shortDescription: 'log a dated record on an article',
  formatArgs: formatRecordWriteArgs,
  parameters: {
    type: 'object',
    properties: {
      article_id: {
        type: 'string',
        description:
          'Required. UUID of the wiki article this record belongs to ' +
          '(from wiki_search or wiki_list).',
      },
      date: {
        type: 'string',
        description:
          'Required. ISO 8601 calendar date the event occurred ' +
          '("YYYY-MM-DD"). Use the date from the conversation, not today, ' +
          'when the event is in the past.',
      },
      content: {
        type: 'string',
        minLength: 1,
        maxLength: MAX_WIKI_RECORD_CONTENT_CHARS,
        description: `Required. Markdown body (max ${MAX_WIKI_RECORD_CONTENT_CHARS} chars).`,
      },
      tags: {
        type: 'array',
        items: { type: 'string', maxLength: MAX_WIKI_RECORD_TAG_CHARS },
        maxItems: MAX_WIKI_RECORD_TAGS,
        description: 'Optional. Keyword tags for filtering this record.',
      },
    },
    required: ['article_id', 'date', 'content'],
    additionalProperties: false,
  },
} as const;
