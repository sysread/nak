// docs (function-side combination tool)
//
// One tool behind an `op` enum discriminator: list / get / grep /
// read / save / delete over the user's Library. Replaces the six
// doc_* verb registrations; the per-op bodies survive verbatim as
// internal functions - only the envelope changed (see the browser
// schema's header).
//
// Auth: b-strict throughout. documents has user_id directly, so the
// reads filter .eq('user_id', userId) and the writes stamp p_user_id
// (or an explicit user_id on direct-table writes) - the service-role
// client bypasses RLS, and miss-vs-not-owned reads the same to a
// probing caller.
//
// The browser path of get/read goes through the document_stat /
// read_document_lines RPCs, which use auth.uid() - that returns NULL
// under the service-role admin client, so the function inlines the
// same SELECTs with explicit user_id filters. The RPC-shaped
// counterparts (grep_documents, read_document_lines) take p_user_id
// explicitly so the function can call them safely.
//
// save is the create/update-merged Library metadata write: omit id
// to promote a thread attachment (the natural key is the filename -
// an exact match routes to that document's update, a near-match is
// refused with the candidates named), pass id to patch
// title/description. The extracted body is bound to the uploaded
// file and is not editable here - replacing content would be a
// re-upload, a user action through the UI.
//
// Per-op required fields (id on get/delete, pattern on grep,
// document_id + numeric line range on read, filename + description
// on create) are enforced inside the per-op bodies below - the flat
// wire schema cannot express them. Error strings are load-bearing:
// substring test assertions pin them (tests/docs_tools.test.ts).

import { requireThreadId, registerTool, type ToolContext, type ToolDef } from '../performToolCall.ts';
import { resolveNaturalKeyMatch } from './_upsert_heuristics.ts';

// Mirror of src/lib/documents.ts. Keep in sync deliberately - the
// browser-side schema and the user-facing copy expect the same limits.
const MAX_DOCUMENT_TITLE_CHARS = 300;
const MAX_DOCUMENT_DESCRIPTION_CHARS = 2000;

// Mirror of the per-op schema constants.
const DOC_LIST_DEFAULT_LIMIT = 100;
const DOC_LIST_MAX_LIMIT = 500;
const DOC_GREP_DEFAULT_CONTEXT = 2;
const DOC_GREP_MAX_CONTEXT = 5;
const DOC_GREP_DEFAULT_MAX_MATCHES = 50;
const DOC_GREP_MAX_MATCHES = 200;
const DOC_READ_MAX_SPAN = 500;

interface AttachmentRow {
  id: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  storage_path: string | null;
  extracted_text: string | null;
}

interface DocumentRow {
  id: string;
  title: string;
}

/**
 * The dedup heuristic's lookup against the documents table.
 * RLS OFF: filters by user_id explicitly - service-role bypasses RLS.
 * PostgREST select strings cannot carry `AS` aliases (42703), so the
 * probe selects the bare column and re-shapes to {id, key}.
 */
