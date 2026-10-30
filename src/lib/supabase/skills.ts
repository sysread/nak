/**
 * Skills domain slice of the Supabase data layer: the body-less index
 * listing (the per-turn metadata projection), the offset-paged browse
 * list, the single-row fetch, ILIKE search over name + description +
 * body, and the create/update/delete surface.
 *
 * RLS on the skills table scopes every query to the signed-in user's
 * own rows, so these functions don't filter by user_id on
 * select/update/delete. Inserts do need to set user_id explicitly
 * (RLS checks with_check against the row, and there's no default).
 *
 * Plain async functions taking the shared SupabaseClient as their
 * first argument - no class, no state - so each can be unit-tested
 * against a stubbed client without constructing SupabaseService. The
 * SupabaseService facade (../supabase.ts) delegates its skill methods
 * here one-for-one under the same names; UI code calls
 * `app.supabase.<method>()` and should not import this module
 * directly. Row types and coercers live in ./types; the quoted
 * ILIKE-pattern builder shared with the other search paths lives in
 * ./query-utils.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { SupabaseError } from './error';
import { getSession } from './session';
import { ilikeLogicTreePattern } from './query-utils';
import type { Skill, SkillSummary, OffsetPage } from './types';
import { DEFAULT_LIST_PAGE_SIZE, coerceSkill, coerceSkillSummary } from './types';

/**
 * Every skill's index projection, ordered `name asc`, with NO row
 * limit. This is the fetch behind the per-turn metadata index: the
 * entry and byte caps plus the overflow count are computed in JS from
 * the full fetched set, so the deterministic-selection contract has a
 * defined input (if stores ever outgrow this, it gains a LIMIT + a
 * count RPC). The projection is deliberately body-less - the index
 * rides every turn, and bodies load only through getSkill.
 *
 * The DB collation's `name ASC` is the order the panel renders
 * verbatim (see listSkillsPage for why the client never re-sorts).
 */
export async function listSkills(client: SupabaseClient): Promise<SkillSummary[]> {
  const { data, error } = await client
    .from('skills')
    .select('id, name, description, updated_at, last_author')
    .order('name', { ascending: true });
  if (error) throw new SupabaseError(error.message);
  return (data ?? []).map((row) => coerceSkillSummary(row as Record<string, unknown>));
}

/**
 * One offset page of the skills browse list, alphabetical by name.
 * Powers the listing surfaces' infinite scroll; an active search
 * still goes through `searchSkills` (capped, not paged), which
 * orders name-asc exactly like this browse path. `id` is the final
 * tiebreak so skills colliding on name keep a stable cross-page
 * order. The `pageSize + 1` probe (range is inclusive) derives
 * hasMore without a second count query.
 *
 * Ordering is the DB collation's `name ASC`, so the sidebar renders
 * server order verbatim rather than re-sorting with a JS
 * `localeCompare` - a client re-sort over a partial page would
 * disagree with the server's page boundaries and shuffle rows across
 * the seam mid-scroll (the wiki list's rationale, copied here).
 */
export async function listSkillsPage(
  client: SupabaseClient,
  opts: {
    offset: number;
    pageSize: number;
  }
): Promise<OffsetPage<Skill>> {
  const { data, error } = await client
    .from('skills')
    .select('id, name, description, body, last_author, created_at, updated_at')
    .order('name', { ascending: true })
    .order('id', { ascending: true })
    .range(opts.offset, opts.offset + opts.pageSize);
  if (error) throw new SupabaseError(error.message);
  const rows = (data ?? []).map((row) => coerceSkill(row as Record<string, unknown>));
  const hasMore = rows.length > opts.pageSize;
  return { rows: hasMore ? rows.slice(0, opts.pageSize) : rows, hasMore };
}

/**
 * Fetch one skill by id, or null if it isn't there (or is owned by
 * another user - RLS makes the two indistinguishable, which is the
 * intended privacy posture). The body-less surfaces never need this;
 * it is the load-on-demand path for a matched skill and the panel's
 * deep-link / stale-URL recovery fetch.
 */
