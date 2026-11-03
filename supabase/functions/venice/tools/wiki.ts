// wiki (function-side combination tool)
//
// One tool behind an `op` enum discriminator: search / list / get /
// save / delete over the user's wiki articles. Replaces the five
// wiki_search / wiki_list / wiki_get / wiki_save / wiki_delete verb
// registrations; the per-op bodies survive verbatim as internal
// functions - only the envelope changed (see the browser schema's
// header).
//
// Auth: b-strict throughout. wiki_articles has user_id directly, so
// every read filters .eq('user_id', userId), every write stamps it,
// and the miss-vs-not-owned branches are indistinguishable to a
// probing caller.
//
// save is the create/update-merged upsert (the former wiki_save;
// itself a consolidation of wiki_create + wiki_update): natural-key
// dedup on the unique title, the favorite-lock refusal for agent
// edits, best-effort changelog + source attribution (both
// best-effort on purpose - the article is already saved; a failed
// attach is a smaller harm than failing the call).
//
// delete carries the favorite lock too, plus the pre-delete
// title/content-length snapshot that keeps the changelog row
// readable after the article is gone.
//
// Per-op required fields (query on search, id on get/delete,
// message on save/delete, title + content on create) are enforced
// inside the per-op bodies below - the flat wire schema cannot
// express them. Error strings are load-bearing: substring test
// assertions pin them (tests/wiki.test.ts ports).

import { registerTool, type ToolContext, type ToolDef } from '../performToolCall.ts';
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
import { padEmbeddingForStorage } from '../../_shared/backfill.ts';
import { localEmbed } from '../../_shared/local-embed.ts';

// Mirror of WIKI_SEARCH / WIKI_LIST limits in the wire schema.
const WIKI_SEARCH_DEFAULT_LIMIT = 5;
const WIKI_SEARCH_MAX_LIMIT = 20;
const WIKI_LIST_DEFAULT_LIMIT = 100;
const WIKI_LIST_MAX_LIMIT = 500;
const WIKI_LIST_EXCERPT_CHARS = 200;

interface WikiHit {
  id: string;
  title: string;
  content: string;
  favorite: boolean;
  created_at: string;
  updated_at: string;
  similarity: number;
}

// ---------------------------------------------------------------------------
// search
// ---------------------------------------------------------------------------

