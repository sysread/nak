/**
 * Messages & attachments domain slice of the Supabase data layer:
 * the per-thread message read (with attachment hydration and
 * interrupted-exchange recovery), the message writes (insert, the
 * ask_user tool-row content rewrite, the second-thoughts acted flag),
 * and the attachment storage surface (bulk upload + insert, signed
 * URLs, the Artifacts tab's paging and delete, the thread-scoped
 * image lookup and summary reads the chat-loop tools use).
 *
 * Attachment bytes never ride the `message_attachments` rows: they
 * live in the private `attachments` bucket keyed by `storage_path`,
 * and readers mint short-lived signed URLs on demand. The slice
 * projects metadata only, so a thread full of images doesn't ship
 * megabytes of base64 on every open.
 *
 * Plain async functions taking the shared SupabaseClient as their
 * first argument - no class, no state - so each can be unit-tested
 * against a stubbed client without constructing SupabaseService. The
 * SupabaseService facade (../supabase.ts) delegates its message and
 * attachment methods here one-for-one under the same names; UI code
 * calls `app.supabase.<method>()` and should not import this module
 * directly. Row types and coercers live in ./types; the base64
 * decoder shared with the recipe-photo path lives in ./query-utils.
 */
import type { SupabaseClient, Session } from '@supabase/supabase-js';
import { synthesizeRecoveryMessages } from '../conversation-recovery';
import type { OpenAIToolCall } from '../tools/types';
import type { Citation, TokenUsage } from '../venice';
import { SupabaseError } from './error';
import { deleteAttachmentPages } from './attachment-pages';
import { base64ToBytes } from './query-utils';
import type {
  Attachment,
  NewAttachment,
  ArtifactListRow,
  ThreadAttachmentSummary,
  Message,
} from './types';
import { coerceAttachmentRow } from './types';

/**
 * Mirror of the facade's getSession: unwrap client.auth.getSession(),
 * throwing SupabaseError on failure. Private to this slice so
 * addAttachments keeps its exact error behavior without reaching back
 * into SupabaseService.
 */
async function getSession(client: SupabaseClient): Promise<Session | null> {
  const { data, error } = await client.auth.getSession();
  if (error) throw new SupabaseError(error.message);
  return data.session;
}

export async function listMessages(
  client: SupabaseClient,
  threadId: string
): Promise<Message[]> {
  const { data, error } = await client
    .from('messages')
    .select('*')
    .eq('thread_id', threadId)
    .order('created_at', { ascending: true });
  if (error) throw new SupabaseError(error.message);
  const messages = (data ?? []) as Message[];
  // Hydrate attachments in a second query keyed by message id. Keeps
  // the base SELECT cheap (no large base64 payloads on the wire for
  // rows without attachments, which is the common case) and lets
  // the realtime subscribe path reuse the same hydration helper
  // later.
  // User rows carry uploads; assistant rows carry generate_image
  // output (attached at end of turn by the chat-loop). Both hydrate
  // through the same query; tool / system rows never carry
  // attachments so they're left out to keep the IN-list small.
  const attachableIds = messages
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => m.id);
  if (attachableIds.length > 0) {
    const attachmentsByMessageId = await listAttachmentsByMessageIds(client, attachableIds);
    for (const m of messages) {
      if (m.role === 'user' || m.role === 'assistant') {
        m.attachments = attachmentsByMessageId.get(m.id) ?? [];
      }
    }
  }
  // Repair an interrupted-exchange tail in memory so every reader -
  // chat UI, summary worker, reflection worker, recall agents,
  // samskara worker, wiki worker - sees a wire-format-valid
  // sequence. The synthesized rows ride through the wire projection
  // like normal rows; the chat-loop's send path persists them ahead
  // of the next user turn so the DB heals on revisit. See
  // lib/conversation-recovery.ts for the cases handled.
  return synthesizeRecoveryMessages(messages);
}

/**
 * Fetch every attachment belonging to the given user-message ids, in
 * one round trip. Returns a map keyed by `message_id` so the caller
 * can hang the array straight onto each message. Ordered by
 * `position` within each bucket so the message renderer doesn't have
 * to re-sort.
 *
 * Used by `listMessages` for the initial load and by the realtime
 * subscription path when a user row arrives with attachments.
 */
