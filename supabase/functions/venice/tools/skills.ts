// skills (function-side combination tool)
//
// One tool behind an `op` enum discriminator: list / get / search /
// save / delete over the user's saved skills (reusable task
// guidance). The combination form is the deliberate design; see the
// wire schema's header (src/lib/tools/skills.schema.ts) for the
// calibration record and the enum-vs-oneOf rationale.
//
// Auth: b-strict throughout. The service-role admin client bypasses
// RLS, so every query stamps user_id on inserts and filters
// user_id on reads, updates, and deletes (the wiki_save preamble
// pattern). A foreign or unknown id matches zero rows and the miss
// is reported honestly - indistinguishable from "never existed",
// matching what RLS would show the browser path.
//
// Tool writes stamp last_author = 'assistant' (browser panel writes
// stamp 'user'), which is the whole per-row edit trail in v1.
// updated_at is NEVER set on this path: the schema's
// touch_skill_updated_at trigger owns it on every UPDATE, making the
// trigger the single source of truth across both write surfaces -
// an explicit stamp here would be dead weight the trigger
// overwrites anyway.
//
// Natural-key dedup on save: names are unique per user (unique
// (user_id, lower(name))). A create whose name exactly matches an
// existing skill (case-insensitive) routes to that skill's update;
// a near match (containment either way - "release-notes" vs
// "release-notes-v2") is refused with the candidates named, so a
// slug-ish name neither silently merges nor silently duplicates.
// Both halves ride the shared resolveNaturalKeyMatch helper
// (_upsert_heuristics.ts, fuzzy: true) - the same contract
// wiki_save implements.
//
// delete is an irreversible hard-delete placed in the model's hands
// by deliberate product decision: a wrong skill is not evidence to
// preserve (unlike memories, where agents only decay confidence),
// and the model deleting its own wrong skill is the system working.

import { registerTool, type ToolContext, type ToolDef } from '../performToolCall.ts';
import { ArgErrors } from './_validate.ts';
import { resolveNaturalKeyMatch } from './_upsert_heuristics.ts';
import { ilikeLogicTreePattern } from '../../_shared/ilike-pattern.ts';
import {
  MAX_SKILL_NAME_CHARS,
  MAX_SKILL_DESCRIPTION_CHARS,
  MAX_SKILL_BODY_CHARS,
} from '../../_shared/skills-limits.ts';

// The body-less projection list and search return: bodies load only
// through get, so a broad list or search never dumps every body into
// context. This is a decided contract, not an optimization - a
// search hit carries name + description, which is enough to judge
// relevance without a get round trip.
const SKILL_LIST_SELECT = 'id, name, description, updated_at, last_author';

const SKILL_FULL_SELECT =
  'id, name, description, body, last_author, created_at, updated_at';

// Tool results land wholesale in the model's context, so the search
// sweep has to stay cheap: 20 name + description hits is enough for
// the model to pick a get target. A larger limit would not remove
// the cap - results would just stop at a different point.
const SKILL_SEARCH_LIMIT = 20;

const VALID_OPS = ['list', 'get', 'search', 'save', 'delete'] as const;

interface SkillRow {
  id: string;
  name: string;
  description: string;
  body: string;
  last_author: string;
  created_at: string;
  updated_at: string;
}

interface SkillSummaryRow {
  id: string;
  name: string;
  description: string;
  updated_at: string;
  last_author: string;
}

