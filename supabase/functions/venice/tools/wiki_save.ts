// wiki_save (create/update-merged wiki write)
//
// One tool behind an optional `id`: omit it to create a new article,
// pass it to update. Consolidates the former wiki_create + wiki_update
// (the routing contract lives in src/lib/tools/upsert.ts). Wire schema
// lives in src/lib/tools/wiki_save.schema.ts; the agent mirrors
// (agents/wiki.ts, agents/wiki_librarian.ts) carry their own wire
// copies of the same shape. Auth: b-strict, explicit user_id stamp on
// inserts, user_id filter on reads and updates.
//
// Natural-key dedup: titles are unique per user (unique (user_id,
// lower(title))). When a create lands with a title that exactly
// matches an existing article (case-insensitive), the call is routed
// to that article's update - what the model demonstrably meant,
// without the 23505 round trip the separate create/update pair used
// to produce. A near-match (containment either way) is refused with
// the candidate rows named, so "Maya Smith" against existing "Maya"
// neither silently merges nor silently duplicates. See
// resolveNaturalKeyMatch in _shared/upsert.ts.
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
//     save. Each id is validated against the user's own threads
//     before attaching - the librarian sees many ids in
//     conversation_search results and copy fidelity can drift, so the
//     parameter is advisory and unknown ids are dropped silently
//     rather than rejecting the whole call.

import { registerTool, type ToolContext } from '../performToolCall.ts';
import {
  appendWikiChangelog,
  attachWikiArticleSources,
  findExistingThreadIds,
} from './_wiki_helpers.ts';
import { ArgErrors } from './_validate.ts';
import {
  MAX_WIKI_TITLE_CHARS,
  MAX_WIKI_CONTENT_CHARS,
  MAX_WIKI_CHANGELOG_MESSAGE_CHARS,
} from '../../_shared/wiki-limits.ts';
import { resolveNaturalKeyMatch } from './_upsert_heuristics.ts';

/**
 * Read the article's current content length (for the changelog's
 * before-size) and favorite flag (for the agent-edit lock) before the
 * update lands. Returns null for the length when the article doesn't
 * exist or isn't owned - the changelog then records an unknown
 * before-size rather than implying a zero-length body. The favorite
 * flag defaults to false so a missing article falls through to the
 * normal "no rows updated" path rather than being mistaken for locked.
 */