export async function listAttachmentsByMessageIds(
  client: SupabaseClient,
  messageIds: string[]
): Promise<Map<string, Attachment[]>> {
  const result = new Map<string, Attachment[]>();
  if (messageIds.length === 0) return result;
  // Bytes are NOT projected - they live in the `attachments` bucket
  // (pointed at by storage_path) and are fetched on demand via a
  // signed URL. Thread load carries metadata only, so a thread full of
  // images no longer ships megabytes of base64 on every open.
  const { data, error } = await client
    .from('message_attachments')
    .select(
      'id, message_id, position, filename, mime_type, size_bytes, storage_path, extracted_text, expired_at, created_at'
    )
    .in('message_id', messageIds)
    .order('position', { ascending: true });
  if (error) throw new SupabaseError(error.message);
  for (const row of (data ?? []) as Attachment[]) {
    const existing = result.get(row.message_id) ?? [];
    existing.push({
      id: row.id,
      message_id: row.message_id,
      position: row.position,
      filename: row.filename,
      mime_type: row.mime_type,
      size_bytes: row.size_bytes,
      storage_path: typeof row.storage_path === 'string' ? row.storage_path : null,
      extracted_text: row.extracted_text,
      expired_at: row.expired_at,
      created_at: row.created_at,
    });
    result.set(row.message_id, existing);
  }
  return result;
}

/**
 * Bulk-insert attachments for a just-written message. For each row we
 * mint the attachment id client-side, upload its bytes to the
 * `attachments` bucket at `<user_id>/<id>/<filename>`, then insert the
 * row carrying `storage_path` (never the bytes). Client-minted ids let
 * the upload and the insert reference the same path in one pass.
 *
 * Returns the hydrated rows (with `storage_path` set, bytes left in the
 * bucket) so the caller can append them to the in-memory message; the
 * UI fetches a signed URL when it needs to render them.
 */
export async function addAttachments(
  client: SupabaseClient,
  messageId: string,
  rows: NewAttachment[]
): Promise<Attachment[]> {
  if (rows.length === 0) return [];
  const session = await getSession(client);
  if (!session) throw new SupabaseError('Not authenticated.');
  const userId = session.user.id;

  const prepared = await Promise.all(
    rows.map(async (r) => {
      const id = crypto.randomUUID();
      const path = `${userId}/${id}/${r.filename}`;
      const { error: upErr } = await client.storage
        .from('attachments')
        .upload(path, base64ToBytes(r.data_base64), {
          contentType: r.mime_type,
          upsert: true,
        });
      if (upErr) throw new SupabaseError(upErr.message);
      return {
        id,
        message_id: messageId,
        position: r.position,
        filename: r.filename,
        mime_type: r.mime_type,
        size_bytes: r.size_bytes,
        storage_path: path,
        extracted_text: r.extracted_text,
        page_count: r.page_count,
      };
    })
  );

  const { data, error } = await client
    .from('message_attachments')
    .insert(prepared)
    .select(
      'id, message_id, position, filename, mime_type, size_bytes, storage_path, extracted_text, expired_at, created_at'
    );
  if (error) throw new SupabaseError(error.message);
  return ((data ?? []) as Attachment[]).map((row) => ({
    id: row.id,
    message_id: row.message_id,
    position: row.position,
    filename: row.filename,
    mime_type: row.mime_type,
    size_bytes: row.size_bytes,
    storage_path: typeof row.storage_path === 'string' ? row.storage_path : null,
    extracted_text: row.extracted_text,
    expired_at: row.expired_at,
    created_at: row.created_at,
  }));
}

/**
 * A short-lived signed URL per attachment id, for rendering image
 * previews / download links and for handing image bytes to Venice (its
 * vision input fetches public URLs). Skips expired attachments
 * (storage_path null). Batched into one Storage call. Best-effort: an
 * attachment whose signed URL can't be minted is simply omitted from
 * the map rather than failing the whole batch.
 */
export async function createAttachmentSignedUrls(
  client: SupabaseClient,
  attachments: readonly Pick<Attachment, 'id' | 'storage_path'>[],
  expiresInSeconds = 3600
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const live = attachments.filter(
    (a): a is { id: string; storage_path: string } => typeof a.storage_path === 'string'
  );
  if (live.length === 0) return out;
  const { data, error } = await client.storage
    .from('attachments')
    .createSignedUrls(
      live.map((a) => a.storage_path),
      expiresInSeconds
    );
  if (error) throw new SupabaseError(error.message);
  const urlByPath = new Map<string, string>();
  for (const entry of data ?? []) {
    if (entry.signedUrl && typeof entry.path === 'string') {
      urlByPath.set(entry.path, entry.signedUrl);
    }
  }
  for (const a of live) {
    const url = urlByPath.get(a.storage_path);
    if (url) out.set(a.id, url);
  }
  return out;
}

