/**
 * Wiki-records domain slice of the Supabase data layer: dated entries
 * linked to a wiki article. The article body owns the consolidated
 * "current state"; records preserve the dated journey. This module
 * covers record CRUD + filtered listing + cross-article search, and -
 * under their own banners below - the per-record file attachments
 * (bucket upload, content-hash dedup, signed URLs) and the directed
 * record-to-record links. Records, files, and links are one
 * lifecycle: every mutation lands a best-effort wiki_changelog row
 * against the parent article through the shared append helpers here.
 *
 * RLS owner-scopes every query; the `wiki_records` table cascades on
 * article delete. updated_at is stamped by a DB trigger, not here.
 * Inserts do need to set user_id explicitly (RLS checks with_check
 * against the row, and there's no default).
 *
 * Plain async functions taking the shared SupabaseClient as their
 * first argument - no class, no state - so each can be unit-tested
 * against a stubbed client without constructing SupabaseService. The
 * SupabaseService facade (../supabase.ts) delegates its wiki-record
 * methods here one-for-one under the same names; UI code calls
 * `app.supabase.<method>()` and should not import this module
 * directly. Row types and coercers live in ./types; article-scoped
 * methods live in the sibling ./wiki.ts; the changelog message
 * wording helpers live in ../wiki, shared with the edge-side tools.
 */
import type { SupabaseClient, Session } from '@supabase/supabase-js';
import { SupabaseError } from './error';
import { base64ToBytes, ilikeLogicTreePattern } from './query-utils';
import type {
  WikiRecord,
  WikiRecordFile,
  WikiRecordLink,
  WikiRecordLinkView,
} from './types';
import {
  coerceWikiRecord,
  coerceWikiRecordFile,
  coerceWikiRecordLink,
} from './types';
// The changelog append lives in the wiki-satellite slice; every record
// / file / link mutation here lands its best-effort wiki_changelog row
// through it. One-way sibling import - wiki-sources does not import
// from this module.
import { createWikiChangelogEntry } from './wiki-sources';
// Pure helpers for the record-changelog message wording; mirrored
// edge-side in venice/tools/_record_helpers.ts. The `import type` cycle
// from ../wiki back to the facade (../supabase.ts) is erased at
// runtime, so this value import is one-way.
import {
  buildRecordChangelogMessage,
  buildRecordFileChangelogMessage,
  buildRecordLinkChangelogMessage,
} from '../wiki';
// sha256Hex lives in attachments.ts (recipe-photo dedup); reused here for
// wiki-record-file dedup so the manual UI attach and the agent-side
// record_file_attach key duplicates the same way. attachments.ts only
// `import type`s from the facade (../supabase.ts), so this value import
// has no runtime cycle.
import { sha256Hex } from '../attachments';

/**
 * Mirror of the facade's getSession: unwrap client.auth.getSession(),
 * throwing SupabaseError on failure. Private to this slice so the
 * record / file / link inserts keep their exact error behavior
 * without reaching back into SupabaseService.
 */
async function getSession(client: SupabaseClient): Promise<Session | null> {
  const { data, error } = await client.auth.getSession();
  if (error) throw new SupabaseError(error.message);
  return data.session;
}

// Wiki records ---------------------------------------------------------

/**
 * List records for one article, reverse-chronological by event date.
 * Optional date-range (inclusive) and tag filters. Tags use JSONB
 * containment (`tags @> [...]`) so a row must carry every requested
 * tag (AND semantics) - the GIN index on `tags` backs this.
 */