function strArg(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

// ILIKE treats % _ and backslash as pattern metacharacters, so any
// caller-supplied text bound into a pattern must be escaped first -
// otherwise a literal percent in a skill name widens the match (the
// recipe_record_search escape idiom).
function escapeIlikeLiteral(value: string): string {
  return value.replace(/[\\%_]/g, (m) => `\\${m}`);
}

/**
 * Exact case-insensitive lookup of one skill by name - the same
 * lower(name) comparison the unique index enforces. ILIKE is
 * case-insensitive, and the pattern carries no wildcards because the
 * ILIKE metacharacters (% _ backslash) are escaped, so a literal
 * percent in a skill name cannot mis-match (the recipe_record_search
 * escape idiom). B-strict: filters user_id.
 */
async function findSkillByName(
  ctx: ToolContext,
  name: string,
): Promise<SkillRow | null> {
  const pattern = escapeIlikeLiteral(name);
  const { data, error } = await ctx.adminClient
    .from('skills')
    .select(SKILL_FULL_SELECT)
    .eq('user_id', ctx.userId)
    .ilike('name', pattern)
    .maybeSingle();
  if (error) throw new Error(`skills get by name failed: ${error.message}`);
  return ((data ?? null) as SkillRow | null);
}

async function listOp(ctx: ToolContext): Promise<unknown> {
  // RLS OFF: the user_id filter scopes the projection to the owner.
  // name asc mirrors the browser index fetch, so the tool's overflow
  // drill-down reads in the same order the per-turn index capped.
  const { data, error } = await ctx.adminClient
    .from('skills')
    .select(SKILL_LIST_SELECT)
    .eq('user_id', ctx.userId)
    .order('name', { ascending: true });
  if (error) throw new Error(`skills list failed: ${error.message}`);
  return { skills: (data ?? []) as SkillSummaryRow[] };
}

async function getOp(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<unknown> {
  const id = strArg(args.id);
  const name = strArg(args.name);
  // id wins when both arrive: it is unambiguous, where a name could
  // be one the model half-remembers.
  let row: SkillRow | null = null;
  if (id) {
    // RLS OFF: user_id + id filters; a foreign id reads as a miss.
    const { data, error } = await ctx.adminClient
      .from('skills')
      .select(SKILL_FULL_SELECT)
      .eq('user_id', ctx.userId)
      .eq('id', id)
      .maybeSingle();
    if (error) throw new Error(`skills get failed: ${error.message}`);
    row = (data ?? null) as SkillRow | null;
  } else if (name) {
    row = await findSkillByName(ctx, name);
  }
  // The honest miss shape memory_get uses: the model can distinguish
  // "no such skill" from a transport error and react (op=list)
  // instead of retrying the same lookup.
  if (!row) return { found: false };
  return { found: true, skill: row };
}

async function searchOp(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<unknown> {
  const query = strArg(args.query);
  // The QUOTED logic-tree builder, not a hand-rolled pattern: an
  // unquoted comma in the query splits the PostgREST .or tree and
  // fails the whole request (see _shared/ilike-pattern.ts).
  const pattern = ilikeLogicTreePattern(query);
  // RLS OFF: user_id filter; the select carries no body column.
  const { data, error } = await ctx.adminClient
    .from('skills')
    .select(SKILL_LIST_SELECT)
    .eq('user_id', ctx.userId)
    .or(`name.ilike.${pattern},description.ilike.${pattern},body.ilike.${pattern}`)
    .order('name', { ascending: true })
    .limit(SKILL_SEARCH_LIMIT);
  if (error) throw new Error(`skills search failed: ${error.message}`);
  return { skills: (data ?? []) as SkillSummaryRow[] };
}

/**
 * PostgREST's error wrapper does not carry a stable code field on
 * every path, so the duplicate sniff matches the code AND the
 * message text. Shared by insert and update: a raced create and a
 * rename onto another skill's name bounce off the same unique
 * (user_id, lower(name)) constraint, and both get the same
 * agent-readable rephrase - the recovery is a lookup, not a retry
 * of the same save.
 */
function duplicateSkillNameError(
  name: string,
  error: { code?: string; message: string },
): Error | null {
  if (
    error.code !== '23505' &&
    !/duplicate key|unique constraint|23505/i.test(error.message)
  ) {
    return null;
  }
  return new Error(
    `A skill named "${name}" already exists. Run op=list (or op=search) to find its id, then save with that id.`,
  );
}

/**
 * Patch one skill by id, returning the saved row. Never echoes a
 * stale body: the row comes from the update's own returning select,
 * so the model reads back exactly what landed. Not-found is an
 * agent-readable error (the model may hold a stale id from an early
 * index render; the error tells it how to re-find the row).
 */
async function updateSkill(
  ctx: ToolContext,
  id: string,
  patch: { name?: string; description?: string; body?: string },
): Promise<SkillRow> {
  // RLS OFF: the user_id filter scopes the patch to the owner; a
  // foreign or unknown id matches zero rows. last_author rides the
  // patch, updated_at does not (the trigger owns it - see the file
  // preamble).
  const { data, error } = await ctx.adminClient
    .from('skills')
    .update({ ...patch, last_author: 'assistant' })
    .eq('id', id)
    .eq('user_id', ctx.userId)
    .select(SKILL_FULL_SELECT)
    .maybeSingle();
  if (error) {
    // A rename onto another skill's name fires the unique
    // (user_id, lower(name)) constraint here; sniff it so the
    // save-by-id path gets the same agent-readable voice the raced
    // create does instead of a raw 23505.
    if (patch.name !== undefined) {
      const dup = duplicateSkillNameError(patch.name, error);
      if (dup) throw dup;
    }
    throw new Error(`skills update failed: ${error.message}`);
  }
  if (!data) {
    throw new Error(
      `no skill with id "${id}" - run op=list (or op=search) to find the id`,
    );
  }
  return data as SkillRow;
}

async function insertSkill(
  ctx: ToolContext,
  name: string,
  description: string,
  body: string,
): Promise<SkillRow> {
  // RLS OFF: user_id stamped on insert - service-role would
  // otherwise let the row land under any owner.
  const { data, error } = await ctx.adminClient
    .from('skills')
    .insert({ user_id: ctx.userId, name, description, body, last_author: 'assistant' })
    .select(SKILL_FULL_SELECT)
    .single();
  if (error) {
    // Reachable only when the natural-key probe raced a concurrent
    // insert - the routing above catches the common case first.
    const dup = duplicateSkillNameError(name, error);
    if (dup) throw dup;
    throw new Error(`skills create failed: ${error.message}`);
  }
  return data as SkillRow;
}

async function saveOp(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<unknown> {
  const id = strArg(args.id);
  const name = strArg(args.name);
  const description = strArg(args.description);
  // Body is NOT trimmed: markdown instructions may lean on leading
  // structure. Only its emptiness is checked on the trimmed view.
  const body = typeof args.body === 'string' ? args.body : '';

  if (id) {
    const patch: { name?: string; description?: string; body?: string } = {};
    if (name) patch.name = name;
    if (description) patch.description = description;
    if (body.trim().length > 0) patch.body = body;
    return updateSkill(ctx, id, patch);
  }

  // Create path. The model may have forgotten the id of the skill it
  // meant to edit; the natural-key heuristic routes an exact-name
  // match to that skill's update instead of bouncing with 23505.
  // The probe pattern is wrapped in % so the SQL side pre-filters by
  // containment - without the wildcards a near-match
  // ("release-notes" vs "release-notes-v2") would be invisible to
  // the probe and the fuzzy branch would never see it. The probe
  // value itself is escaped, so a literal % or _ in the requested
  // name cannot widen the candidate prefilter. RLS OFF: the query
  // filters by user_id explicitly.
  const match = await resolveNaturalKeyMatch({
    query: async (probeValue: string) => {
      const { data, error } = await ctx.adminClient
        .from('skills')
        .select('id, name')
        .eq('user_id', ctx.userId)
        .ilike('name', `%${escapeIlikeLiteral(probeValue)}%`)
        .limit(3);
      if (error) throw new Error(`skills natural-key probe failed: ${error.message}`);
      const rows = (data ?? []) as { id: string; name: string }[];
      return { data: rows.map((r) => ({ id: r.id, key: r.name })) };
    },
    keyValue: name,
    fuzzy: true,
  });
  if (match) {
    // Keep the caller's casing: an exact match on lower(name) with a
    // differently-cased name is a rename to the caller's form, which
    // is what it asked for. The ArgErrors pass above already
    // required name, description, and body non-empty on exactly
    // this path (op=save without id), so the patch is unconditional.
    const row = await updateSkill(ctx, match.id, { name, description, body });
    return { ...row, matched_existing: true };
  }

  return insertSkill(ctx, name, description, body);
}

async function deleteOp(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<unknown> {
  const id = strArg(args.id);
  const name = strArg(args.name);

  // Name resolves through the same lower(name) lookup get uses; the
  // id path goes straight to the delete.
  let targetId = id;
  if (!id && name) {
    const row = await findSkillByName(ctx, name);
    if (!row) {
      return {
        deleted: false,
        reason: `No skill named "${name}" - already deleted, never existed, or not yours.`,
      };
    }
    targetId = row.id;
  }

  // RLS OFF: user_id filter scopes the delete to the owner.
  // .select('id') makes a zero-row match detectable so the result
  // can distinguish "deleted" from "nothing matched" (the
  // wiki_delete / memory_delete shape).
  const { data, error } = await ctx.adminClient
    .from('skills')
    .delete()
    .eq('id', targetId)
    .eq('user_id', ctx.userId)
    .select('id');
  if (error) throw new Error(`skills delete failed: ${error.message}`);
  const deleted = Array.isArray(data) && data.length > 0;
  if (!deleted) {
    return {
      deleted: false,
      reason: 'No skill with that id - already deleted, never existed, or not yours.',
    };
  }
  return { deleted: true, id: targetId };
}

export const skillsTool: ToolDef = {
  name: 'skills',
  async execute(args: Record<string, unknown>, ctx: ToolContext) {
    const op = strArg(args.op);
    const id = strArg(args.id);
    const name = strArg(args.name);
    const description = strArg(args.description);
    const body = typeof args.body === 'string' ? args.body : '';
    const query = strArg(args.query);

    // Shared pre-route validation. The op-conditional required-field
    // rules cannot live in the flat JSON Schema (the central
    // validator has no per-branch view), so they are collected here
    // in one ArgErrors pass: a model that supplies several malformed
    // arguments learns the full set in a single round trip.
    const errs = new ArgErrors();
    if (!op) errs.add('op is required');
    else if (!VALID_OPS.includes(op as (typeof VALID_OPS)[number])) {
      errs.add(`op must be one of: ${VALID_OPS.join(', ')}`);
    }
    // Length limits, agent-readable with the actual length so the
    // fix is obvious (the JSON Schema maxLength covers these too;
    // this is the belt for schema-less dispatch paths).
    if (name.length > MAX_SKILL_NAME_CHARS) {
      errs.add(
        `name exceeds ${MAX_SKILL_NAME_CHARS}-char limit (got ${name.length})`,
      );
    }
    if (description.length > MAX_SKILL_DESCRIPTION_CHARS) {
      errs.add(
        `description exceeds ${MAX_SKILL_DESCRIPTION_CHARS}-char limit (got ${description.length})`,
      );
    }
    if (body.length > MAX_SKILL_BODY_CHARS) {
      errs.add(
        `body exceeds ${MAX_SKILL_BODY_CHARS}-char limit (got ${body.length}); split or trim`,
      );
    }
    if (op === 'get' && !id && !name) {
      errs.add('get requires a name or an id');
    }
    if (op === 'search' && !query) {
      errs.add('query is required for op=search');
    }
    if (op === 'save' && !id) {
      if (!name) errs.add('name is required when creating (omit id to create)');
      if (!description) errs.add('description is required when creating');
      if (body.trim().length === 0) errs.add('body is required when creating');
    } else if (
      op === 'save' &&
      !name &&
      !description &&
      body.trim().length === 0
    ) {
      errs.add('id was given but nothing to change - provide name, description, and/or body');
    }
    if (op === 'delete' && !id && !name) {
      errs.add('delete requires an id or a name');
    }
    errs.throwIfAny();

    switch (op) {
      case 'list':
        return listOp(ctx);
      case 'get':
        return getOp(args, ctx);
      case 'search':
        return searchOp(args, ctx);
      case 'save':
        return saveOp(args, ctx);
      case 'delete':
        return deleteOp(args, ctx);
      default:
        // Unreachable behind the validation above; kept so an
        // unknown op can never fall through to a silent success.
        throw new Error(
          `unknown op "${op}" - must be one of: ${VALID_OPS.join(', ')}`,
        );
    }
  },
};

registerTool(skillsTool);
