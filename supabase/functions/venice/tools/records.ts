// records (function-side combination tool)
//
// One tool behind an `op` enum discriminator: list / get / search /
// create / update / delete over the wiki records (an article's dated
// journey). Replaces the six record_* verb registrations; the per-op
// bodies survive verbatim as internal functions - only the envelope
// changed (see the browser schema's header).
//
// DECISION (plan D1): the record FILE tools (record_file_attach /
// record_file_remove) and LINK tools (record_link_create /
// record_link_delete) stay separate verb tools.
//
// Auth: b-strict throughout. wiki_records has user_id directly, so
// every read filters .eq('user_id', userId), every write stamps it,
// and the create verifies the parent article is the caller's before
// inserting a child row (the admin client bypasses RLS).
//
// Every write appends the parent article's changelog (best-effort:
// a failed audit row must not fail the record write - the row is
// the truth). The delete reads the doomed row first so the
// changelog can carry its date + content preview; the update reads
// the prior content length for chars_before. The DB triggers stamp
// updated_at and null the embedding when date/content change.
//
// The search op returns [] when the embedder is unreachable rather
// than throwing - a blank result beats a failed tool call.
//
// Per-op required fields (article_id + date + content on create, id
// on get/update/delete, query on search) are enforced inside the
// per-op bodies below - the flat wire schema cannot express them.
// Error strings are load-bearing: substring test assertions pin
// them (tests/tool-batch.test.ts's recordDelete seam + the wiki
// agent composition tests).

import { registerTool, type ToolContext, type ToolDef } from '../performToolCall.ts';
import { padEmbeddingForStorage } from '../../_shared/backfill.ts';
import { localEmbed } from '../../_shared/local-embed.ts';
import { ArgErrors } from './_validate.ts';
import {
  MAX_WIKI_RECORD_CONTENT_CHARS,
  RECORD_COLUMNS,
  appendRecordChangelog,
  getOwnedArticleTitle,
  getOwnedRecord,
  normalizeRecordDate,
  normalizeRecordTags,
} from './_record_helpers.ts';

// Mirror of the per-op schema constants.
const RECORD_LIST_DEFAULT_LIMIT = 50;
const RECORD_LIST_MAX_LIMIT = 200;
const RECORD_SEARCH_DEFAULT_LIMIT = 10;
const RECORD_SEARCH_MAX_LIMIT = 30;

// Keep an attached doc's text useful but bounded in the tool payload.
const MAX_FILE_TEXT_CHARS = 4000;
// One-line snippet of a linked record for the model to recognise it.
const MAX_LINK_EXCERPT_CHARS = 120;

interface RecordHit {
  id: string;
  article_id: string;
  date: string;
  content: string;
  tags: unknown;
  created_at: string;
  updated_at: string;
  similarity: number;
}

