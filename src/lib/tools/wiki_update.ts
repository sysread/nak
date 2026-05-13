/**
 * Patch an existing wiki article's title and/or content. Either field
 * can be omitted. Any change to title or content fires the schema
 * trigger that nulls the embedding, sending the row back to the
 * worker's pending queue.
 *
 * Source attribution path:
 *   - Autonomous agent (ctx.threadId is a real thread id): the current
 *     thread is attached to the article's bibliography automatically.
 *     The model does not handle source ids.
 *   - Librarian (ctx.threadId is empty): the `source_thread_ids`
 *     parameter carries the ids the librarian believes informed this
 *     update. We validate each id against the threads table (filtering
 *     out anything the user doesn't own) before attaching - the
 *     librarian sees many ids in conversation_search results and copy
 *     fidelity can drift, so we treat the parameter as advisory and
 *     drop unknown ids silently rather than rejecting the whole call.
 *   - Manual path (Wiki.svelte "Ask agent to update"): doesn't go
 *     through tool calls, so no attribution happens. The user's
 *     direct edits don't add to the bibliography.
 */
import type { ToolDef } from './types';
import {
  MAX_WIKI_TITLE_CHARS,
  MAX_WIKI_CONTENT_CHARS,
  MAX_WIKI_CHANGELOG_MESSAGE_CHARS,
} from '../wiki';
import { wikiUpdateSchema } from './wiki_update.schema';
import { emitWikiChange } from '../wiki-events';

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
  ...wikiUpdateSchema,
  async execute(args, ctx) {
    const id = typeof args.id === 'string' ? args.id : '';
    if (!id) throw new Error('id is required');
    const message = typeof args.message === 'string' ? args.message.trim() : '';
    if (!message) throw new Error('message is required');
    if (message.length > MAX_WIKI_CHANGELOG_MESSAGE_CHARS) {
      throw new Error(
        `message exceeds ${MAX_WIKI_CHANGELOG_MESSAGE_CHARS}-char limit (got ${message.length})`
      );
    }
    const patch: { title?: string; content?: string } = {};
    if (typeof args.title === 'string' && args.title.trim().length > 0) {
      const title = args.title.trim();
      if (title.length > MAX_WIKI_TITLE_CHARS) {
        throw new Error(
          `title exceeds ${MAX_WIKI_TITLE_CHARS}-char limit (got ${title.length})`
        );
      }
      patch.title = title;
    }
    if (typeof args.content === 'string' && args.content.length > 0) {
      if (args.content.length > MAX_WIKI_CONTENT_CHARS) {
        throw new Error(
          `content exceeds ${MAX_WIKI_CONTENT_CHARS}-char limit (got ${args.content.length}); split or trim`
        );
      }
      patch.content = args.content;
    }
    if (Object.keys(patch).length === 0) {
      throw new Error('provide at least one of title or content');
    }
    const article = await ctx.supabase.updateWikiArticle(id, patch);

    // Decide which thread ids to attach as sources. ctx.threadId
    // (when non-empty) is trusted directly - the autonomous worker
    // is processing the user's own thread. source_thread_ids are
    // validated against the threads table so a fabricated id can't
    // land.
    const sourceIds = new Set<string>();
    if (ctx.threadId) sourceIds.add(ctx.threadId);
    const candidate = collectSourceThreadIds(args);
    if (candidate.length > 0) {
      const known = await ctx.supabase.findExistingThreadIds(candidate);
      for (const tid of candidate) {
        if (known.has(tid)) sourceIds.add(tid);
      }
    }
    if (sourceIds.size > 0) {
      try {
        await ctx.supabase.attachWikiArticleSources(article.id, [
          ...sourceIds,
        ]);
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
      await ctx.supabase.createWikiChangelogEntry({
        article_id: article.id,
        kind: 'update',
        title_at_change: article.title,
        message,
      });
    } catch {
      // best-effort; see comment above.
    }

    emitWikiChange();
    return article;
  },
};
