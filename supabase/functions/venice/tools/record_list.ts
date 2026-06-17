// record_list (function-side port)
//
// List one article's records, most recent event first, with optional
// date-range + tag filters. Wire schema lives in
// src/lib/tools/record_list.schema.ts. RLS OFF: filter by userId.

import { registerTool, type ToolContext, type ToolDef } from '../performToolCall.ts';
import { RECORD_COLUMNS, normalizeRecordDate } from './_record_helpers.ts';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export const recordList: ToolDef = {
  name: 'record_list',
  async execute(args: Record<string, unknown>, ctx: ToolContext) {
    const articleId = typeof args.article_id === 'string' ? args.article_id.trim() : '';
    if (!articleId) throw new Error('article_id is required');

    const fromDate = normalizeRecordDate(args.from_date).date;
    const toDate = normalizeRecordDate(args.to_date).date;
    const tags = Array.isArray(args.tags)
      ? args.tags.filter((t): t is string => typeof t === 'string')
      : [];
    const limit =
      typeof args.limit === 'number' && args.limit > 0
        ? Math.min(Math.floor(args.limit), MAX_LIMIT)
        : DEFAULT_LIMIT;

    let query = ctx.adminClient
      .from('wiki_records')
      .select(RECORD_COLUMNS)
      .eq('user_id', ctx.userId)
      .eq('article_id', articleId)
      .order('date', { ascending: false })
      .order('created_at', { ascending: false })
      .limit(limit);
    if (fromDate) query = query.gte('date', fromDate);
    if (toDate) query = query.lte('date', toDate);
    if (tags.length > 0) query = query.contains('tags', tags);

    const { data, error } = await query;
    if (error) throw new Error(`listWikiRecords failed: ${error.message}`);
    return { records: data ?? [] };
  },
};

registerTool(recordList);
