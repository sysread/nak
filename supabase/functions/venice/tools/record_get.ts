// record_get (function-side port)
//
// Fetch one record's full body by id, plus its attached files and its
// cross-links to other records. Returns {found: false} for unknown or
// non-owned ids (the user_id filter drops other users' rows). Wire schema
// lives in src/lib/tools/record_get.schema.ts.
//
// Files surface as metadata + extracted_text (so the model can READ an
// attached document); image bytes are not inlined here (record_get is a
// text fetch). Links surface from this record's point of view (outgoing /
// incoming) with the other endpoint's dated snippet, so the model can
// follow "based on attempt #2" without a second lookup.

import { registerTool, type ToolContext, type ToolDef } from '../performToolCall.ts';
import { RECORD_COLUMNS } from './_record_helpers.ts';

// Keep an attached doc's text useful but bounded in the tool payload.
const MAX_FILE_TEXT_CHARS = 4000;
// One-line snippet of a linked record for the model to recognise it.
const MAX_LINK_EXCERPT_CHARS = 120;

interface LinkRow {
  from_record_id: string;
  to_record_id: string;
  label: string | null;
}

export const recordGet: ToolDef = {
  name: 'record_get',
  async execute(args: Record<string, unknown>, ctx: ToolContext) {
    const id = typeof args.id === 'string' ? args.id.trim() : '';
    if (!id) throw new Error('id is required');

    // RLS OFF: filter by userId, then id, so miss vs not-owned are
    // indistinguishable to a probing caller.
    const { data, error } = await ctx.adminClient
      .from('wiki_records')
      .select(RECORD_COLUMNS)
      .eq('user_id', ctx.userId)
      .eq('id', id)
      .maybeSingle();
    if (error) throw new Error(`getWikiRecord failed: ${error.message}`);
    if (!data) return { found: false };

    // Attached files (metadata + bounded extracted text for docs).
    const { data: fileRows } = await ctx.adminClient
      .from('wiki_record_files')
      .select('id, filename, mime_type, size_bytes, extracted_text, position')
      .eq('user_id', ctx.userId)
      .eq('record_id', id)
      .order('position', { ascending: true });
    const files = (fileRows ?? []).map((f) => {
      const row = f as {
        id: string;
        filename: string;
        mime_type: string | null;
        size_bytes: number | null;
        extracted_text: string | null;
      };
      const isImage = (row.mime_type ?? '').startsWith('image/');
      return {
        // id lets record_file_remove target this file.
        id: row.id,
        filename: row.filename,
        mime_type: row.mime_type,
        size_bytes: row.size_bytes,
        is_image: isImage,
        // Only docs carry text; cap so a long OCR dump can't dominate.
        extracted_text:
          !isImage && typeof row.extracted_text === 'string'
            ? row.extracted_text.slice(0, MAX_FILE_TEXT_CHARS)
            : undefined,
      };
    });

    // Cross-links, projected from this record's point of view.
    const [outRes, inRes] = await Promise.all([
      ctx.adminClient
        .from('wiki_record_links')
        .select('from_record_id, to_record_id, label')
        .eq('user_id', ctx.userId)
        .eq('from_record_id', id),
      ctx.adminClient
        .from('wiki_record_links')
        .select('from_record_id, to_record_id, label')
        .eq('user_id', ctx.userId)
        .eq('to_record_id', id),
    ]);
    const outgoing = (outRes.data ?? []) as LinkRow[];
    const incoming = (inRes.data ?? []) as LinkRow[];
    const otherIds = new Set<string>();
    for (const l of outgoing) otherIds.add(l.to_record_id);
    for (const l of incoming) otherIds.add(l.from_record_id);
    const excerptById = new Map<string, { date: string; excerpt: string }>();
    if (otherIds.size > 0) {
      const { data: recRows } = await ctx.adminClient
        .from('wiki_records')
        .select('id, date, content')
        .eq('user_id', ctx.userId)
        .in('id', Array.from(otherIds));
      for (const r of recRows ?? []) {
        const row = r as { id: string; date: string; content: string };
        excerptById.set(String(row.id), {
          date: row.date,
          excerpt: (row.content ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_LINK_EXCERPT_CHARS),
        });
      }
    }
    const links = [
      ...outgoing.map((l) => ({ dir: 'outgoing' as const, other: l.to_record_id, label: l.label })),
      ...incoming.map((l) => ({ dir: 'incoming' as const, other: l.from_record_id, label: l.label })),
    ]
      .map((l) => {
        const meta = excerptById.get(l.other);
        if (!meta) return null;
        return {
          direction: l.dir,
          label: l.label ?? null,
          record_id: l.other,
          date: meta.date,
          excerpt: meta.excerpt,
        };
      })
      .filter((l): l is NonNullable<typeof l> => l !== null);

    return { found: true, record: data, files, links };
  },
};

registerTool(recordGet);