export async function getSkill(client: SupabaseClient, id: string): Promise<Skill | null> {
  const { data, error } = await client
    .from('skills')
    .select('id, name, description, body, last_author, created_at, updated_at')
    .eq('id', id)
    .maybeSingle();
  if (error) throw new SupabaseError(error.message);
  return data ? coerceSkill(data as Record<string, unknown>) : null;
}

/**
 * Case-insensitive substring search over name + description + body.
 * Results carry the body-less projection (same shape as listSkills):
 * a hit is enough to judge relevance by name + description, and the
 * body loads through getSkill only when the user opens the row.
 *
 * The pattern rides the QUOTED logic-tree builder
 * (ilikeLogicTreePattern): inside a `.or(...)` tree an unquoted comma
 * in the query splits the PostgREST logic tree and fails the whole
 * request, so hand-rolled unquoted patterns are wrong here by
 * construction (see query-utils.ts for the failure mode).
 */
export async function searchSkills(
  client: SupabaseClient,
  opts: { query: string; limit?: number }
): Promise<SkillSummary[]> {
  const query = opts.query.trim();
  if (query.length === 0) return [];
  const pattern = ilikeLogicTreePattern(query);
  const { data, error } = await client
    .from('skills')
    .select('id, name, description, updated_at, last_author')
    .or(`name.ilike.${pattern},description.ilike.${pattern},body.ilike.${pattern}`)
    .order('name', { ascending: true })
    // A search result set the same size as a browse page; the sidebar
    // renders it as one list, so a bigger page would just move the
    // wall.
    .limit(opts.limit ?? DEFAULT_LIST_PAGE_SIZE);
  if (error) throw new SupabaseError(error.message);
  return (data ?? []).map((row) => coerceSkillSummary(row as Record<string, unknown>));
}

/**
 * Create or update a skill by id - the browser panel's save path.
 * With no `id` the row is created (needs the session for user_id);
 * with an `id` the row is patched. Every write from this path stamps
 * `last_author = 'user'`; the server-side skills chat tool stamps
 * 'assistant' on its own path, so the panel can show "last edited by
 * Nak" vs "by you".
 *
 * `updated_at` is set here AND by the schema's touch_skill_updated_at
 * trigger; the trigger is the authority (it also covers the
 * server-side tool writer), and the explicit stamp keeps this slice's
 * request shape consistent with the sibling update paths.
 */
export async function saveSkill(
  client: SupabaseClient,
  args: {
    id?: string;
    name: string;
    description: string;
    body: string;
  }
): Promise<Skill> {
  if (args.id) {
    const { data, error } = await client
      .from('skills')
      .update({
        name: args.name,
        description: args.description,
        body: args.body,
        last_author: 'user',
        updated_at: new Date().toISOString(),
      })
      .eq('id', args.id)
      .select('id, name, description, body, last_author, created_at, updated_at')
      .single();
    if (error) throw new SupabaseError(error.message);
    return coerceSkill(data as Record<string, unknown>);
  }
  const session = await getSession(client);
  if (!session) throw new SupabaseError('Not authenticated.');
  const { data, error } = await client
    .from('skills')
    .insert({
      user_id: session.user.id,
      name: args.name,
      description: args.description,
      body: args.body,
      last_author: 'user',
    })
    .select('id, name, description, body, last_author, created_at, updated_at')
    .single();
  if (error) throw new SupabaseError(error.message);
  return coerceSkill(data as Record<string, unknown>);
}

/**
 * Hard delete by id. RLS owner-scopes the delete, so a wrong id (or
 * another user's skill) is silently a no-op, matching the rest of the
 * CRUD surface here. The row is small and the user has the panel, so
 * no soft-delete state.
 */
export async function deleteSkill(client: SupabaseClient, id: string): Promise<void> {
  const { error } = await client.from('skills').delete().eq('id', id);
  if (error) throw new SupabaseError(error.message);
}