export async function listWikiRecords(
  client: SupabaseClient,
  articleId: string,
  filters: { fromDate?: string; toDate?: string; tags?: string[]; limit?: number } = {}
): Promise<WikiRecord[]> {
  let query = client
    .from('wiki_records')
    .select(
      // wiki_record_files(count) embeds a per-record attachment count so a
      // collapsed row can show an attachment badge without N+1 file fetches.
      'id, article_id, date, content, tags, source_conversation_id, created_at, updated_at, wiki_record_files(count)'
    )
    .eq('article_id', articleId)
    .order('date', { ascending: false })
    .order('created_at', { ascending: false });
  if (filters.fromDate) query = query.gte('date', filters.fromDate);
  if (filters.toDate) query = query.lte('date', filters.toDate);
  if (filters.tags && filters.tags.length > 0) query = query.contains('tags', filters.tags);
  if (filters.limit) query = query.limit(filters.limit);
  const { data, error } = await query;
  if (error) throw new SupabaseError(error.message);
  return (data ?? []).map((row) => coerceWikiRecord(row as Record<string, unknown>));
}

export async function getWikiRecord(
  client: SupabaseClient,
  id: string
): Promise<WikiRecord | null> {
  const { data, error } = await client
    .from('wiki_records')
    .select(
      'id, article_id, date, content, tags, source_conversation_id, created_at, updated_at'
    )
    .eq('id', id)
    .maybeSingle();
  if (error) throw new SupabaseError(error.message);
  return data ? coerceWikiRecord(data as Record<string, unknown>) : null;
}

export async function createWikiRecord(
  client: SupabaseClient,
  args: {
    articleId: string;
    date: string;
    content: string;
    tags?: string[];
    sourceConversationId?: string | null;
  }
): Promise<WikiRecord> {
  const session = await getSession(client);
  if (!session) throw new SupabaseError('Not authenticated.');
  const { data, error } = await client
    .from('wiki_records')
    .insert({
      user_id: session.user.id,
      article_id: args.articleId,
      date: args.date,
      content: args.content,
      tags: args.tags ?? [],
      source_conversation_id: args.sourceConversationId ?? null,
    })
    .select(
      'id, article_id, date, content, tags, source_conversation_id, created_at, updated_at'
    )
    .single();
  if (error) throw new SupabaseError(error.message);
  const record = coerceWikiRecord(data as Record<string, unknown>);
  await appendRecordChangelog(
    client,
    record.article_id,
    'record_create',
    record.date,
    record.content,
    // 0 before: a create has nothing before it.
    0,
    record.content.length,
  );
  return record;
}

/**
 * Patch a record's date, content, or tags. RLS owner-scopes the
 * update. The `clear_wiki_record_embedding_on_change` trigger nulls
 * the embedding + claim columns when date or content changes so the
 * worker re-embeds; `touch_wiki_record_updated_at` stamps updated_at.
 */
export async function updateWikiRecord(
  client: SupabaseClient,
  id: string,
  patch: { date?: string; content?: string; tags?: string[] }
): Promise<WikiRecord> {
  // Read the prior content length before the update so the changelog
  // can stamp chars_before. getWikiRecord verifies the record exists
  // (a non-existent id would fail at the .single() update below
  // anyway), and its content length is what the changelog needs.
  const prior = await getWikiRecord(client, id);
  const priorContentLength = prior?.content.length ?? null;

  const { data, error } = await client
    .from('wiki_records')
    .update(patch)
    .eq('id', id)
    .select(
      'id, article_id, date, content, tags, source_conversation_id, created_at, updated_at'
    )
    .single();
  if (error) throw new SupabaseError(error.message);
  const record = coerceWikiRecord(data as Record<string, unknown>);
  await appendRecordChangelog(
    client,
    record.article_id,
    'record_update',
    record.date,
    record.content,
    // Undefined (-> NULL, "unknown") when the prior read failed; a
    // tags-only edit leaves both equal, which reads as a 0 delta.
    priorContentLength ?? undefined,
    record.content.length,
  );
  return record;
}

export async function deleteWikiRecord(
  client: SupabaseClient,
  id: string
): Promise<void> {
  // Read the record first so the changelog row (logged against the
  // surviving parent article) can carry its date + content preview;
  // the record itself is gone after the delete.
  const doomed = await getWikiRecord(client, id);
  const { error } = await client.from('wiki_records').delete().eq('id', id);
  if (error) throw new SupabaseError(error.message);
  if (doomed) {
    await appendRecordChangelog(
      client,
      doomed.article_id,
      'record_delete',
      doomed.date,
      doomed.content,
      // 0 after: the record content is genuinely gone.
      doomed.content.length,
      0,
    );
  }
}

