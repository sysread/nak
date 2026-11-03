// recipes (function-side combination tool)
//
// One tool behind an `op` enum discriminator: list / get / save /
// delete over the user's cookbook. Replaces the four verb
// registrations (recipe_list, recipe_get, recipe_save, recipe_delete);
// the per-op bodies survive verbatim as internal functions - only the
// envelope changed (see the browser schema's header).
//
// Auth: b-strict throughout. recipes has user_id directly, so every
// read filters .eq('user_id', userId) and every write stamps
// p_user_id - the service-role client bypasses RLS, and a foreign or
// unknown id matches zero rows and reports the miss honestly
// (indistinguishable from "never existed", matching what RLS would
// show the browser path).
//
// The save op is the create/update-merged upsert (the former
// recipe_save; itself a consolidation of recipe_save + recipe_update).
// The two forms hit different RPCs: recipe_create_with_version on a
// create, recipe_update_with_version on an edit. The RPCs use
// p_set_<field> + p_<field> pairs - explicit null clears, omission
// leaves alone - so the patch bundle is built from named fields only.
//
// The edit form never sets the photo list (p_set_image_ids=false), so
// the RPC carries the previous version's links onto the new version.
// The response still reads those links back and reports them: an edit
// that reported `photos: []` looked like it had wiped the recipe's
// photos, and the model relayed that to the user as data loss on an
// edit that had in fact preserved every photo. Changing the photo set
// is the recipe_photos combination tool's job.
//
// Both save forms run validateCooklangSource
// (_shared/cooklang-validate.ts) on the submitted body and refuse the
// write when it reports anything, so the model sees the problem and
// resubmits a fixed recipe.
//
// Per-op required fields (id on get/delete, title + cooklang on
// create, change_message on update) are enforced inside the per-op
// bodies below - the flat wire schema cannot express them. Error
// strings are load-bearing: substring test assertions pin them.

import { registerTool, type ToolContext, type ToolDef } from '../performToolCall.ts';
import { readRecipePhotoMeta } from './_recipe_helpers.ts';
import { ArgErrors } from './_validate.ts';
import { resolveNaturalKeyMatch } from './_upsert_heuristics.ts';
import { validateCooklangSource } from '../../_shared/cooklang-validate.ts';

// Mirror of src/lib/recipe-limits.ts - the caps the wire schema
// advertises. Divergent copies here rejected schema-legal bodies.
const MAX_RECIPE_TITLE_CHARS = 160;
const MAX_RECIPE_COOKLANG_CHARS = 20_000;

// Mirror of RECIPE_LIST_DEFAULT_LIMIT / _MAX_LIMIT in the wire schema.
const RECIPE_LIST_DEFAULT_LIMIT = 100;
const RECIPE_LIST_MAX_LIMIT = 500;