/**
 * Page through the signed-in user's LIVE attachments across every
 * conversation, for the Artifacts management tab. Joins each attachment
 * to its owning thread's title so the list can show (and link to) the
 * conversation a file lives in. Filterable by filename substring and by
 * kind (image vs other), orderable newest- or largest-first.
 *
 * Only live rows (non-null `storage_path`) are returned - an
 * already-deleted attachment has no object to manage. RLS scopes the
 * whole query to the caller via the attachment -> message -> thread
 * chain, so the embedded `messages`/`threads` resolve only the user's
 * own rows.
 *
 * Fetches one extra row past `pageSize` to compute `hasMore` without a
 * separate count query.
 */
export async function listArtifacts(
  client: SupabaseClient,
  opts: {
    offset: number;
    pageSize: number;
    query?: string;
    kind?: 'all' | 'image' | 'file';
    sort?: 'newest' | 'largest';
  }
): Promise<{ rows: ArtifactListRow[]; hasMore: boolean }> {
  const { offset, pageSize, query, kind = 'all', sort = 'newest' } = opts;
  let q = client
    .from('message_attachments')
    // The `threads` embed is hinted with the FK constraint name
    // (`messages_thread_id_fkey`) because `messages` and `threads` are
    // joined by more than one relationship: `messages.thread_id ->
    // threads.id` (the one we want) plus six reverse cursor columns on
    // `threads` (last_reflected_msg_id, last_evaluated_msg_id,
    // last_summarised_msg_id, last_topics_msg_id, last_wiki_processed_msg_id,
    // last_wiki_record_processed_msg_id) that each reference messages.id.
    // Without the hint PostgREST can't choose and fails the whole query
    // with "more than one relationship was found for 'messages' and
    // 'threads'".
    .select(
      'id, filename, mime_type, size_bytes, storage_path, created_at, messages!inner(thread_id, threads!messages_thread_id_fkey!inner(title))'
    )
    .not('storage_path', 'is', null);
  const trimmed = (query ?? '').trim();
  // ilike wildcards in the user's text are escaped so a literal % or _
  // in a filename doesn't widen the match.
  if (trimmed.length > 0) {
    const escaped = trimmed.replace(/[%_\\]/g, '\\$&');
    q = q.ilike('filename', `%${escaped}%`);
  }
  if (kind === 'image') q = q.ilike('mime_type', 'image/%');
  else if (kind === 'file') q = q.not('mime_type', 'ilike', 'image/%');
  q =
    sort === 'largest'
      ? q.order('size_bytes', { ascending: false })
      : q.order('created_at', { ascending: false });
  q = q.range(offset, offset + pageSize);
  const { data, error } = await q;
  if (error) throw new SupabaseError(error.message);
  const raw = (data ?? []) as Array<{
    id: string;
    filename: string;
    mime_type: string;
    size_bytes: number;
    storage_path: string;
    created_at: string;
    // PostgREST returns a to-one embed as an object; older typings can
    // surface it as a single-element array, so accept either shape.
    messages?:
      | { thread_id: string; threads?: { title?: string } | { title?: string }[] | null }
      | { thread_id: string; threads?: { title?: string } | { title?: string }[] | null }[]
      | null;
  }>;
  const hasMore = raw.length > pageSize;
  const rows: ArtifactListRow[] = raw.slice(0, pageSize).map((r) => {
    const msg = Array.isArray(r.messages) ? r.messages[0] : r.messages;
    const thr = Array.isArray(msg?.threads) ? msg?.threads[0] : msg?.threads;
    return {
      id: r.id,
      filename: r.filename,
      mime_type: r.mime_type,
      size_bytes: r.size_bytes,
      storage_path: r.storage_path,
      created_at: r.created_at,
      thread_id: msg?.thread_id ?? '',
      thread_title: thr?.title ?? 'Untitled conversation',
    };
  });
  return { rows, hasMore };
}

/**
 * Delete one attachment from the Artifacts tab: mark the row expired
 * (null `storage_path` + stamp `expired_at`) so the conversation
 * re-renders the file as the greyed placeholder, then best-effort remove
 * the bucket object. The row is UPDATED, not deleted, so the message it
 * belongs to still reads sensibly (filename + extracted_text survive).
 *
 * Row-first ordering (the inverse of deleteMessages): nulling the path
 * first stops the row from referencing the object, so a Storage hiccup
 * can't strand a live row pointing at a deleted object - the daily
 * `attachment-gc` sweep reclaims the object if the remove below misses.
 * The "attachments are self-updatable via thread" RLS policy scopes the
 * update to the caller's own rows.
 */
