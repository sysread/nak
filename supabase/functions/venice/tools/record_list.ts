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
    const records = (data ?? []) as Array<{ id: string }>;

    // Annotate each record with how many files + links it carries, so the
    // model can tell which entries hold evidence (photos, docs) or sit in
    // a relationship without a per-record record_get. Two batched queries
    // over the listed ids, tallied here - not N+1.
    const ids = records.map((r) => r.id);
    const fileCount = new Map<string, number>();
    const linkCount = new Map<string, number>();
    if (ids.length > 0) {
      const [fileRows, fromRows, toRows] = await Promise.all([
        ctx.adminClient
          .from('wiki_record_files')
          .select('record_id')
          .eq('user_id', ctx.userId)
          .in('record_id', ids),
        ctx.adminClient
          .from('wiki_record_links')
          .select('from_record_id')
          .eq('user_id', ctx.userId)
          .in('from_record_id', ids),
        ctx.adminClient
          .from('wiki_record_links')
          .select('to_record_id')
          .eq('user_id', ctx.userId)
          .in('to_record_id', ids),
      ]);
      for (const r of fileRows.data ?? []) {
        const key = String((r as { record_id: string }).record_id);
        fileCount.set(key, (fileCount.get(key) ?? 0) + 1);
      }
      for (const r of fromRows.data ?? []) {
        const key = String((r as { from_record_id: string }).from_record_id);
        linkCount.set(key, (linkCount.get(key) ?? 0) + 1);
      }
      for (const r of toRows.data ?? []) {
        const key = String((r as { to_record_id: string }).to_record_id);
        linkCount.set(key, (linkCount.get(key) ?? 0) + 1);
      }
    }
    const annotated = records.map((r) => ({
      ...r,
      file_count: fileCount.get(r.id) ?? 0,
      link_count: linkCount.get(r.id) ?? 0,
    }));
    return { records: annotated };
  },
};

registerTool(recordList);
