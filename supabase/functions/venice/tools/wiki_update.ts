// wiki_update (function-side port)
//
// Patch an existing wiki article's title and/or content, attach
// source threads to its bibliography, and append a changelog row.
// Wire schema lives in src/lib/tools/wiki_update.schema.ts.
// Constants mirrored from src/lib/wiki.ts. Auth: b-strict, explicit
// user_id filter on the update (the browser version got owner
// scoping from RLS; the service-role client does not).
//
// Any change to title or content fires the schema trigger that nulls
// the embedding, sending the row back to the backfill queue.
//
// Source attribution path:
//   - Autonomous agent (ctx.threadId is a real thread id): the
//     current thread is attached automatically. The model does not
//     handle source ids.
//   - Librarian (ctx.threadId is null): the `source_thread_ids`
//     parameter carries the ids the librarian believes informed this
//     update. Each id is validated against the user's own threads
//     before attaching - the librarian sees many ids in
//     conversation_search results and copy fidelity can drift, so the
//     parameter is advisory and unknown ids are dropped silently
//     rather than rejecting the whole call.

import { registerTool, type ToolContext, type ToolDef } from '../performToolCall.ts';
import {
  appendWikiChangelog,
  attachWikiArticleSources,
  findExistingThreadIds,
} from './_wiki_helpers.ts';
import { ArgErrors, rejectUnknownArgs } from './_validate.ts';
import {
  MAX_WIKI_TITLE_CHARS,
  MAX_WIKI_CONTENT_CHARS,
  MAX_WIKI_CHANGELOG_MESSAGE_CHARS,
} from '../../_shared/wiki-limits.ts';

/**
 * Read the article's current content length for the changelog's
 * before-size. Returns null when the article doesn't exist or isn't
 * owned - the changelog then records an unknown before-size rather
 * than implying a zero-length body.
 */
async function readArticleContentLength(
  adminClient: import('@supabase/supabase-js').SupabaseClient,
  userId: string,
  articleId: string,
): Promise<number | null> {
  const { data, error } = await adminClient
    .from('wiki_articles')
    .select('content')
    .eq('id', articleId)
    .eq('user_id', userId)
    .maybeSingle();
  if (error) return null;
  if (!data) return null;
  const content = (data as { content?: unknown }).content;
  return typeof content === 'string' ? content.length : null;
}

/**
 * Pull `source_thread_ids` out of the model's arguments, coercing to
 * an array of trimmed strings and dropping anything non-string. The
 * downstream validator (findExistingThreadIds) rejects ids that don't
 * exist; this helper just sanitises the shape.
 */
function collectSourceThreadIds(args: Record<string, unknown>): string[] {
  const raw = args.source_thread_ids;
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim();
    if (trimmed.length === 0) continue;
    out.push(trimmed);
  }
  return out;
}

export const wikiUpdate: ToolDef = {
  name: 'wiki_update',
  async execute(args: Record<string, unknown>, ctx: ToolContext) {
    const id = typeof args.id === 'string' ? args.id : '';
    const message = typeof args.message === 'string' ? args.message.trim() : '';

    const errs = new ArgErrors();
    rejectUnknownArgs(errs, args, ['id', 'title', 'content', 'message', 'source_thread_ids']);
    if (!id) errs.add('id is required');
    if (!message) errs.add('message is required');
    else if (message.length > MAX_WIKI_CHANGELOG_MESSAGE_CHARS) {
      errs.add(
        `message exceeds ${MAX_WIKI_CHANGELOG_MESSAGE_CHARS}-char limit (got ${message.length})`,
      );
    }
    const patch: { title?: string; content?: string } = {};
    if (typeof args.title === 'string' && args.title.trim().length > 0) {
      const title = args.title.trim();
      if (title.length > MAX_WIKI_TITLE_CHARS) {
        errs.add(`title exceeds ${MAX_WIKI_TITLE_CHARS}-char limit (got ${title.length})`);
      } else {
        patch.title = title;
      }
    }
    if (typeof args.content === 'string' && args.content.length > 0) {
      if (args.content.length > MAX_WIKI_CONTENT_CHARS) {
        errs.add(
          `content exceeds ${MAX_WIKI_CONTENT_CHARS}-char limit (got ${args.content.length}); split or trim`,
        );
      } else {
        patch.content = args.content;
      }
    }
    // Empty-patch only complains when nothing else is wrong; a malformed
    // title/content left its patch key unset and is already reported.
    if (Object.keys(patch).length === 0 && !errs.any) {
      errs.add('provide at least one of title or content');
    }
    errs.throwIfAny();

    // Read the prior content length before the update so the changelog
    // can stamp chars_before. One read serving one consumer here (the
    // memory_update pattern also feeds a budget check; here it's just
    // the before-size). An unreadable row degrades to an unknown
    // before-size, which the panel renders as "no size info".
    const priorContentLength = id
      ? await readArticleContentLength(ctx.adminClient, ctx.userId, id)
      : null;

    // RLS OFF: the user_id filter scopes the patch to the owner. A
    // foreign or unknown id matches zero rows and .single() surfaces
    // that as an error the agent can read.
    const { data: row, error } = await ctx.adminClient
      .from('wiki_articles')
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq('id', id)
      .eq('user_id', ctx.userId)
      .select('id, title, content, created_at, updated_at')
      .single();
    if (error) throw new Error(`updateWikiArticle failed: ${error.message}`);
    const article = row as { id: string; title: string };

    // Decide which thread ids to attach as sources. ctx.threadId
    // (when non-empty) is trusted directly - the agent is processing
    // the user's own claimed thread. source_thread_ids are validated
    // against the user's threads so a fabricated id can't land.
    const sourceIds = new Set<string>();
    if (ctx.threadId) sourceIds.add(ctx.threadId);
    const candidate = collectSourceThreadIds(args);
    if (candidate.length > 0) {
      const known = await findExistingThreadIds(ctx.adminClient, ctx.userId, candidate);
      for (const tid of candidate) {
        if (known.has(tid)) sourceIds.add(tid);
      }
    }
    if (sourceIds.size > 0) {
      try {
        await attachWikiArticleSources(ctx.adminClient, article.id, [...sourceIds]);
      } catch {
        // Best-effort secondary write. The update itself already
        // succeeded; a failed attach just means the bibliography
        // misses a row, which is much smaller damage than failing
        // the whole call and surfacing a confusing error to a model
        // that already wrote the right prose.
      }
    }

    // Append the changelog row with the post-update title so the
    // entry references the article by its current name. Best-effort
    // for the same reason source-attribution is - the mutation
    // already landed.
    try {
      await appendWikiChangelog(ctx.adminClient, ctx.userId, {
        article_id: article.id,
        kind: 'update',
        title_at_change: article.title,
        message,
        // Undefined (-> NULL, "unknown") when the prior read failed; a
        // title-only edit leaves both equal, which reads as a 0 delta.
        chars_before: priorContentLength ?? undefined,
        chars_after: (row as { content?: string }).content?.length,
      });
    } catch {
      // best-effort; see comment above.
    }

    return row;
  },
};

registerTool(wikiUpdate);