/**
 * Append a wiki_changelog row for a record write, scoped to the parent
 * article. Best-effort: a record write must not fail because its audit
 * row didn't land (the record is the source of truth; the changelog is
 * a convenience). title_at_change is the parent article's current
 * title, fetched here so the changelog UI renders the row without a
 * join even after the article is later deleted.
 */
async function appendRecordChangelog(
  client: SupabaseClient,
  articleId: string,
  kind: 'record_create' | 'record_update' | 'record_delete',
  date: string,
  content?: string,
  charsBefore?: number,
  charsAfter?: number,
): Promise<void> {
  await appendRecordChangelogMessage(
    client,
    articleId,
    kind,
    buildRecordChangelogMessage(kind, date, content),
    charsBefore,
    charsAfter,
  );
}

/**
 * Lower-level changelog append that takes a pre-built message, so the
 * file/link mutations (which reuse the record_update kind but need
 * different wording than a content edit - "Attached image ...",
 * "Linked to ...") can land a history row through the same path. Same
 * best-effort contract: a failed audit insert never fails the caller's
 * already-completed write.
 */
async function appendRecordChangelogMessage(
  client: SupabaseClient,
  articleId: string,
  kind: 'record_create' | 'record_update' | 'record_delete',
  message: string,
  charsBefore?: number,
  charsAfter?: number,
): Promise<void> {
  try {
    const { data } = await client
      .from('wiki_articles')
      .select('title')
      .eq('id', articleId)
      .maybeSingle();
    const title =
      data && typeof (data as { title?: unknown }).title === 'string'
        ? (data as { title: string }).title
        : '(record)';
    await createWikiChangelogEntry(client, {
      article_id: articleId,
      kind,
      title_at_change: title,
      message,
      chars_before: charsBefore,
      chars_after: charsAfter,
    });
  } catch {
    // Best-effort - see the doc comment. Swallow so the record write
    // the caller already completed still resolves successfully.
  }
}

/**
 * Semantic + substring search across ALL the user's records (every
 * article). Mirrors `searchWikiArticles`: vector hits first, then
 * ILIKE hits the vector path missed, deduped by id, capped at `limit`.
 * Empty query short-circuits to a recent-first listing.
 */
export async function searchWikiRecords(
  client: SupabaseClient,
  opts: {
    query: string;
    queryEmbedding: number[] | null;
    limit?: number;
  }
): Promise<WikiRecord[]> {
  const query = opts.query.trim();
  const limit = opts.limit ?? 20;
  if (query.length === 0) {
    const { data, error } = await client
      .from('wiki_records')
      .select(
        'id, article_id, date, content, tags, source_conversation_id, created_at, updated_at'
      )
      .order('date', { ascending: false })
      .limit(limit);
    if (error) throw new SupabaseError(error.message);
    return (data ?? []).map((row) => coerceWikiRecord(row as Record<string, unknown>));
  }

  const pattern = ilikeLogicTreePattern(query);
  const ilikePromise = client
    .from('wiki_records')
    .select(
      'id, article_id, date, content, tags, source_conversation_id, created_at, updated_at'
    )
    .ilike('content', pattern)
    .order('date', { ascending: false })
    .limit(limit);

  const semanticPromise = opts.queryEmbedding
    ? client.rpc('search_wiki_records_by_embedding', {
        query_embedding: opts.queryEmbedding,
        match_limit: limit,
      })
    : Promise.resolve({ data: [] as unknown[], error: null });

  const [ilikeRes, semRes] = await Promise.all([ilikePromise, semanticPromise]);
  if (ilikeRes.error) throw new SupabaseError(ilikeRes.error.message);
  const ilikeRows = (ilikeRes.data ?? []).map((row) =>
    coerceWikiRecord(row as Record<string, unknown>)
  );
  const semanticRows =
    semRes.error !== null
      ? []
      : ((semRes.data ?? []) as unknown[]).map((row) =>
          coerceWikiRecord(row as Record<string, unknown>)
        );

  const out: WikiRecord[] = [];
  const seen = new Set<string>();
  for (const r of semanticRows) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    out.push(r);
    if (out.length >= limit) return out;
  }
  for (const r of ilikeRows) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    out.push(r);
    if (out.length >= limit) return out;
  }
  return out;
}