export async function deleteAttachment(
  client: SupabaseClient,
  attachmentId: string
): Promise<void> {
  const { data, error: selErr } = await client
    .from('message_attachments')
    .select('storage_path')
    .eq('id', attachmentId)
    .maybeSingle();
  if (selErr) throw new SupabaseError(selErr.message);
  const path = (data as { storage_path: string | null } | null)?.storage_path ?? null;

  const { error: updErr } = await client
    .from('message_attachments')
    .update({ storage_path: null, expired_at: new Date().toISOString() })
    .eq('id', attachmentId);
  if (updErr) throw new SupabaseError(updErr.message);

  // Rendered PDF pages have to be dropped explicitly. This path expires the
  // row rather than deleting it, so the `on delete cascade` that would
  // otherwise clear message_attachment_pages never fires - without this the
  // page renders would survive the delete and analyze_pdf_page would keep
  // serving a document the user asked to remove.
  await deleteAttachmentPages(client, attachmentId);

  if (path) {
    // Swallowed on purpose: attachment-gc reclaims any object the remove
    // misses, and the row is already marked expired regardless.
    await client.storage.from('attachments').remove([path]);
  }
}

/**
 * Find the most recent image attachment in this thread whose filename
 * matches exactly. Returns the row regardless of expiry state - the
 * caller distinguishes "not found" (null return) from "expired"
 * (`data_base64 === null` on the returned row) and produces the right
 * diagnostic for the model.
 *
 * Why thread-scoped instead of message-scoped: the analyze_image tool
 * needs to reach images attached on prior turns of the same conversation,
 * not just the user message that opened the current turn. The earlier
 * design passed only the current message's attachments into ToolContext,
 * which left the model unable to re-analyze an image once the user sent
 * any follow-up message. RLS on `message_attachments` already scopes
 * access to the signed-in user via the via-parent-of-parent chain
 * (attachment -> message -> thread -> user_id), so the join here adds
 * thread filtering without weakening the security model.
 */
export async function findImageByFilenameInThread(
  client: SupabaseClient,
  threadId: string,
  filename: string
): Promise<Attachment | null> {
  const { data, error } = await client
    .from('message_attachments')
    .select(
      'id, message_id, position, filename, mime_type, size_bytes, storage_path, extracted_text, expired_at, created_at, messages!inner(thread_id)'
    )
    .eq('messages.thread_id', threadId)
    .eq('filename', filename)
    .like('mime_type', 'image/%')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new SupabaseError(error.message);
  if (!data) return null;
  return coerceAttachmentRow(data as Record<string, unknown>);
}

/**
 * Lightweight summary of every attachment in a thread, used to render
 * the `<thread_attachments>` system block in chat-loop. Omits
 * `extracted_text` (potentially huge) since the block only needs
 * filenames + categorisation.
 *
 * Live vs expired is read off `expired_at`: the expiry sweep stamps it
 * when it deletes an object, and the one-time legacy reclaim stamped it
 * on pre-bucket rows, so a non-null `expired_at` is equivalent to
 * `storage_path is null` here without projecting storage_path.
 */
export async function listAttachmentSummariesForThread(
  client: SupabaseClient,
  threadId: string
): Promise<ThreadAttachmentSummary[]> {
  const { data, error } = await client
    .from('message_attachments')
    .select(
      'filename, mime_type, expired_at, page_count, created_at, messages!inner(thread_id)'
    )
    .eq('messages.thread_id', threadId)
    .order('created_at', { ascending: true });
  if (error) throw new SupabaseError(error.message);
  return ((data ?? []) as Array<{
    filename: string;
    mime_type: string;
    expired_at: string | null;
    page_count: number | null;
    created_at: string;
  }>).map((row) => ({
    filename: row.filename,
    mime_type: row.mime_type,
    is_image: row.mime_type.startsWith('image/'),
    expired: row.expired_at !== null,
    // An expired attachment's page objects were reclaimed along with the
    // original, so it has nothing left to view regardless of what the column
    // says. Clearing it here keeps the block formatter from advertising
    // analyze_pdf_page on a document whose bytes are gone.
    page_count: row.expired_at !== null ? null : row.page_count,
    created_at: row.created_at,
  }));
}

/**
 * Insert one message row and touch the thread's updated_at in a
 * follow-up call. The two writes aren't in a transaction — if the
 * second call fails, we've still saved the message and the thread
 * just keeps its old ordering timestamp until the next activity.
 * That's intentional: losing the message would be a bigger regression
 * than a briefly stale sort order.
 *
 * The optional OpenAI-shape fields let assistant-with-tool-calls and
 * tool-result rows round-trip faithfully. `tool_calls` applies to
 * assistant rows that invoked tools; `tool_call_id` and `name` apply
 * to role='tool' rows pairing the assistant call to its result.
 */
