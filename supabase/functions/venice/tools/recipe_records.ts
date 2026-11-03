// recipe_records (function-side combination tool)
//
// One tool behind an `op` enum discriminator: list / get / search /
// create / update / delete over the recipe cooking log. Replaces the
// six recipe_record_* verb registrations; the per-op bodies survive
// verbatim as internal functions - only the envelope changed (see the
// browser schema's header for the combo rationale).
//
// Auth: b-strict throughout. recipe_records has user_id directly, so
// every read filters .eq('user_id', userId), every write stamps
// user_id, and the create verifies the parent recipe is the caller's
// before inserting a child row (the admin client bypasses RLS).
//
// The update op's outcome field carries THREE states: absent leaves
// the column alone, an explicit null clears the classification, a
// valid enum member sets it. The wire schema names the spurious-null
// hazard; this handler is what keeps the states distinct.
//
// The search op's two legs always run (semantic RPC + ILIKE
// substring), merged semantic-first and deduped by id; embedder or
// RPC failure degrades to ILIKE-only rather than returning empty -
// the deliberate divergence from the wiki record search, which goes
// quiet while embedding is down. A blank result here means genuinely
// nothing matched.
//
// Per-op required fields (recipe_id + date + content on create, id
// on get/update/delete, query on search) are enforced inside the
// per-op bodies below - the flat wire schema cannot express them.
// Error strings are load-bearing: substring test assertions pin
// them (tests/recipe_record_tools.test.ts ports).

import { registerTool, type ToolContext, type ToolDef } from '../performToolCall.ts';
import { padEmbeddingForStorage } from '../../_shared/backfill.ts';
import { localEmbed } from '../../_shared/local-embed.ts';
import { ArgErrors } from './_validate.ts';
import {
  MAX_RECIPE_RECORD_CONTENT_CHARS,
  RECIPE_RECORD_COLUMNS,
  isRecipeRecordOutcome,
  getOwnedRecipeTitle,
  normalizeRecipeRecordDate,
  normalizeRecipeRecordTags,
  recipeRecordPreview,
} from './_recipe_record_helpers.ts';

// Mirror of RECIPE_LIST limits - the record log's own caps.
const RECIPE_RECORD_LIST_DEFAULT_LIMIT = 50;
const RECIPE_RECORD_LIST_MAX_LIMIT = 200;
const RECIPE_RECORD_SEARCH_DEFAULT_LIMIT = 10;
const RECIPE_RECORD_SEARCH_MAX_LIMIT = 30;