interface LinkRow {
  from_record_id: string;
  to_record_id: string;
  label: string | null;
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

async function listOp(args: Record<string, unknown>, ctx: ToolContext) {
  const articleId = typeof args.article_id === 'string' ? args.article_id.trim() : '';
  if (!articleId) throw new Error('article_id is required');

  const fromDate = normalizeRecordDate(args.from_date).date;
  const toDate = normalizeRecordDate(args.to_date).date;
  const tags = Array.isArray(args.tags)
    ? args.tags.filter((t): t is string => typeof t === 'string')
    : [];
  const limit =
    typeof args.limit === 'number' && args.limit > 0
      ? Math.min(Math.floor(args.limit), RECORD_LIST_MAX_LIMIT)
      : RECORD_LIST_DEFAULT_LIMIT;

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
  // JSON.stringify is load-bearing: `tags` is jsonb, and a raw JS
  // array serializes as a Postgres array literal (`cs.{a}`), which
  // PostgREST rejects against jsonb with a 400. Same fix as the
  // browser data layer.
  if (tags.length > 0) query = query.contains('tags', JSON.stringify(tags));

  const { data, error } = await query;
  if (error) throw new Error(`listWikiRecords failed: ${error.message}`);
  const records = (data ?? []) as Array<{ id: string }>;

  // Annotate each record with how many files + links it carries, so the
  // model can tell which entries hold evidence (photos, docs) or sit in
  // a relationship without a per-record get op. Two batched queries
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
}

// ---------------------------------------------------------------------------
// get
// ---------------------------------------------------------------------------

async function getOp(args: Record<string, unknown>, ctx: ToolContext) {
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
}

// ---------------------------------------------------------------------------
// search
// ---------------------------------------------------------------------------

async function searchOp(args: Record<string, unknown>, ctx: ToolContext) {
  const query = typeof args.query === 'string' ? args.query.trim() : '';
  if (!query) throw new Error('query is required');

  const rawLimit =
    typeof args.limit === 'number' ? args.limit : RECORD_SEARCH_DEFAULT_LIMIT;
  const limit = Math.max(1, Math.min(RECORD_SEARCH_MAX_LIMIT, Math.floor(rawLimit)));

  let queryEmbedding: number[] | null = null;
  try {
    const raw = await localEmbed(query);
    if (raw.length > 0) queryEmbedding = padEmbeddingForStorage(raw);
  } catch {
    return { records: [] };
  }
  if (!queryEmbedding) return { records: [] };

  const { data, error } = await ctx.adminClient.rpc('search_wiki_records_by_embedding', {
    query_embedding: queryEmbedding,
    match_limit: limit,
    p_user_id: ctx.userId,
  });
  if (error) throw new Error(`searchWikiRecordsByEmbedding failed: ${error.message}`);

  return {
    records: ((data ?? []) as RecordHit[]).map((r) => ({
      id: r.id,
      article_id: r.article_id,
      date: r.date,
      content: r.content,
      tags: r.tags,
      similarity: r.similarity,
    })),
  };
}

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------

async function createOp(args: Record<string, unknown>, ctx: ToolContext) {
  const articleId = typeof args.article_id === 'string' ? args.article_id.trim() : '';
  const content = typeof args.content === 'string' ? args.content : '';
  const { date, error: dateErr } = normalizeRecordDate(args.date);
  const tags = normalizeRecordTags(args.tags);

  const errs = new ArgErrors();
  if (!articleId) errs.add('article_id is required');
  if (!date) errs.add(dateErr ?? 'date is required (ISO "YYYY-MM-DD")');
  if (!content) errs.add('content is required');
  else if (content.length > MAX_WIKI_RECORD_CONTENT_CHARS) {
    errs.add(
      `content exceeds ${MAX_WIKI_RECORD_CONTENT_CHARS}-char limit (got ${content.length}); split or trim`,
    );
  }
  errs.throwIfAny();

  // Verify the article belongs to the caller before inserting a child
  // row - the admin client bypasses RLS, so without this a record
  // could be parented to another user's article. The title doubles as
  // the changelog snapshot below.
  const articleTitle = await getOwnedArticleTitle(ctx.adminClient, ctx.userId, articleId);
  if (articleTitle === null) {
    throw new Error(
      `No wiki article with id "${articleId}" found for this user. Run the wiki tool (op=search or op=list) to find a valid article id.`,
    );
  }

  const { data: row, error } = await ctx.adminClient
    .from('wiki_records')
    .insert({
      user_id: ctx.userId,
      article_id: articleId,
      date,
      content,
      tags,
      source_conversation_id: ctx.threadId ?? null,
    })
    .select(RECORD_COLUMNS)
    .single();
  if (error) throw new Error(`createWikiRecord failed: ${error.message}`);

  // Best-effort changelog (scoped to the parent article). A failure
  // here must not fail the record write - the row already landed.
  try {
    await appendRecordChangelog(
      ctx.adminClient,
      ctx.userId,
      articleId,
      'record_create',
      date as string,
      content,
      // 0 before: a create has nothing before it.
      0,
      content.length,
    );
  } catch {
    // swallow - audit row is a convenience, the record is the truth.
  }
  return row;
}

// ---------------------------------------------------------------------------
// update
// ---------------------------------------------------------------------------

async function updateOp(args: Record<string, unknown>, ctx: ToolContext) {
  const id = typeof args.id === 'string' ? args.id.trim() : '';
  const errs = new ArgErrors();
  if (!id) errs.add('id is required');

  const patch: Record<string, unknown> = {};
  if ('date' in args && args.date !== undefined && args.date !== null) {
    const { date, error } = normalizeRecordDate(args.date);
    if (error) errs.add(error);
    else if (date) patch.date = date;
  }
  if ('content' in args && args.content !== undefined && args.content !== null) {
    const content = typeof args.content === 'string' ? args.content : '';
    if (!content) errs.add('content cannot be empty');
    else if (content.length > MAX_WIKI_RECORD_CONTENT_CHARS) {
      errs.add(
        `content exceeds ${MAX_WIKI_RECORD_CONTENT_CHARS}-char limit (got ${content.length})`,
      );
    } else patch.content = content;
  }
  if ('tags' in args && args.tags !== undefined && args.tags !== null) {
    patch.tags = normalizeRecordTags(args.tags);
  }
  if (Object.keys(patch).length === 0) {
    errs.add('nothing to update - pass at least one of date, content, tags');
  }
  errs.throwIfAny();

  // Read the prior content length before the update so the changelog
  // can stamp chars_before. getOwnedRecord also verifies ownership,
  // which the update's user_id filter already does - belt and braces.
  const prior = id
    ? await getOwnedRecord(ctx.adminClient, ctx.userId, id)
    : null;
  const priorContentLength = prior?.content.length ?? null;

  const { data: row, error } = await ctx.adminClient
    .from('wiki_records')
    .update(patch)
    .eq('user_id', ctx.userId)
    .eq('id', id)
    .select(RECORD_COLUMNS)
    .maybeSingle();
  if (error) throw new Error(`updateWikiRecord failed: ${error.message}`);
  if (!row) throw new Error(`No record with id "${id}" found for this user.`);

  const r = row as { article_id: string; date: string; content: string };
  try {
    await appendRecordChangelog(
      ctx.adminClient,
      ctx.userId,
      r.article_id,
      'record_update',
      r.date,
      r.content,
      // Undefined (-> NULL, "unknown") when the prior read failed; a
      // tags-only edit leaves both equal, which reads as a 0 delta.
      priorContentLength ?? undefined,
      r.content.length,
    );
  } catch {
    // swallow - best-effort audit row.
  }
  return row;
}

// ---------------------------------------------------------------------------
// delete
// ---------------------------------------------------------------------------

async function deleteOp(args: Record<string, unknown>, ctx: ToolContext) {
  const id = typeof args.id === 'string' ? args.id.trim() : '';
  if (!id) throw new Error('id is required');

  // Read the doomed row first so the changelog (logged against the
  // surviving parent article) can carry its date + content preview.
  const { data: existing } = await ctx.adminClient
    .from('wiki_records')
    .select('article_id, date, content')
    .eq('user_id', ctx.userId)
    .eq('id', id)
    .maybeSingle();

  const { data, error } = await ctx.adminClient
    .from('wiki_records')
    .delete()
    .eq('user_id', ctx.userId)
    .eq('id', id)
    .select('id');
  if (error) throw new Error(`deleteWikiRecord failed: ${error.message}`);
  const deleted = Array.isArray(data) && data.length > 0;
  if (!deleted) {
    return {
      deleted,
      reason: 'No record with that id - already deleted, never existed, or not yours.',
    };
  }

  if (deleted && existing) {
    const e = existing as { article_id: string; date: string; content: string };
    try {
      await appendRecordChangelog(
        ctx.adminClient,
        ctx.userId,
        e.article_id,
        'record_delete',
        e.date,
        e.content,
        // 0 after: the record content is genuinely gone.
        e.content.length,
        0,
      );
    } catch {
      // swallow - best-effort audit row.
    }
  }
  return { deleted };
}

// ---------------------------------------------------------------------------
// combination-tool envelope
// ---------------------------------------------------------------------------

export const records: ToolDef = {
  name: 'records',
  async execute(args: Record<string, unknown>, ctx: ToolContext) {
    const op = typeof args.op === 'string' ? args.op.trim() : '';
    if (!op) {
      throw new Error('op is required (list | get | search | create | update | delete)');
    }
    switch (op) {
      case 'list':
        return listOp(args, ctx);
      case 'get':
        return getOp(args, ctx);
      case 'search':
        return searchOp(args, ctx);
      case 'create':
        return createOp(args, ctx);
      case 'update':
        return updateOp(args, ctx);
      case 'delete':
        return deleteOp(args, ctx);
      default:
        throw new Error(
          `unknown op "${op}" - expected list, get, search, create, update, or delete`,
        );
    }
  },
};

registerTool(records);