// wiki record files -----------------------------------------------------

export async function listWikiRecordFiles(
  client: SupabaseClient,
  recordId: string
): Promise<WikiRecordFile[]> {
  const { data, error } = await client
    .from('wiki_record_files')
    .select(
      'id, record_id, position, filename, mime_type, size_bytes, storage_path, extracted_text, created_at'
    )
    .eq('record_id', recordId)
    .order('position', { ascending: true })
    .order('created_at', { ascending: true });
  if (error) throw new SupabaseError(error.message);
  return (data ?? []).map((row) => coerceWikiRecordFile(row as Record<string, unknown>));
}

/**
 * Short-lived signed URLs per file id, for image previews / download
 * links. Skips rows with no `storage_path` (reclaimed). Batched into one
 * Storage call; best-effort per the attachment twin above.
 */
export async function createWikiRecordFileSignedUrls(
  client: SupabaseClient,
  files: readonly Pick<WikiRecordFile, 'id' | 'storage_path'>[],
  expiresInSeconds = 3600
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const live = files.filter(
    (f): f is { id: string; storage_path: string } => typeof f.storage_path === 'string'
  );
  if (live.length === 0) return out;
  const { data, error } = await client.storage
    .from('wiki-record-files')
    .createSignedUrls(
      live.map((f) => f.storage_path),
      expiresInSeconds
    );
  if (error) throw new SupabaseError(error.message);
  const urlByPath = new Map<string, string>();
  for (const entry of data ?? []) {
    if (entry.signedUrl && typeof entry.path === 'string') {
      urlByPath.set(entry.path, entry.signedUrl);
    }
  }
  for (const f of live) {
    const url = urlByPath.get(f.storage_path);
    if (url) out.set(f.id, url);
  }
  return out;
}

export async function downloadWikiRecordFileBlob(
  client: SupabaseClient,
  storagePath: string
): Promise<Blob> {
  const { data, error } = await client.storage
    .from('wiki-record-files')
    .download(storagePath);
  if (error) throw new SupabaseError(error.message);
  return data;
}

/**
 * Upload bytes to the persistent wiki-record-files bucket and insert the
 * metadata row, then changelog the attach against the parent article.
 * The id is minted client-side so the upload key and the row reference
 * one path in a single pass (same as addAttachments). `articleId` +
 * `recordDate` come from the caller's already-loaded record so the
 * changelog row reads without an extra fetch.
 */