// ILIKE pattern helper for a standalone .ilike() filter. Mirrors the
// file-local helper in recipes.ts (formerly recipe_list.ts): escape
// ILIKE metacharacters in the user input, then wrap in %...%. Do NOT
// swap in the double-quoted logic-tree builder here - see
// recipe_record_search.ts's file preamble for why the quotes would
// kill this leg.
function ilikeFilterPattern(raw: string): string {
  return `%${raw.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
}

interface RecordHit {
  id: string;
  recipe_id: string;
  date: string;
  content: string;
  tags: unknown;
  outcome: string | null;
  similarity: number | null;
}

// The ILIKE leg's select (RECIPE_RECORD_COLUMNS) returns the record
// columns only - similarity comes from the RPC leg alone.
type IlikeRow = Omit<RecordHit, 'similarity'>;

// One dedup-payload entry: date + id + a short preview, not the full
// body - it rides every create call.
function previewEntry(row: unknown): {
  id: string;
  date: string;
  content_preview: string;
} {
  const r = row as { id: string; date: string; content: string };
  return {
    id: String(r.id),
    date: String(r.date),
    content_preview: recipeRecordPreview(r.content ?? ''),
  };
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

async function listOp(args: Record<string, unknown>, ctx: ToolContext) {
  const recipeId = typeof args.recipe_id === 'string' ? args.recipe_id.trim() : '';
  if (!recipeId) throw new Error('recipe_id is required');

  const fromDate = normalizeRecipeRecordDate(args.from_date).date;
  const toDate = normalizeRecipeRecordDate(args.to_date).date;
  const tags = Array.isArray(args.tags)
    ? args.tags.filter((t): t is string => typeof t === 'string')
    : [];
  // A malformed outcome is a soft facet on a read - ignore it rather
  // than fail the listing (the dispatcher's schema enum check is the
  // strict gate).
  const outcome = isRecipeRecordOutcome(args.outcome) ? args.outcome : null;
  const limit =
    typeof args.limit === 'number' && args.limit > 0
      ? Math.min(Math.floor(args.limit), RECIPE_RECORD_LIST_MAX_LIMIT)
      : RECIPE_RECORD_LIST_DEFAULT_LIMIT;

  let query = ctx.adminClient
    .from('recipe_records')
    .select(RECIPE_RECORD_COLUMNS)
    .eq('user_id', ctx.userId)
    .eq('recipe_id', recipeId)
    .order('date', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(limit);
  if (fromDate) query = query.gte('date', fromDate);
  if (toDate) query = query.lte('date', toDate);
  // JSON.stringify is load-bearing: `tags` is jsonb, and a raw JS
  // array serializes as a Postgres array literal (`cs.{a}`), which
  // PostgREST rejects against jsonb with a 400. Same fix as the
  // browser data layers (found by the recipe QA run).
  if (tags.length > 0) query = query.contains('tags', JSON.stringify(tags));
  if (outcome) query = query.eq('outcome', outcome);

  const { data, error } = await query;
  if (error) throw new Error(`listRecipeRecords failed: ${error.message}`);
  return { records: data ?? [] };
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
    .from('recipe_records')
    .select(RECIPE_RECORD_COLUMNS)
    .eq('user_id', ctx.userId)
    .eq('id', id)
    .maybeSingle();
  if (error) throw new Error(`getRecipeRecord failed: ${error.message}`);
  if (!data) return { found: false };
  return { found: true, record: data };
}

// ---------------------------------------------------------------------------
// search
// ---------------------------------------------------------------------------

async function searchOp(args: Record<string, unknown>, ctx: ToolContext) {
  const query = typeof args.query === 'string' ? args.query.trim() : '';
  if (!query) throw new Error('query is required');
  const recipeId =
    typeof args.recipe_id === 'string' && args.recipe_id.trim().length > 0
      ? args.recipe_id.trim()
      : null;
  const outcome = isRecipeRecordOutcome(args.outcome) ? args.outcome : null;
  const rawLimit =
    typeof args.limit === 'number' ? args.limit : RECIPE_RECORD_SEARCH_DEFAULT_LIMIT;
  const limit = Math.max(
    1,
    Math.min(RECIPE_RECORD_SEARCH_MAX_LIMIT, Math.floor(rawLimit)),
  );

  // Embed the query. Embedder failure degrades to ILIKE-only rather
  // than returning empty - the deliberate divergence from the wiki
  // twin named in the file preamble.
  let queryEmbedding: number[] | null = null;
  try {
    const raw = await localEmbed(query);
    if (raw.length > 0) queryEmbedding = padEmbeddingForStorage(raw);
  } catch {
    queryEmbedding = null;
  }

  // ILIKE leg. RLS OFF: explicit user_id filter on recipe_records.
  let ilikeQuery = ctx.adminClient
    .from('recipe_records')
    .select(RECIPE_RECORD_COLUMNS)
    .eq('user_id', ctx.userId);
  if (recipeId) ilikeQuery = ilikeQuery.eq('recipe_id', recipeId);
  if (outcome) ilikeQuery = ilikeQuery.eq('outcome', outcome);
  const ilikePromise = ilikeQuery
    .ilike('content', ilikeFilterPattern(query))
    .order('date', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(limit);

  // Semantic leg: the RPC filters recipe_id + outcome internally,
  // before the limit.
  const semanticPromise = queryEmbedding
    ? ctx.adminClient.rpc('search_recipe_records_by_embedding', {
        query_embedding: queryEmbedding,
        match_limit: limit,
        p_user_id: ctx.userId,
        p_recipe_id: recipeId,
        p_outcome: outcome,
      })
    : Promise.resolve({ data: [] as unknown[], error: null });

  const [ilikeRes, semRes] = await Promise.all([ilikePromise, semanticPromise]);
  if (ilikeRes.error) {
    throw new Error(`searchRecipeRecords (ilike) failed: ${ilikeRes.error.message}`);
  }
  // An RPC failure still yields the ILIKE hits - same degradation
  // posture as the embedder being down.
  const semanticRows = semRes.error ? [] : ((semRes.data ?? []) as RecordHit[]);
  // The ILIKE select carries no similarity column.
  const ilikeRows = ((ilikeRes.data ?? []) as IlikeRow[]).map((r) => ({
    ...r,
    // ILIKE rows carry no similarity; null keeps the field present
    // so the payload shape is stable across hits.
    similarity: null,
  }));

  // Merge: semantic first, then ILIKE hits the vector path missed,
  // deduped by id, capped at limit (the browser merge's shape).
  const out: RecordHit[] = [];
  const seen = new Set<string>();
  for (const hit of [...semanticRows, ...ilikeRows]) {
    if (seen.has(hit.id)) continue;
    seen.add(hit.id);
    out.push(hit);
    if (out.length >= limit) break;
  }
  return {
    records: out.map((r) => ({
      id: r.id,
      recipe_id: r.recipe_id,
      date: r.date,
      content: r.content,
      tags: r.tags,
      outcome: r.outcome,
      similarity: r.similarity,
    })),
  };
}

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------

async function createOp(args: Record<string, unknown>, ctx: ToolContext) {
  const recipeId = typeof args.recipe_id === 'string' ? args.recipe_id.trim() : '';
  const content = typeof args.content === 'string' ? args.content : '';
  const { date, error: dateErr } = normalizeRecipeRecordDate(args.date);
  const tags = normalizeRecipeRecordTags(args.tags);

  const errs = new ArgErrors();
  if (!recipeId) errs.add('recipe_id is required');
  if (!date) errs.add(dateErr ?? 'date is required (ISO "YYYY-MM-DD")');
  if (!content) errs.add('content is required');
  else if (content.length > MAX_RECIPE_RECORD_CONTENT_CHARS) {
    errs.add(
      `content exceeds ${MAX_RECIPE_RECORD_CONTENT_CHARS}-char limit (got ${content.length}); split or trim`,
    );
  }
  // Absent and null both mean "not classified" on a create - there is
  // nothing to clear yet. Only a present, non-null value must be a
  // valid enum member.
  let outcome: string | null = null;
  if (args.outcome !== undefined && args.outcome !== null) {
    if (isRecipeRecordOutcome(args.outcome)) outcome = args.outcome;
    else errs.add('outcome must be one of success, mixed, failure');
  }
  errs.throwIfAny();

  // Verify the recipe belongs to the caller before inserting a child
  // row - the admin client bypasses RLS, so without this a record
  // could be parented to another user's recipe.
  const recipeTitle = await getOwnedRecipeTitle(ctx.adminClient, ctx.userId, recipeId);
  if (recipeTitle === null) {
    throw new Error(
      `No recipe with id "${recipeId}" found for this user. Run recipe_list to find a valid recipe id.`,
    );
  }

  const { data: row, error } = await ctx.adminClient
    .from('recipe_records')
    .insert({
      user_id: ctx.userId,
      recipe_id: recipeId,
      date,
      content,
      tags,
      outcome,
      source_conversation_id: ctx.threadId ?? null,
    })
    .select(RECIPE_RECORD_COLUMNS)
    .single();
  if (error) throw new Error(`createRecipeRecord failed: ${error.message}`);
  const created = row as { id: string; date: string };

  // Dedup payload - best effort. A failure here must not fail the
  // record write - the row already landed; an empty payload just
  // costs the model its free duplicate look.
  let sameDateSiblings: ReturnType<typeof previewEntry>[] = [];
  let mostRecentPrior: ReturnType<typeof previewEntry> | null = null;
  try {
    const [sibRes, priorRes] = await Promise.all([
      ctx.adminClient
        .from('recipe_records')
        .select('id, date, content')
        .eq('user_id', ctx.userId)
        .eq('recipe_id', recipeId)
        .eq('date', created.date)
        .neq('id', created.id),
      ctx.adminClient
        .from('recipe_records')
        .select('id, date, content')
        .eq('user_id', ctx.userId)
        .eq('recipe_id', recipeId)
        .lt('date', created.date)
        .order('date', { ascending: false })
        .order('created_at', { ascending: false })
        .limit(1),
    ]);
    if (sibRes.error) throw new Error(sibRes.error.message);
    if (priorRes.error) throw new Error(priorRes.error.message);
    sameDateSiblings = ((sibRes.data ?? []) as unknown[]).map(previewEntry);
    const prior = (priorRes.data ?? []) as unknown[];
    mostRecentPrior = prior.length > 0 ? previewEntry(prior[0]) : null;
  } catch {
    // swallow - the dedup payload is a convenience, the record is
    // the truth.
  }

  return {
    record: row,
    same_date_siblings: sameDateSiblings,
    most_recent_prior: mostRecentPrior,
  };
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
    const { date, error } = normalizeRecipeRecordDate(args.date);
    if (error) errs.add(error);
    else if (date) patch.date = date;
  }
  if ('content' in args && args.content !== undefined && args.content !== null) {
    const content = typeof args.content === 'string' ? args.content : '';
    if (!content) errs.add('content cannot be empty');
    else if (content.length > MAX_RECIPE_RECORD_CONTENT_CHARS) {
      errs.add(
        `content exceeds ${MAX_RECIPE_RECORD_CONTENT_CHARS}-char limit (got ${content.length})`,
      );
    } else patch.content = content;
  }
  if ('tags' in args && args.tags !== undefined && args.tags !== null) {
    patch.tags = normalizeRecipeRecordTags(args.tags);
  }
  if ('outcome' in args && args.outcome !== undefined) {
    if (args.outcome === null) patch.outcome = null;
    else if (isRecipeRecordOutcome(args.outcome)) patch.outcome = args.outcome;
    else errs.add('outcome must be one of success, mixed, failure (or null to clear)');
  }
  if (Object.keys(patch).length === 0) {
    errs.add('nothing to update - pass at least one of date, content, tags, outcome');
  }
  errs.throwIfAny();

  const { data: row, error } = await ctx.adminClient
    .from('recipe_records')
    .update(patch)
    .eq('user_id', ctx.userId)
    .eq('id', id)
    .select(RECIPE_RECORD_COLUMNS)
    .maybeSingle();
  if (error) throw new Error(`updateRecipeRecord failed: ${error.message}`);
  if (!row) throw new Error(`No record with id "${id}" found for this user.`);
  return row;
}

// ---------------------------------------------------------------------------
// delete
// ---------------------------------------------------------------------------

async function deleteOp(args: Record<string, unknown>, ctx: ToolContext) {
  const id = typeof args.id === 'string' ? args.id.trim() : '';
  if (!id) throw new Error('id is required');

  const { data, error } = await ctx.adminClient
    .from('recipe_records')
    .delete()
    .eq('user_id', ctx.userId)
    .eq('id', id)
    .select('id');
  if (error) throw new Error(`deleteRecipeRecord failed: ${error.message}`);
  const deleted = Array.isArray(data) && data.length > 0;
  if (!deleted) {
    return {
      deleted,
      reason: 'No cooking record with that id - already deleted, never existed, or not yours.',
    };
  }
  return { deleted };
}

// ---------------------------------------------------------------------------
// combination-tool envelope
// ---------------------------------------------------------------------------

export const recipeRecords: ToolDef = {
  name: 'recipe_records',
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

registerTool(recipeRecords);