function probeDocuments(ctx: ToolContext) {
  return async (
    probeValue: string,
  ): Promise<{ data: { id: string; key: string }[] }> => {
    const { data, error } = await ctx.adminClient
      .from('documents')
      .select('id, filename')
      .eq('user_id', ctx.userId)
      // % wildcards: see the matching comment in wiki_save.ts - a bare
      // ilike pattern only matches the exact string, hiding near-matches
      // from the fuzzy branch.
      .ilike('filename', `%${probeValue}%`)
      .limit(3);
    if (error) throw new Error(`naturalKeyProbe failed: ${error.message}`);
    const rows = (data ?? []) as { id: string; filename: string }[];
    return { data: rows.map((r) => ({ id: r.id, key: r.filename })) };
  };
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

async function listOp(args: Record<string, unknown>, ctx: ToolContext) {
  const rawLimit =
    typeof args.limit === 'number' ? args.limit : DOC_LIST_DEFAULT_LIMIT;
  const limit = Math.max(
    1,
    Math.min(DOC_LIST_MAX_LIMIT, Math.floor(rawLimit)),
  );

  // RLS OFF: filter by userId. documents.user_id is the direct
  // ownership column.
  const { data, error } = await ctx.adminClient
    .from('documents')
    .select(
      'id, title, description, filename, mime_type, size_bytes, extraction_status, created_at, updated_at',
    )
    .eq('user_id', ctx.userId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw new Error(`listDocuments failed: ${error.message}`);

  return (data ?? []).map((d) => ({
    id: d.id as string,
    title: d.title as string | null,
    description: d.description as string | null,
    filename: d.filename as string,
    mime_type: d.mime_type as string,
    size_bytes: d.size_bytes as number,
    extraction_status: d.extraction_status as string,
    created_at: d.created_at as string,
    updated_at: d.updated_at as string,
  }));
}

// ---------------------------------------------------------------------------
// get
// ---------------------------------------------------------------------------

interface DocumentStatRow {
  id: string;
  title: string | null;
  description: string | null;
  filename: string;
  mime_type: string;
  size_bytes: number;
  extraction_status: string;
  extraction_error: string | null;
  extracted_text: string | null;
  created_at: string;
  updated_at: string;
}

async function getOp(args: Record<string, unknown>, ctx: ToolContext) {
  const id = typeof args.id === 'string' ? args.id.trim() : '';
  if (!id) throw new Error('id is required');

  // RLS OFF: filter by userId. documents.user_id direct match,
  // plus id eq - matches the browser's RPC behavior shape (miss
  // and not-owned both surface as {found: false}).
  const { data, error } = await ctx.adminClient
    .from('documents')
    .select(
      'id, title, description, filename, mime_type, size_bytes, extraction_status, extraction_error, extracted_text, created_at, updated_at',
    )
    .eq('user_id', ctx.userId)
    .eq('id', id)
    .maybeSingle<DocumentStatRow>();
  if (error) throw new Error(`getDocumentStat failed: ${error.message}`);
  if (!data) return { found: false };

  const text = data.extracted_text;
  const has_text = typeof text === 'string' && text.length > 0;
  // Newline-counting math from the document_stat SQL: total_lines =
  // (length - length_without_newlines) + 1 for a non-empty body.
  // A body with no newlines is one line; empty body is zero lines.
  const total_lines = has_text && text !== null
    ? text.length - text.replace(/\n/g, '').length + 1
    : 0;

  return {
    found: true,
    document: {
      id: data.id,
      title: data.title,
      description: data.description,
      filename: data.filename,
      mime_type: data.mime_type,
      size_bytes: data.size_bytes,
      extraction_status: data.extraction_status,
      has_text,
      total_lines,
      created_at: data.created_at,
      updated_at: data.updated_at,
    },
  };
}

// ---------------------------------------------------------------------------
// grep
// ---------------------------------------------------------------------------

interface GrepHit {
  document_id: string;
  title: string;
  line_number: number;
  line_text: string;
  context_before: string[];
  context_after: string[];
}

async function grepOp(args: Record<string, unknown>, ctx: ToolContext) {
  const pattern = typeof args.pattern === 'string' ? args.pattern.trim() : '';
  if (!pattern) throw new Error('pattern is required');

  const documentId =
    typeof args.document_id === 'string' && args.document_id.trim().length > 0
      ? args.document_id.trim()
      : null;
  const caseSensitive = args.case_sensitive === true;
  const rawContext =
    typeof args.context === 'number' ? args.context : DOC_GREP_DEFAULT_CONTEXT;
  const context = Math.max(0, Math.min(DOC_GREP_MAX_CONTEXT, Math.floor(rawContext)));
  const rawMax =
    typeof args.max_matches === 'number' ? args.max_matches : DOC_GREP_DEFAULT_MAX_MATCHES;
  const maxMatches = Math.max(1, Math.min(DOC_GREP_MAX_MATCHES, Math.floor(rawMax)));

  const { data, error } = await ctx.adminClient.rpc('grep_documents', {
    p_pattern: pattern,
    p_document_id: documentId,
    p_case_sensitive: caseSensitive,
    p_context: context,
    p_max_matches: maxMatches,
    p_user_id: ctx.userId,
  });

  if (error) {
    if (/regular expression|invalid.*regex/i.test(error.message)) {
      return {
        error: `Invalid regular expression: ${error.message}. Fix the pattern and try again.`,
      };
    }
    throw new Error(`grepDocument failed: ${error.message}`);
  }

  const hits = (data ?? []) as GrepHit[];
  return {
    match_count: hits.length,
    truncated: hits.length >= maxMatches,
    matches: hits.map((h) => ({
      document_id: h.document_id,
      title: h.title,
      line_number: h.line_number,
      line_text: h.line_text,
      context_before: h.context_before,
      context_after: h.context_after,
    })),
  };
}

// ---------------------------------------------------------------------------
// read
// ---------------------------------------------------------------------------

interface LineRow {
  line_number: number;
  content: string;
  total_lines: number;
}

interface DocStatRow {
  extracted_text: string | null;
}

async function readOp(args: Record<string, unknown>, ctx: ToolContext) {
  const documentId =
    typeof args.document_id === 'string' ? args.document_id.trim() : '';
  if (!documentId) throw new Error('document_id is required');

  if (typeof args.start_line !== 'number' || typeof args.end_line !== 'number' ||
      !Number.isFinite(args.start_line) || !Number.isFinite(args.end_line)) {
    throw new Error('start_line and end_line are required and must be numbers');
  }
  const start = Math.max(1, Math.floor(Number(args.start_line)));
  const rawEnd = Math.max(start, Math.floor(Number(args.end_line)));
  const end = Math.min(rawEnd, start + DOC_READ_MAX_SPAN - 1);

  const { data, error } = await ctx.adminClient.rpc('read_document_lines', {
    p_document_id: documentId,
    p_start: start,
    p_end: end,
    p_user_id: ctx.userId,
  });
  if (error) throw new Error(`readDocumentLines failed: ${error.message}`);

  const rows = (data ?? []) as LineRow[];
  if (rows.length === 0) {
    // Disambiguate by inlining the stat query - same shape as
    // the get op's inlined SELECT. // RLS OFF: filter by userId on
    // documents.
    const { data: stat, error: statErr } = await ctx.adminClient
      .from('documents')
      .select('extracted_text')
      .eq('user_id', ctx.userId)
      .eq('id', documentId)
      .maybeSingle<DocStatRow>();
    if (statErr) throw new Error(`document_stat fallback failed: ${statErr.message}`);
    if (!stat) return { found: false };

    const text = stat.extracted_text;
    const has_text = typeof text === 'string' && text.length > 0;
    const total_lines = has_text && text !== null
      ? text.length - text.replace(/\n/g, '').length + 1
      : 0;
    return {
      found: true,
      total_lines,
      start_line: start,
      end_line: end,
      lines: [],
      note: total_lines === 0
        ? 'This document has no extracted text to read.'
        : `Requested range is past the end; the document has ${total_lines} lines.`,
    };
  }

  return {
    found: true,
    total_lines: rows[0].total_lines,
    start_line: rows[0].line_number,
    end_line: rows[rows.length - 1].line_number,
    lines: rows.map((r) => ({ line_number: r.line_number, content: r.content })),
  };
}

// ---------------------------------------------------------------------------
// save
// ---------------------------------------------------------------------------

/**
 * The dedup heuristic's lookup shape is shared with the save op's
 * probe; see probeDocuments above.
 */
async function doCreate(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<unknown> {
  const filename = (args.filename as string).trim();
  const description = (args.description as string).trim();
  const title =
    typeof args.title === 'string' && args.title.trim().length > 0
      ? args.title.trim()
      : filename;

  // The model may be updating a document whose filename it remembers
  // but whose id it forgot; the natural-key heuristic routes an exact
  // match to that document's update path.
  const match = await resolveNaturalKeyMatch({
    query: probeDocuments(ctx),
    keyValue: filename,
    fuzzy: true,
  });
  if (match) {
    const patch: Record<string, unknown> = {};
    if (args.title !== undefined && args.title !== null) {
      patch.title = (args.title as string).trim().slice(0, MAX_DOCUMENT_TITLE_CHARS);
    }
    patch.description = description.slice(0, MAX_DOCUMENT_DESCRIPTION_CHARS);
    patch.updated_at = new Date().toISOString();
    const { error } = await ctx.adminClient
      .from('documents')
      .update(patch)
      .eq('id', match.id)
      .eq('user_id', ctx.userId);
    if (error) throw new Error(`updateDocument failed: ${error.message}`);
    return { updated: true, document_id: match.id, matched_existing: true };
  }

  return promoteAttachment(args, ctx, filename, description, title);
}

async function doUpdate(
  id: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<unknown> {
  const patch: Record<string, unknown> = {};
  if (typeof args.title === 'string' && args.title.trim().length > 0) {
    patch.title = args.title.trim().slice(0, MAX_DOCUMENT_TITLE_CHARS);
  }
  if (typeof args.description === 'string') {
    patch.description = args.description.trim().slice(0, MAX_DOCUMENT_DESCRIPTION_CHARS);
  }
  if (Object.keys(patch).length === 0) {
    return { updated: false, reason: 'Provide a title and/or description to change.' };
  }
  patch.updated_at = new Date().toISOString();

  // RLS OFF: filter by userId. Existence check folded into the
  // UPDATE - 0 rows affected if id is unknown or non-owned.
  const { data, error } = await ctx.adminClient
    .from('documents')
    .update(patch)
    .eq('id', id)
    .eq('user_id', ctx.userId)
    .select('id')
    .maybeSingle();
  if (error) throw new Error(`updateDocument failed: ${error.message}`);
  if (!data) return { updated: false, reason: 'No document with that id.' };

  return { updated: true, document_id: id };
}

/**
 * Promotion path (create form). Find the attachment by filename in
 * the thread, insert the documents row, copy the binary from the
 * `attachments` bucket to the `documents` bucket if the original is
 * still live, stamp extraction_status='done' with the attachment's
 * already-parsed extracted_text.
 */
async function promoteAttachment(
  args: Record<string, unknown>,
  ctx: ToolContext,
  filename: string,
  description: string,
  title: string | undefined,
) {
  const displayTitle =
    typeof title === 'string' && title.trim().length > 0 ? title.trim() : filename;

  // RLS OFF: scoped via parent thread (validated upstream). Join
  // message_attachments to messages so the thread_id check rides on
  // the relationship. Take the most recent matching row regardless
  // of mime type or expiry state - the caller distinguishes "not
  // found" from "expired" off the storage_path nullity below.
  const { data: attachment, error: attachmentErr } = await ctx.adminClient
    .from('message_attachments')
    .select(
      'id, filename, mime_type, size_bytes, storage_path, extracted_text, messages!inner(thread_id)',
    )
    .eq('messages.thread_id', requireThreadId(ctx))
    .eq('filename', filename)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle<AttachmentRow>();
  if (attachmentErr) {
    throw new Error(
      `findAttachmentByFilenameInThread failed: ${attachmentErr.message}`,
    );
  }
  if (!attachment) {
    return {
      created: false,
      reason: `No attachment named "${filename}" found in this conversation.`,
    };
  }

  const text = (attachment.extracted_text ?? '').trim();
  if (text.length === 0) {
    return {
      created: false,
      reason:
        `"${filename}" has no extractable text, so it can't be saved as a ` +
        'searchable document. The Library is for text-based files.',
    };
  }

  // RLS OFF: user_id stamped explicitly. The documents table's
  // SELECT/UPDATE/DELETE policies key off user_id = auth.uid(); the
  // Library UI uses the session JWT so it'll see only the caller's
  // rows. Service-role inserts bypass policies but the explicit
  // user_id keeps the row addressable through the regular UI path.
  const { data: doc, error: docErr } = await ctx.adminClient
    .from('documents')
    .insert({
      user_id: ctx.userId,
      title: (displayTitle ?? filename).slice(0, MAX_DOCUMENT_TITLE_CHARS),
      description: description.slice(0, MAX_DOCUMENT_DESCRIPTION_CHARS),
      filename,
      mime_type: attachment.mime_type,
      size_bytes: attachment.size_bytes,
    })
    .select('id, title')
    .single<DocumentRow>();
  if (docErr || !doc) {
    throw new Error(
      `createDocument failed: ${docErr?.message ?? 'no row returned'}`,
    );
  }

  // Copy the binary into the documents bucket only when the
  // attachment is still live. An expired attachment leaves
  // storage_path null on both rows; the doc is still fully
  // searchable through extracted_text. Convention for the documents
  // bucket key is `<user_id>/<document_id>/<filename>` (mirrors the
  // browser's uploadDocumentFile).
  if (attachment.storage_path) {
    const { data: blob, error: dlErr } = await ctx.adminClient.storage
      .from('attachments')
      .download(attachment.storage_path);
    if (dlErr || !blob) {
      throw new Error(
        `downloadAttachmentBlob failed: ${dlErr?.message ?? 'no blob returned'}`,
      );
    }
    const path = `${ctx.userId}/${doc.id}/${filename}`;
    const { error: upErr } = await ctx.adminClient.storage
      .from('documents')
      .upload(path, blob, {
        contentType: attachment.mime_type,
        upsert: true,
      });
    if (upErr) {
      throw new Error(`uploadDocumentFile failed: ${upErr.message}`);
    }
    const { error: pathErr } = await ctx.adminClient
      .from('documents')
      .update({ storage_path: path })
      .eq('id', doc.id);
    if (pathErr) {
      throw new Error(`setDocumentStoragePath failed: ${pathErr.message}`);
    }
  }

  const { error: extractErr } = await ctx.adminClient
    .from('documents')
    .update({
      extraction_status: 'done',
      extracted_text: text,
      extraction_error: null,
    })
    .eq('id', doc.id);
  if (extractErr) {
    throw new Error(`setDocumentExtraction failed: ${extractErr.message}`);
  }

  return { created: true, document_id: doc.id, title: doc.title };
}

async function saveOp(args: Record<string, unknown>, ctx: ToolContext) {
  const id =
    typeof args.id === 'string' && args.id.trim().length > 0
      ? args.id.trim()
      : undefined;

  if (id) {
    // Update form: at least one of title/description (description is
    // in the wire required list, but the impl also tolerates a
    // title-only patch).
    if (
      (args.title === undefined || args.title === null) &&
      (args.description === undefined || args.description === null)
    ) {
      return { updated: false, reason: 'Provide a title and/or description to change.' };
    }
    return doUpdate(id, args, ctx);
  }

  // Create-side required check.
  const filename = typeof args.filename === 'string' ? args.filename.trim() : '';
  if (!filename) throw new Error('filename is required');
  const description =
    typeof args.description === 'string' ? args.description.trim() : '';
  // Required by the wire schema; an empty description defeats the
  // find-it-later purpose the schema description insists on.
  if (!description) throw new Error('description is required');

  return doCreate(args, ctx);
}

// ---------------------------------------------------------------------------
// delete
// ---------------------------------------------------------------------------

async function deleteOp(args: Record<string, unknown>, ctx: ToolContext) {
  const id = typeof args.id === 'string' ? args.id.trim() : '';
  if (!id) throw new Error('id is required');

  // RLS OFF: filter by userId. Snapshot the storage_path so we
  // can remove the bucket object before dropping the row.
  const { data: existing, error: readErr } = await ctx.adminClient
    .from('documents')
    .select('storage_path')
    .eq('id', id)
    .eq('user_id', ctx.userId)
    .maybeSingle<{ storage_path: string | null }>();
  if (readErr) throw new Error(`getDocumentById failed: ${readErr.message}`);
  if (!existing) return { deleted: false, reason: 'No document with that id.' };

  if (existing.storage_path) {
    const { error: rmErr } = await ctx.adminClient.storage
      .from('documents')
      .remove([existing.storage_path]);
    if (rmErr) throw new Error(`document storage remove failed: ${rmErr.message}`);
  }

  // RLS OFF: filter by userId on the delete itself.
  const { error: delErr } = await ctx.adminClient
    .from('documents')
    .delete()
    .eq('id', id)
    .eq('user_id', ctx.userId);
  if (delErr) throw new Error(`deleteDocument failed: ${delErr.message}`);

  return { deleted: true, document_id: id };
}

// ---------------------------------------------------------------------------
// combination-tool envelope
// ---------------------------------------------------------------------------

export const docs: ToolDef = {
  name: 'docs',
  async execute(args: Record<string, unknown>, ctx: ToolContext) {
    const op = typeof args.op === 'string' ? args.op.trim() : '';
    if (!op) {
      throw new Error('op is required (list | get | grep | read | save | delete)');
    }
    switch (op) {
      case 'list':
        return listOp(args, ctx);
      case 'get':
        return getOp(args, ctx);
      case 'grep':
        return grepOp(args, ctx);
      case 'read':
        return readOp(args, ctx);
      case 'save':
        return saveOp(args, ctx);
      case 'delete':
        return deleteOp(args, ctx);
      default:
        throw new Error(
          `unknown op "${op}" - expected list, get, grep, read, save, or delete`,
        );
    }
  },
};

registerTool(docs);
