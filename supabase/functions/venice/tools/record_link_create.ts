// record_link_create (function-side port)
//
// Create or relabel a directed edge between two of the caller's records
// ("attempt #3 based on attempt #2"). Wire schema lives in
// src/lib/tools/record_link_create.schema.ts. Auth: b-strict - BOTH
// records are ownership-checked before the upsert, and user_id is stamped,
// so a service-role write can't link across owners.
//
// The unique (from, to) constraint makes this an upsert on the pair:
// re-linking the same ordered pair updates the label rather than adding a
// parallel edge (the schema is a simple directed graph).

import { registerTool, type ToolContext, type ToolDef } from '../performToolCall.ts';
import {
  MAX_RECORD_LINK_LABEL_CHARS,
  appendRecordChangelogMessage,
  buildRecordLinkChangelogMessage,
  getOwnedRecord,
} from './_record_helpers.ts';

export const recordLinkCreate: ToolDef = {
  name: 'record_link_create',
  async execute(args: Record<string, unknown>, ctx: ToolContext) {
    const fromId = typeof args.from_record_id === 'string' ? args.from_record_id.trim() : '';
    const toId = typeof args.to_record_id === 'string' ? args.to_record_id.trim() : '';
    const rawLabel = typeof args.label === 'string' ? args.label.trim() : '';
    if (!fromId) throw new Error('from_record_id is required');
    if (!toId) throw new Error('to_record_id is required');
    if (fromId === toId) throw new Error('a record cannot be linked to itself');
    const label = rawLabel ? rawLabel.slice(0, MAX_RECORD_LINK_LABEL_CHARS) : null;

    const [fromRec, toRec] = await Promise.all([
      getOwnedRecord(ctx.adminClient, ctx.userId, fromId),
      getOwnedRecord(ctx.adminClient, ctx.userId, toId),
    ]);
    if (!fromRec) {
      throw new Error(
        `No record with id "${fromId}" found for this user. Use record_list or record_search to find a valid record id.`,
      );
    }
    if (!toRec) {
      throw new Error(
        `No record with id "${toId}" found for this user. Use record_list or record_search to find a valid record id.`,
      );
    }

    const { data: row, error } = await ctx.adminClient
      .from('wiki_record_links')
      .upsert(
        {
          user_id: ctx.userId,
          from_record_id: fromId,
          to_record_id: toId,
          label,
        },
        { onConflict: 'from_record_id,to_record_id' },
      )
      .select('id, from_record_id, to_record_id, label, created_at')
      .single();
    if (error) throw new Error(`record_link_create failed: ${error.message}`);

    try {
      await appendRecordChangelogMessage(
        ctx.adminClient,
        ctx.userId,
        fromRec.article_id,
        'record_update',
        buildRecordLinkChangelogMessage('create', toRec.date, toRec.content, label),
      );
    } catch {
      // swallow - best-effort audit row.
    }
    return { linked: true, link: row };
  },
};

registerTool(recordLinkCreate);