export async function addMessage(
  client: SupabaseClient,
  threadId: string,
  role: Message['role'],
  content: string,
  opts: {
    tool_calls?: OpenAIToolCall[] | null;
    tool_call_id?: string | null;
    name?: string | null;
    /** Concrete Venice model id that produced this assistant row. */
    model?: string | null;
    /** Token-usage object returned by the provider for this turn. */
    usage?: TokenUsage | null;
    /** Chain-of-thought text; null when the model didn't produce any. */
    reasoning?: string | null;
    /** Venice web-search citations for this turn. */
    citations?: Citation[] | null;
    /**
     * Override created_at. The column defaults to now() on the
     * server; almost every caller wants that. The exception is
     * the synthetic-recovery persistence path, which heals a
     * wire-shape gap mid-conversation and needs the new row to
     * land at the gap's position in created_at order rather than
     * piling up at the tail.
     */
    created_at?: string;
  } = {}
): Promise<Message> {
  // Trim outer whitespace at the write boundary. LLM responses
  // sometimes land with a leading newline or indent (often from
  // Venice's SSE parser peeling the reasoning channel off the
  // content stream), which the markdown renderer interprets as a
  // code-indent and sets the whole reply at a blockquote offset.
  // User inputs occasionally carry trailing blank lines from
  // mobile autocomplete or paste. Trimming at insert keeps the DB
  // canonical; the Markdown component trims at render too so
  // existing rows benefit without a backfill.
  const trimmedContent = content.trim();
  const row: Record<string, unknown> = { thread_id: threadId, role, content: trimmedContent };
  if (opts.tool_calls !== undefined) row.tool_calls = opts.tool_calls;
  if (opts.tool_call_id !== undefined) row.tool_call_id = opts.tool_call_id;
  if (opts.name !== undefined) row.name = opts.name;
  if (opts.model !== undefined) row.model = opts.model;
  if (opts.usage !== undefined) row.usage = opts.usage;
  if (opts.reasoning !== undefined) row.reasoning = opts.reasoning;
  if (opts.citations !== undefined) row.citations = opts.citations;
  if (opts.created_at !== undefined) row.created_at = opts.created_at;
  const { data, error } = await client
    .from('messages')
    .insert(row)
    .select()
    .single();
  if (error) throw new SupabaseError(error.message);
  await client
    .from('threads')
    .update({ updated_at: new Date().toISOString() })
    .eq('id', threadId);
  return data as Message;
}

/**
 * Replace the `content` field on a single `role='tool'` row, located
 * by its (thread_id, tool_call_id) pair. The ONLY caller is the
 * ask_user suspend/resume path: the chat-loop initially writes a
 * pending sentinel as the tool row content, and the UI rewrites it
 * to the real answer payload when the user submits (or to an
 * abandonment payload on refresh / new send / sibling cancel).
 *
 * Scoped to role='tool' at the application layer in addition to the
 * RLS UPDATE policy's role check, so a future caller can't
 * accidentally rewrite an assistant or user row's content through
 * this surface. The tool_call_id pair is unique within a thread
 * (one tool result per call) so `single()` is correct here.
 *
 * Returns the updated row so the caller can append/replace it in
 * the in-memory message list.
 */
export async function updateToolMessageContent(
  client: SupabaseClient,
  threadId: string,
  toolCallId: string,
  content: string
): Promise<Message> {
  const { data, error } = await client
    .from('messages')
    .update({ content })
    .eq('thread_id', threadId)
    .eq('tool_call_id', toolCallId)
    .eq('role', 'tool')
    .select()
    .single();
  if (error) throw new SupabaseError(error.message);
  return data as Message;
}

/**
 * Mark an assistant row's second-thoughts verdict as acted-on (the
 * user clicked the refinement button). Routes through the
 * `mark_second_thoughts_acted` SECURITY DEFINER RPC because the
 * client's messages-UPDATE RLS policy only covers role='tool' rows;
 * the RPC gates on thread ownership and touches only the `acted` key.
 * Callers fire-and-forget - a failure just means the flag won't
 * survive a reload (this turn's wire is driven by the local patch).
 */
export async function markSecondThoughtsActed(
  client: SupabaseClient,
  messageId: string
): Promise<void> {
  const { error } = await client.rpc('mark_second_thoughts_acted', {
    p_message_id: messageId,
  });
  if (error) throw new SupabaseError(error.message);
}