async function searchOp(args: Record<string, unknown>, ctx: ToolContext) {
  const query = typeof args.query === 'string' ? args.query.trim() : '';
  if (!query) throw new Error('query is required');

  const rawLimit =
    typeof args.limit === 'number' ? args.limit : WIKI_SEARCH_DEFAULT_LIMIT;
  const limit = Math.max(
    1,
    Math.min(WIKI_SEARCH_MAX_LIMIT, Math.floor(rawLimit)),
  );

  let queryEmbedding: number[] | null = null;
  try {
    const raw = await localEmbed(query);
    if (raw.length > 0) queryEmbedding = padEmbeddingForStorage(raw);
  } catch {
    return [];
  }
  if (!queryEmbedding) return [];

  // RLS OFF: p_user_id stamps the vector search to the caller.
  const { data, error } = await ctx.adminClient.rpc(
    'search_wiki_articles_by_embedding',
    {
      query_embedding: queryEmbedding,
      match_limit: limit,
      p_user_id: ctx.userId,
    },
  );
  if (error) throw new Error(`searchWikiArticles failed: ${error.message}`);
  return (data ?? []) as WikiHit[];
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

async function listOp(args: Record<string, unknown>, ctx: ToolContext) {
  const rawLimit =
    typeof args.limit === 'number' ? args.limit : WIKI_LIST_DEFAULT_LIMIT;
  const limit = Math.max(
    1,
    Math.min(WIKI_LIST_MAX_LIMIT, Math.floor(rawLimit)),
  );

  // RLS OFF: filter by userId. wiki_articles.user_id is the
  // direct ownership column; service-role would otherwise see
  // every user's wiki.
  const { data, error } = await ctx.adminClient
    .from('wiki_articles')
    .select('id, title, content, favorite')
    .eq('user_id', ctx.userId)
    .order('title', { ascending: true })
    .limit(limit);
  if (error) throw new Error(`listWikiArticles failed: ${error.message}`);

  return (data ?? []).map((a) => ({
    id: a.id as string,
    title: a.title as string,
    excerpt: typeof a.content === 'string' ? a.content.slice(0, WIKI_LIST_EXCERPT_CHARS) : '',
    favorite: (a as { favorite?: boolean }).favorite === true,
  }));
}

// ---------------------------------------------------------------------------
// get
// ---------------------------------------------------------------------------

async function getOp(args: Record<string, unknown>, ctx: ToolContext) {
  const id = typeof args.id === 'string' ? args.id.trim() : '';
  if (!id) throw new Error('id is required');

  // RLS OFF: filter by userId. user_id eq, then id eq, so the
  // miss-vs-not-owned branches are indistinguishable to a probing
  // caller - matches RLS behavior on the browser path.
  const { data, error } = await ctx.adminClient
    .from('wiki_articles')
    .select('id, title, content, favorite, created_at, updated_at')
    .eq('user_id', ctx.userId)
    .eq('id', id)
    .maybeSingle();
  if (error) throw new Error(`getWikiArticleById failed: ${error.message}`);
  if (!data) return { found: false };

  return {
    found: true,
    article: {
      id: data.id as string,
      title: data.title as string,
      content: data.content as string,
      favorite: (data as { favorite?: boolean }).favorite === true,
      created_at: data.created_at as string,
      updated_at: data.updated_at as string,
    },
  };
}

// ---------------------------------------------------------------------------
// save
// ---------------------------------------------------------------------------

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
        `An article titled "${title}" already exists. Run the wiki tool (op=search) to find its id, then call op=save with that id to integrate.`,
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
  // bypasses RLS. PostgREST select strings cannot carry `AS` aliases
  // (42703 "column does not exist"), so the probe selects the bare
  // column and the caller re-shapes it into {id, key}.
  const match = await resolveNaturalKeyMatch({
    query: async (probeValue: string) => {
      // The probe pattern is wrapped in % so the SQL side pre-filters
      // by containment; without the wildcards a bare ilike only
      // matches the exact string, and a near-match ("QA Kombucha"
      // vs "QA Kombucha Brewing") would be invisible to the probe -
      // the fuzzy branch would never see it.
      const { data, error } = await ctx.adminClient
        .from('wiki_articles')
        .select('id, title')
        .eq('user_id', ctx.userId)
        .ilike('title', `%${probeValue}%`)
        .limit(3);
      if (error) throw new Error(`naturalKeyProbe failed: ${error.message}`);
      const rows = (data ?? []) as { id: string; title: string }[];
      return {
        data: rows.map((r) => ({ id: r.id, key: r.title })),
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

async function saveOp(args: Record<string, unknown>, ctx: ToolContext) {
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
      errs.add('title is required when creating (omit id or pass one from the search op)');
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
}

// ---------------------------------------------------------------------------
// delete
// ---------------------------------------------------------------------------

async function deleteOp(args: Record<string, unknown>, ctx: ToolContext) {
  const id = typeof args.id === 'string' ? args.id : '';
  const message = typeof args.message === 'string' ? args.message.trim() : '';

  const errs = new ArgErrors();
  if (!id) errs.add('id is required');
  if (!message) errs.add('message is required');
  else if (message.length > MAX_WIKI_CHANGELOG_MESSAGE_CHARS) {
    errs.add(
      `message exceeds ${MAX_WIKI_CHANGELOG_MESSAGE_CHARS}-char limit (got ${message.length})`,
    );
  }
  errs.throwIfAny();

  // Capture the title AND content length BEFORE the delete so the
  // changelog row can carry a meaningful title_at_change snapshot
  // and a chars_before. The FK on wiki_changelog.article_id is ON
  // DELETE SET NULL - without the snapshot we'd lose both the link
  // AND the title. A missing article (the model called delete on a
  // stale id) skips the changelog write; the delete itself is
  // already a no-op against a non-existent row.
  // Also checks the agent-edit lock: a favorited article cannot be
  // deleted by the agent. The user's own direct delete through the
  // UI (RLS, not this tool) is unaffected.
  const { data: existing, error: readErr } = await ctx.adminClient
    .from('wiki_articles')
    .select('id, title, content, favorite')
    .eq('id', id)
    .eq('user_id', ctx.userId)
    .maybeSingle();
  if (readErr) throw new Error(`getWikiArticleById failed: ${readErr.message}`);

  if (existing && (existing as { favorite?: boolean }).favorite === true) {
    throw new Error(
      'This article is favorited (locked) and cannot be deleted by the agent. ' +
        'The user must remove the favorite star before agent deletes are allowed.',
    );
  }

  // .select('id') makes a zero-row match detectable so the result
  // can distinguish "deleted" from "nothing matched" (see
  // memory_delete.ts for the same change).
  const { data, error: delErr } = await ctx.adminClient
    .from('wiki_articles')
    .delete()
    .eq('id', id)
    .eq('user_id', ctx.userId)
    .select('id');
  if (delErr) throw new Error(`deleteWikiArticle failed: ${delErr.message}`);
  const deleted = Array.isArray(data) && data.length > 0;
  if (!deleted) {
    return {
      id,
      deleted: false,
      reason: 'No wiki article with that id - already deleted, never existed, or not yours.',
    };
  }

  if (existing) {
    try {
      await appendWikiChangelog(ctx.adminClient, ctx.userId, {
        // article_id is intentionally null - the article is gone by
        // the time this lands, so retaining its id would point at
        // nothing. The title snapshot is what makes the row
        // readable.
        article_id: null,
        kind: 'delete',
        title_at_change: (existing as { title: string }).title,
        message,
        // 0 after, not undefined: the body is genuinely gone.
        chars_before: (existing as { content?: string }).content?.length,
        chars_after: 0,
      });
    } catch {
      // best-effort; see the matching comment in the save op.
    }
  }

  return { id, deleted: true };
}

// ---------------------------------------------------------------------------
// combination-tool envelope
// ---------------------------------------------------------------------------

export const wiki: ToolDef = {
  name: 'wiki',
  async execute(args: Record<string, unknown>, ctx: ToolContext) {
    const op = typeof args.op === 'string' ? args.op.trim() : '';
    if (!op) {
      throw new Error('op is required (search | list | get | save | delete)');
    }
    switch (op) {
      case 'search':
        return searchOp(args, ctx);
      case 'list':
        return listOp(args, ctx);
      case 'get':
        return getOp(args, ctx);
      case 'save':
        return saveOp(args, ctx);
      case 'delete':
        return deleteOp(args, ctx);
      default:
        throw new Error(
          `unknown op "${op}" - expected search, list, get, save, or delete`,
        );
    }
  },
};

registerTool(wiki);