async function readArticleState(
  adminClient: ToolContext['adminClient'],
  userId: string,
  articleId: string,
): Promise<{ contentLength: number | null; favorite: boolean }> {
  const { data, error } = await adminClient
    .from('wiki_articles')
    .select('content, favorite')
    .eq('id', articleId)
    .eq('user_id', userId)
    .maybeSingle();
  if (error || !data) return { contentLength: null, favorite: false };
  const row = data as { content?: unknown; favorite?: unknown };
  const contentLength =
    typeof row.content === 'string' ? row.content.length : null;
  const favorite = row.favorite === true;
  return { contentLength, favorite };
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

/**
 * The favorite flag is a user-controlled bookmark and agent-edit
 * lock; agents must not be able to set or clear it. Neither the
 * insert payload nor the patch ever carries `favorite` - the column
 * defaults to false at the DB level on insert, and the patch is built
 * from named fields only. A favorited article refuses agent edits
 * outright: the user starred it to protect it from exactly this kind
 * of background overwrite. The browser's own direct edit path (RLS,
 * not this tool) is unaffected, so the user can still edit it
 * themselves.
 */
async function assertNotLocked(
  ctx: ToolContext,
  articleId: string,
  label: string,
): Promise<{ contentLength: number | null; favorite: boolean }> {
  const prior = await readArticleState(ctx.adminClient, ctx.userId, articleId);
  if (prior.favorite) {
    throw new Error(
      `The article "${label}" is favorited (locked) and cannot be edited by the agent. ` +
        'The user must remove the favorite star before agent edits are allowed.',
    );
  }
  return prior;
}

async function updateArticle(
  ctx: ToolContext,
  articleId: string,
  patch: { title?: string; content?: string },
) {
  // RLS OFF: the user_id filter scopes the patch to the owner. A
  // foreign or unknown id matches zero rows and .single() surfaces
  // that as an error the agent can read.
  const { data: row, error } = await ctx.adminClient
    .from('wiki_articles')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', articleId)
    .eq('user_id', ctx.userId)
    .select('id, title, content, created_at, updated_at')
    .single();
  if (error) throw new Error(`updateWikiArticle failed: ${error.message}`);
  return row as { id: string; title: string; content?: string };
}

async function insertArticle(ctx: ToolContext, title: string, content: string) {
  // RLS OFF: user_id stamped on insert - service-role would otherwise
  // let a row land under any owner. The insert carries only user_id,
  // title, and content - never `favorite`.
  const { data: row, error } = await ctx.adminClient
    .from('wiki_articles')
    .insert({ user_id: ctx.userId, title, content })
    .select('id, title, content, created_at, updated_at')
    .single();
  if (error) {
    // Unique-violation reads as code 23505 in PostgREST's error
    // wrapper; the message form varies, so sniff both. Reachable only
    // when the natural-key probe raced with a concurrent insert - the
    // heuristic above catches the common case first. Rephrase as
    // agent-readable so the model flips to an update without
    // retrying the create.
    if (
      error.code === '23505' ||
      /duplicate key|unique constraint|23505/i.test(error.message)
    ) {
      throw new Error(
        `An article titled "${title}" already exists. Run wiki_search to find its id, then call wiki_save with that id to integrate.`,
      );
    }
    throw new Error(`createWikiArticle failed: ${error.message}`);
  }
  return row as { id: string; title: string; content?: string };
}

/**
 * Best-effort changelog. The article is already saved at this point;
 * a failure here would leave an article without a matching changelog
 * entry, which is a smaller harm than throwing back to the agent and
 * tempting it into a retry that would hit the unique-title constraint.
 * A create stamps chars_before 0 (it genuinely had nothing before it -
 * different from a pre-feature row's unknown size, which is NULL).
 */
async function bestEffortChangelog(
  ctx: ToolContext,
  article: { id: string; title: string; content?: string },
  kind: 'create' | 'update',
  message: string,
  charsBefore: number | null | undefined,
) {
  try {
    await appendWikiChangelog(ctx.adminClient, ctx.userId, {
      article_id: article.id,
      kind,
      title_at_change: article.title,
      message,
      chars_before: kind === 'create' ? 0 : charsBefore ?? undefined,
      chars_after: article.content?.length,
    });
  } catch {
    // best-effort; see comment above.
  }
}

/**
 * Best-effort source attribution. ctx.threadId (when non-empty) is
 * trusted directly - the agent is processing the user's own claimed
 * thread. source_thread_ids are validated against the user's threads
 * so a fabricated id can't land. The save itself already succeeded; a
 * failed attach just means the bibliography misses a row, which is
 * much smaller damage than failing the whole call and surfacing a
 * confusing error to a model that already wrote the right prose.
 */
async function bestEffortSources(
  ctx: ToolContext,
  articleId: string,
  args: Record<string, unknown>,
) {
  const sourceIds = new Set<string>();
  if (ctx.threadId) sourceIds.add(ctx.threadId);
  const candidate = collectSourceThreadIds(args);
  if (candidate.length > 0) {
    const known = await findExistingThreadIds(ctx.adminClient, ctx.userId, candidate);
    for (const tid of candidate) {
      if (known.has(tid)) sourceIds.add(tid);
    }
  }
  if (sourceIds.size === 0) return;
  try {
    await attachWikiArticleSources(ctx.adminClient, articleId, [...sourceIds]);
  } catch {
    // best-effort; see comment above.
  }
}

async function doCreate(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<unknown> {
  const title = (args.title as string).trim();
  const content = args.content as string;
  const message = (args.message as string).trim();

  // The model may have forgotten the id of the article it meant to
  // edit; the natural-key heuristic routes an exact-title match to
  // that article's update path instead of bouncing with 23505.
  // RLS OFF: the query filters by user_id explicitly - service-role
  // bypasses RLS.
  const match = await resolveNaturalKeyMatch({
    query: async (probeValue: string) => {
      const { data, error } = await ctx.adminClient
        .from('wiki_articles')
        .select('id, title as key')
        .eq('user_id', ctx.userId)
        .ilike('title', probeValue)
        .limit(3);
      if (error) throw new Error(`naturalKeyProbe failed: ${error.message}`);
      return {
        data: (data ?? null) as unknown as { id: string; key: string }[] | null,
      };
    },
    keyValue: title,
    fuzzy: true,
  });
  if (match) {
    const prior = await assertNotLocked(ctx, match.id, match.key);
    const row = await updateArticle(ctx, match.id, {
      ...(title ? { title } : {}),
      ...(content ? { content } : {}),
    });
    await bestEffortChangelog(ctx, row, 'update', message, prior.contentLength);
    await bestEffortSources(ctx, row.id, args);
    return { ...row, matched_existing: true };
  }

  const row = await insertArticle(ctx, title, content);
  await bestEffortChangelog(ctx, row, 'create', message, 0);
  await bestEffortSources(ctx, row.id, args);
  return row;
}

async function doUpdate(
  id: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<unknown> {
  const message = (args.message as string).trim();
  const patch: { title?: string; content?: string } = {};
  if (typeof args.title === 'string' && args.title.trim().length > 0) {
    patch.title = args.title.trim();
  }
  if (typeof args.content === 'string' && args.content.length > 0) {
    patch.content = args.content;
  }

  // Read the prior content length and favorite flag before the
  // update so the changelog can stamp chars_before and the lock guard
  // can refuse the write.
  const prior = await assertNotLocked(ctx, id, id);
  const row = await updateArticle(ctx, id, patch);
  await bestEffortChangelog(ctx, row, 'update', message, prior.contentLength);
  await bestEffortSources(ctx, row.id, args);
  return row;
}

export const wikiSave = {
  name: 'wiki_save',
  async execute(args: Record<string, unknown>, ctx: ToolContext) {
    const id =
      typeof args.id === 'string' && args.id.trim().length > 0
        ? args.id.trim()
        : undefined;
    // Shared pre-route validation: message is always required; the
    // create/update field split is conditional on the id, which the
    // central JSON-Schema validator cannot express.
    const errs = new ArgErrors();
    const message = typeof args.message === 'string' ? args.message.trim() : '';
    if (!message) errs.add('message is required');
    else if (message.length > MAX_WIKI_CHANGELOG_MESSAGE_CHARS) {
      errs.add(
        `message exceeds ${MAX_WIKI_CHANGELOG_MESSAGE_CHARS}-char limit (got ${message.length})`,
      );
    }
    if (typeof args.title === 'string' && args.title.length > MAX_WIKI_TITLE_CHARS) {
      errs.add(`title exceeds ${MAX_WIKI_TITLE_CHARS}-char limit (got ${args.title.length})`);
    }
    if (typeof args.content === 'string' && args.content.length > MAX_WIKI_CONTENT_CHARS) {
      errs.add(
        `content exceeds ${MAX_WIKI_CONTENT_CHARS}-char limit (got ${args.content.length}); split or trim`,
      );
    }
    if (!id) {
      if (!args.title || (typeof args.title === 'string' && args.title.trim().length === 0)) {
        errs.add('title is required when creating (omit id or pass one from wiki_search)');
      }
      if (!args.content || (typeof args.content === 'string' && args.content.length === 0)) {
        errs.add('content is required when creating');
      }
    } else if (
      (args.title === undefined || args.title === null) &&
      (args.content === undefined || args.content === null)
    ) {
      errs.add('id was given but nothing to change - provide title and/or content');
    }
    errs.throwIfAny();

    if (id) return doUpdate(id, args, ctx);
    return doCreate(args, ctx);
  },
};

registerTool(wikiSave);