export async function uploadAndAttachWikiRecordFile(
  client: SupabaseClient,
  args: {
    recordId: string;
    articleId: string;
    recordDate: string;
    position: number;
    filename: string;
    mimeType: string | null;
    sizeBytes: number | null;
    dataBase64: string;
    extractedText?: string | null;
  }
): Promise<WikiRecordFile> {
  const session = await getSession(client);
  if (!session) throw new SupabaseError('Not authenticated.');
  const userId = session.user.id;
  const bytes = base64ToBytes(args.dataBase64);
  // base64ToBytes allocates a fresh (never shared) ArrayBuffer, so the
  // narrowing off ArrayBufferLike is safe; the cast just satisfies the DOM
  // lib's ArrayBuffer-vs-SharedArrayBuffer split.
  const contentHash = await sha256Hex(bytes.buffer as ArrayBuffer);

  // Per-record content dedup, matching the agent-side record_file_attach.
  // Re-attaching the identical file to a record is never wanted (it stacks
  // a duplicate thumbnail), so probe by (record_id, content_hash) first and
  // short-circuit to the existing row - no upload, no insert, no changelog.
  const { data: dup, error: dupErr } = await client
    .from('wiki_record_files')
    .select(
      'id, record_id, position, filename, mime_type, size_bytes, storage_path, extracted_text, created_at'
    )
    .eq('record_id', args.recordId)
    .eq('content_hash', contentHash)
    .limit(1)
    .maybeSingle();
  if (dupErr) throw new SupabaseError(dupErr.message);
  if (dup) return coerceWikiRecordFile(dup as Record<string, unknown>);

  const id = crypto.randomUUID();
  const path = `${userId}/${id}/${args.filename}`;
  const { error: upErr } = await client.storage
    .from('wiki-record-files')
    .upload(path, bytes, {
      contentType: args.mimeType ?? undefined,
      upsert: true,
    });
  if (upErr) throw new SupabaseError(upErr.message);
  const { data, error } = await client
    .from('wiki_record_files')
    .insert({
      id,
      user_id: userId,
      record_id: args.recordId,
      position: args.position,
      filename: args.filename,
      mime_type: args.mimeType,
      size_bytes: args.sizeBytes,
      storage_path: path,
      content_hash: contentHash,
      extracted_text: args.extractedText ?? null,
    })
    .select(
      'id, record_id, position, filename, mime_type, size_bytes, storage_path, extracted_text, created_at'
    )
    .single();
  if (error) throw new SupabaseError(error.message);
  const file = coerceWikiRecordFile(data as Record<string, unknown>);
  await appendRecordChangelogMessage(
    client,
    args.articleId,
    'record_update',
    buildRecordFileChangelogMessage(
      'attach',
      args.recordDate,
      file.filename,
      (file.mime_type ?? '').startsWith('image/')
    )
  );
  return file;
}

/**
 * Delete a record file: remove the bucket object (best-effort - the
 * daily wiki-record-file-gc sweep reclaims a miss) then the row, and
 * changelog the removal. Reads the file + its record up front so the
 * changelog row can name the file even though both are gone afterward.
 */
export async function deleteWikiRecordFile(
  client: SupabaseClient,
  id: string
): Promise<void> {
  const { data: fileRow } = await client
    .from('wiki_record_files')
    .select('id, record_id, filename, mime_type, storage_path')
    .eq('id', id)
    .maybeSingle();
  const file = fileRow ? coerceWikiRecordFile(fileRow as Record<string, unknown>) : null;
  const record = file ? await getWikiRecord(client, file.record_id) : null;
  if (file?.storage_path) {
    // Best-effort: a failed object remove is reclaimed by the GC sweep.
    await client.storage.from('wiki-record-files').remove([file.storage_path]);
  }
  const { error } = await client.from('wiki_record_files').delete().eq('id', id);
  if (error) throw new SupabaseError(error.message);
  if (file && record) {
    await appendRecordChangelogMessage(
      client,
      record.article_id,
      'record_update',
      buildRecordFileChangelogMessage(
        'remove',
        record.date,
        file.filename,
        (file.mime_type ?? '').startsWith('image/')
      )
    );
  }
}

// wiki record links -------------------------------------------------------

/**
 * Every link touching `recordId`, projected from that record's point of
 * view: outgoing edges (this record -> other) and incoming edges (other
 * -> this record), each carrying the OTHER record's date + content for
 * the row label. Two queries plus one batched fetch of the endpoints -
 * avoids the two-FK-to-one-table PostgREST embedding ambiguity.
 */
