/**
 * Schema-only export for record_list. Impl lives in `./record_list`
 * (edge: supabase/functions/venice/tools/record_list.ts).
 */
export const recordListSchema = {
  name: 'record_list',
  description:
    'List records for a wiki article, most recent event first. Provide ' +
    'article_id (from wiki_search / wiki_list) and optional filters: ' +
    'from_date / to_date (inclusive ISO 8601 bounds) and tags (a record ' +
    'must carry every listed tag). Returns {records: [{id, date, content, ' +
    'tags, created_at}]}. Use this to survey a topic\'s journey before ' +
    'writing or updating its article body.',
  shortDescription: 'list an article\'s records',
  parameters: {
    type: 'object',
    properties: {
      article_id: {
        type: 'string',
        description: 'Required. UUID of the wiki article.',
      },
      from_date: {
        type: 'string',
        description: 'Optional. Inclusive lower bound on the event date ("YYYY-MM-DD").',
      },
      to_date: {
        type: 'string',
        description: 'Optional. Inclusive upper bound on the event date ("YYYY-MM-DD").',
      },
      tags: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional. Only records carrying every one of these tags.',
      },
      limit: {
        type: 'number',
        description: 'Optional. Max records to return (default 50).',
      },
    },
    required: ['article_id'],
    additionalProperties: false,
  },
} as const;