// ILIKE pattern helper. Mirrors src/lib/supabase.ts ilikeFilterPattern -
// escape ILIKE metacharacters in the user input, then wrap in %...%.
// Keeps the substring match honest when the title contains a literal
// % or _ (rare for recipe titles but cheap insurance).
function ilikeFilterPattern(raw: string): string {
  return `%${raw.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
}

/**
 * The star rating is the user's evaluation of a dish they cooked, so
 * no tool writes it - only the star control on the recipe card does.
 * A call carrying one fails loudly rather than dropping it silently:
 * a silent drop reads to the model as a successful write, and it then
 * tells the user a rating was saved. Both save forms share this guard.
 */
function rejectRating(errs: ArgErrors, args: Record<string, unknown>) {
  if ('rating' in args) {
    errs.add(
      'rating is not editable by this tool - the star rating is the ' +
        "user's own evaluation and only they can set or clear it",
    );
  }
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

async function listOp(args: Record<string, unknown>, ctx: ToolContext) {
  const query = typeof args.query === 'string' ? args.query.trim() : '';
  const rawLimit =
    typeof args.limit === 'number' ? args.limit : RECIPE_LIST_DEFAULT_LIMIT;
  const limit = Math.max(
    1,
    Math.min(RECIPE_LIST_MAX_LIMIT, Math.floor(rawLimit)),
  );
  const sort: 'updated' | 'rating' =
    args.sort === 'rating' ? 'rating' : 'updated';

  // RLS OFF: filter by userId. recipes.user_id is the direct
  // ownership column.
  let q = ctx.adminClient
    .from('recipes')
    .select('id, title, source, source_url, rating, updated_at')
    .eq('user_id', ctx.userId)
    .limit(limit);
  if (sort === 'rating') {
    q = q
      .order('rating', { ascending: false, nullsFirst: false })
      .order('updated_at', { ascending: false });
  } else {
    q = q.order('updated_at', { ascending: false });
  }
  if (query.length > 0) {
    q = q.ilike('title', ilikeFilterPattern(query));
  }

  const { data, error } = await q;
  if (error) throw new Error(`listRecipes failed: ${error.message}`);

  return (data ?? []).map((r) => ({
    id: r.id as string,
    title: r.title as string,
    source: r.source as string | null,
    source_url: r.source_url as string | null,
    rating: r.rating as number | null,
    updated_at: r.updated_at as string,
  }));
}

// ---------------------------------------------------------------------------
// get
// ---------------------------------------------------------------------------

async function getOp(args: Record<string, unknown>, ctx: ToolContext) {
  const id = typeof args.id === 'string' ? args.id : '';
  if (!id) throw new Error('id is required');

  // RLS OFF: filter by userId. user_id eq + id eq matches browser
  // RLS behavior; miss-vs-not-owned reads the same to a probe.
  const { data: recipe, error: recipeErr } = await ctx.adminClient
    .from('recipes')
    .select(
      'id, title, source, source_url, cooklang, rating, upcoming, favorite, topics, created_at, updated_at',
    )
    .eq('user_id', ctx.userId)
    .eq('id', id)
    .maybeSingle();
  if (recipeErr) throw new Error(`getRecipe failed: ${recipeErr.message}`);
  if (!recipe) return { found: false };

  // Newest recipe_version row carries the current photo set; the
  // shared helper owns that join (the save op's edit form reads it
  // back the same way). Ownership was validated by the select above.
  const photos = await readRecipePhotoMeta(ctx.adminClient, id);

  return {
    found: true,
    recipe: {
      ...recipe,
      photos,
    },
  };
}

// ---------------------------------------------------------------------------
// save
// ---------------------------------------------------------------------------

/**
 * The star rating is the user's evaluation of a dish they cooked, so
 * no tool writes it - only the star control on the recipe card does.
 * A call carrying one fails loudly rather than dropping it silently:
 * a silent drop reads to the model as a successful write, and it then
 * tells the user a rating was saved.
 */
async function doCreate(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<unknown> {
  const title = typeof args.title === 'string' ? args.title.trim() : '';
  const cooklang = typeof args.cooklang === 'string' ? args.cooklang : '';
  const source =
    typeof args.source === 'string' && args.source.trim().length > 0
      ? args.source.trim()
      : null;
  const sourceUrl =
    typeof args.source_url === 'string' && args.source_url.trim().length > 0
      ? args.source_url.trim()
      : null;
  const errs = new ArgErrors();
  rejectRating(errs, args);
  if (!title) errs.add('title is required');
  else if (title.length > MAX_RECIPE_TITLE_CHARS) {
    errs.add(`title exceeds ${MAX_RECIPE_TITLE_CHARS}-char limit (got ${title.length})`);
  }
  if (!cooklang) errs.add('cooklang is required');
  else if (cooklang.length > MAX_RECIPE_COOKLANG_CHARS) {
    errs.add(
      `cooklang exceeds ${MAX_RECIPE_COOKLANG_CHARS}-char limit (got ${cooklang.length})`,
    );
  } else {
    // Syntax check only on a present, length-legal body - running it on an
    // oversize blob just stacks a second complaint about the same field.
    const cooklangErrors = validateCooklangSource(cooklang);
    if (cooklangErrors.length > 0) {
      errs.add(`cooklang validation failed:\n- ${cooklangErrors.join('\n- ')}`);
    }
  }
  errs.throwIfAny();

  // Natural-key dedup: titles are unique per user (recipes_user_title_unique).
  // The model may be updating a recipe whose title it knows but whose id it
  // forgot; an exact-title match routes to that recipe's update path instead
  // of bouncing with the unique-violation, and a near-match is refused with
  // the candidates named. No fuzzy-merge risk here beyond the refusal: an
  // update only patches named fields, so a wrong guess surfaces as the model
  // reading the returned row and correcting itself.
  const match = await resolveNaturalKeyMatch({
    query: async (probeValue: string) => {
      // % wildcards for containment (see the wiki combo's save op); bare column
      // select (PostgREST cannot carry AS aliases). RLS OFF: user_id
      // filtered explicitly - service-role bypasses RLS.
      const { data, error } = await ctx.adminClient
        .from('recipes')
        .select('id, title')
        .eq('user_id', ctx.userId)
        .ilike('title', `%${probeValue}%`)
        .limit(3);
      if (error) throw new Error(`naturalKeyProbe failed: ${error.message}`);
      const rows = (data ?? []) as { id: string; title: string }[];
      return { data: rows.map((r) => ({ id: r.id, key: r.title })) };
    },
    keyValue: title,
    fuzzy: true,
  });
  if (match) {
    // The model's create-intent landed on an existing recipe. The edit
    // form's change_message requirement would now reject the call for
    // a field the model had no reason to provide (the schema calls it
    // optional on create), so default it here - the matched-update
    // changelog line stays informative.
    if (
      typeof args.change_message !== 'string' ||
      args.change_message.trim().length === 0
    ) {
      args = { ...args, change_message: `Matched existing "${match.key}"` };
    }
    const updated = (await doUpdate(match.id, args, ctx)) as {
      matched_existing?: boolean;
    };
    return { ...updated, matched_existing: true };
  }
  // A save is always a recipe's first version, so an omitted
  // change_message defaults rather than erroring - there is no prior
  // state to describe a delta against, and the model routinely forgets
  // the field on a brand-new recipe. The edit form requires it (a
  // delta with nothing to describe against is the point of the
  // history). Matches the backfill seed naming and the client-side
  // recipe_save executor.
  const changeMessage =
    typeof args.change_message === 'string' && args.change_message.trim().length > 0
      ? args.change_message.trim()
      : 'Initial version';

  const { data, error } = await ctx.adminClient.rpc('recipe_create_with_version', {
    p_title: title,
    p_cooklang: cooklang,
    p_source: source,
    p_source_url: sourceUrl,
    p_rating: null,
    p_image_ids: null,
    p_image_labels: null,
    p_change_message: changeMessage,
    p_user_id: ctx.userId,
  });
  if (error) throw new Error(`createRecipe failed: ${error.message}`);
  const rows = (data ?? []) as Array<{
    id: string;
    title: string;
    updated_at: string;
  }>;
  if (rows.length === 0) throw new Error('createRecipe returned no row');
  const row = rows[0]!;

  return {
    id: row.id,
    title: row.title,
    updated_at: row.updated_at,
    photos: [] as Array<{ id: string; position: number }>,
  };
}

async function doUpdate(
  id: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<unknown> {
  const errs = new ArgErrors();

  // Build the RPC arg bundle from the patch shape. The RPC uses
  // p_set_<field> + p_<field> pairs: explicit null clears, omission
  // leaves alone. A malformed field records an error and stays unset, so
  // the throw below fires before the RPC ever runs.
  let setTitle = false;
  let titleVal: string | null = null;
  if (typeof args.title === 'string' && args.title.trim().length > 0) {
    const t = args.title.trim();
    if (t.length > MAX_RECIPE_TITLE_CHARS) {
      errs.add(`title exceeds ${MAX_RECIPE_TITLE_CHARS}-char limit (got ${t.length})`);
    } else {
      setTitle = true;
      titleVal = t;
    }
  }

  let setCooklang = false;
  let cooklangVal: string | null = null;
  if (typeof args.cooklang === 'string' && args.cooklang.length > 0) {
    if (args.cooklang.length > MAX_RECIPE_COOKLANG_CHARS) {
      errs.add(
        `cooklang exceeds ${MAX_RECIPE_COOKLANG_CHARS}-char limit (got ${args.cooklang.length})`,
      );
    } else {
      const cooklangErrors = validateCooklangSource(args.cooklang);
      if (cooklangErrors.length > 0) {
        errs.add(`cooklang validation failed:\n- ${cooklangErrors.join('\n- ')}`);
      } else {
        setCooklang = true;
        cooklangVal = args.cooklang;
      }
    }
  }

  let setSource = false;
  let sourceVal: string | null = null;
  if (args.source === null) {
    setSource = true;
    sourceVal = null;
  } else if (typeof args.source === 'string') {
    setSource = true;
    sourceVal = args.source.trim();
  }

  let setSourceUrl = false;
  let sourceUrlVal: string | null = null;
  if (args.source_url === null) {
    setSourceUrl = true;
    sourceUrlVal = null;
  } else if (typeof args.source_url === 'string') {
    setSourceUrl = true;
    sourceUrlVal = args.source_url.trim();
  }

  rejectRating(errs, args);

  // Empty-patch is only a real complaint when nothing else is wrong - a
  // malformed field already left its set-flag false, and double-reporting
  // it as "provide at least one of" would mislead.
  if (!setTitle && !setCooklang && !setSource && !setSourceUrl && !errs.any) {
    errs.add('provide at least one of title, cooklang, source, or source_url');
  }

  const changeMessage =
    typeof args.change_message === 'string' ? args.change_message.trim() : '';
  if (!changeMessage) errs.add('change_message is required');
  errs.throwIfAny();

  const { data, error } = await ctx.adminClient.rpc('recipe_update_with_version', {
    p_id: id,
    p_set_title: setTitle,
    p_title: titleVal,
    p_set_cooklang: setCooklang,
    p_cooklang: cooklangVal,
    p_set_source: setSource,
    p_source: sourceVal,
    p_set_source_url: setSourceUrl,
    p_source_url: sourceUrlVal,
    p_set_rating: false,
    p_rating: null,
    p_set_image_ids: false,
    p_image_ids: null,
    p_image_labels: null,
    p_change_message: changeMessage,
    p_user_id: ctx.userId,
  });
  if (error) throw new Error(`updateRecipe failed: ${error.message}`);
  const rows = (data ?? []) as Array<Record<string, unknown>>;
  if (rows.length === 0) throw new Error('updateRecipe returned no row');

  // Drop `topics` from the echoed row. The
  // clear_recipe_topics_on_change trigger empties the column on any
  // content edit so the recipe-topics curation unit re-tags it, and
  // the RPC reads the row back after that trigger has fired - so this
  // field is ALWAYS an empty array here, whatever the recipe was
  // tagged with a moment earlier and will be tagged with again once
  // the unit catches up. Echoing it invited the model to report the
  // tags as lost. Callers that want the live tags read them back with
  // the get op after the curation unit has run.
  const { topics: _requeuedTopics, ...row } = rows[0];

  return { ...row, photos: await readRecipePhotoMeta(ctx.adminClient, id) };
}

async function saveOp(args: Record<string, unknown>, ctx: ToolContext) {
  const id =
    typeof args.id === 'string' && args.id.trim().length > 0
      ? args.id.trim()
      : undefined;

  // Shared pre-route guard: the rating veto applies to both forms.
  if ('rating' in args) {
    const errs = new ArgErrors();
    errs.add(
      'rating is not editable by this tool - the star rating is the ' +
        "user's own evaluation and only they can set or clear it",
    );
    errs.throwIfAny();
  }

  if (id) return doUpdate(id, args, ctx);
  return doCreate(args, ctx);
}

// ---------------------------------------------------------------------------
// delete
// ---------------------------------------------------------------------------

async function deleteOp(args: Record<string, unknown>, ctx: ToolContext) {
  const id = typeof args.id === 'string' ? args.id : '';
  if (!id) throw new Error('id is required');

  // RLS OFF: filter by userId. .select('id') makes a zero-row match
  // detectable so the result can distinguish "deleted" from
  // "nothing matched" (see memory_delete.ts for the same change).
  const { data, error } = await ctx.adminClient
    .from('recipes')
    .delete()
    .eq('id', id)
    .eq('user_id', ctx.userId)
    .select('id');
  if (error) throw new Error(`deleteRecipe failed: ${error.message}`);
  const deleted = Array.isArray(data) && data.length > 0;
  if (!deleted) {
    return {
      deleted: false,
      reason: 'No recipe with that id - already deleted, never existed, or not yours.',
    };
  }

  return { deleted: true };
}

// ---------------------------------------------------------------------------
// combination-tool envelope
// ---------------------------------------------------------------------------

export const recipes: ToolDef = {
  name: 'recipes',
  async execute(args: Record<string, unknown>, ctx: ToolContext) {
    const op = typeof args.op === 'string' ? args.op.trim() : '';
    if (!op) {
      throw new Error('op is required (list | get | save | delete)');
    }
    switch (op) {
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
          `unknown op "${op}" - expected list, get, save, or delete`,
        );
    }
  },
};

registerTool(recipes);