export async function listWikiRecordLinks(
  client: SupabaseClient,
  recordId: string
): Promise<WikiRecordLinkView[]> {
  const [outRes, inRes] = await Promise.all([
    client
      .from('wiki_record_links')
      .select('id, from_record_id, to_record_id, label, created_at')
      .eq('from_record_id', recordId),
    client
      .from('wiki_record_links')
      .select('id, from_record_id, to_record_id, label, created_at')
      .eq('to_record_id', recordId),
  ]);
  if (outRes.error) throw new SupabaseError(outRes.error.message);
  if (inRes.error) throw new SupabaseError(inRes.error.message);
  const outgoing = (outRes.data ?? []).map((r) =>
    coerceWikiRecordLink(r as Record<string, unknown>)
  );
  const incoming = (inRes.data ?? []).map((r) =>
    coerceWikiRecordLink(r as Record<string, unknown>)
  );
  // The other endpoint of each edge.
  const otherIds = new Set<string>();
  for (const l of outgoing) otherIds.add(l.to_record_id);
  for (const l of incoming) otherIds.add(l.from_record_id);
  if (otherIds.size === 0) return [];
  const { data: recRows, error: recErr } = await client
    .from('wiki_records')
    .select('id, article_id, date, content')
    .in('id', Array.from(otherIds));
  if (recErr) throw new SupabaseError(recErr.message);
  const byId = new Map<
    string,
    { id: string; article_id: string; date: string; content: string }
  >();
  for (const r of recRows ?? []) {
    const row = r as Record<string, unknown>;
    byId.set(String(row.id), {
      id: String(row.id),
      article_id: String(row.article_id ?? ''),
      date: typeof row.date === 'string' ? row.date : '',
      content: typeof row.content === 'string' ? row.content : '',
    });
  }
  const views: WikiRecordLinkView[] = [];
  for (const l of outgoing) {
    const other = byId.get(l.to_record_id);
    if (other) views.push({ id: l.id, direction: 'outgoing', label: l.label, record: other });
  }
  for (const l of incoming) {
    const other = byId.get(l.from_record_id);
    if (other) views.push({ id: l.id, direction: 'incoming', label: l.label, record: other });
  }
  return views;
}

/**
 * Create or relabel a directed edge between two records. The unique
 * (from, to) constraint makes this an upsert on the pair - re-linking
 * updates the label rather than duplicating the edge. Changelogs the
 * link against the FROM record's article, naming the target record.
 */
export async function createWikiRecordLink(
  client: SupabaseClient,
  args: {
    fromRecordId: string;
    toRecordId: string;
    label?: string | null;
  }
): Promise<WikiRecordLink> {
  const session = await getSession(client);
  if (!session) throw new SupabaseError('Not authenticated.');
  const { data, error } = await client
    .from('wiki_record_links')
    .upsert(
      {
        user_id: session.user.id,
        from_record_id: args.fromRecordId,
        to_record_id: args.toRecordId,
        label: args.label ?? null,
      },
      { onConflict: 'from_record_id,to_record_id' }
    )
    .select('id, from_record_id, to_record_id, label, created_at')
    .single();
  if (error) throw new SupabaseError(error.message);
  const link = coerceWikiRecordLink(data as Record<string, unknown>);
  const [fromRec, toRec] = await Promise.all([
    getWikiRecord(client, args.fromRecordId),
    getWikiRecord(client, args.toRecordId),
  ]);
  if (fromRec && toRec) {
    await appendRecordChangelogMessage(
      client,
      fromRec.article_id,
      'record_update',
      buildRecordLinkChangelogMessage('create', toRec.date, toRec.content, link.label)
    );
  }
  return link;
}

export async function deleteWikiRecordLink(
  client: SupabaseClient,
  args: {
    fromRecordId: string;
    toRecordId: string;
  }
): Promise<void> {
  const [fromRec, toRec] = await Promise.all([
    getWikiRecord(client, args.fromRecordId),
    getWikiRecord(client, args.toRecordId),
  ]);
  const { error } = await client
    .from('wiki_record_links')
    .delete()
    .eq('from_record_id', args.fromRecordId)
    .eq('to_record_id', args.toRecordId);
  if (error) throw new SupabaseError(error.message);
  if (fromRec && toRec) {
    await appendRecordChangelogMessage(
      client,
      fromRec.article_id,
      'record_update',
      buildRecordLinkChangelogMessage('delete', toRec.date, toRec.content, null)
    );
  }
}
