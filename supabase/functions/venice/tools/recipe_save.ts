// recipe_save (create/update-merged recipe write)
//
// One tool behind an optional `id`: omit it to create a new recipe,
// pass it to patch an existing one. Consolidates the former
// recipe_save + recipe_update (the routing contract is the same
// id-optional upsert shape as wiki_save; there is no shared runtime
// module because each resource's conditional validation differs).
// Wire schema lives in src/lib/tools/recipe_save.schema.ts. Auth:
// b-strict.
//
// The two halves hit different RPCs: recipe_create_with_version on a
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
// is the recipe_photos_* tools' job.
//
// Cooklang authoring-quirk validator mirrors validateCooklangSource
// in src/lib/cooklang.ts - if that file's check list grows, mirror
// the additions here.

import { registerTool, type ToolContext, type ToolDef } from '../performToolCall.ts';
import { readRecipePhotoMeta } from './_recipe_helpers.ts';
import { ArgErrors } from './_validate.ts';
import { resolveNaturalKeyMatch } from './_upsert_heuristics.ts';

// Mirror of src/lib/recipe-limits.ts - the caps the wire schema
// advertises. Divergent copies here rejected schema-legal bodies.
const MAX_RECIPE_TITLE_CHARS = 160;
const MAX_RECIPE_COOKLANG_CHARS = 20_000;

import { validateCooklangSource } from '../../_shared/cooklang-validate.ts';

/**
 * The star rating is the user's evaluation of a dish they cooked, so
 * no tool writes it - only the star control on the recipe card does.
 * A call carrying one fails loudly rather than dropping it silently:
 * a silent drop reads to the model as a successful write, and it then
 * tells the user a rating was saved. Both forms share this guard.
 */
function rejectRating(errs: ArgErrors, args: Record<string, unknown>) {
  if ('rating' in args) {
    errs.add(
      'rating is not editable by this tool - the star rating is the ' +
        "user's own evaluation and only they can set or clear it",
    );
  }
}

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
      // % wildcards for containment (see wiki_save.ts); bare column
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
  // recipe_get after the curation unit has run.
  const { topics: _requeuedTopics, ...row } = rows[0];

  return { ...row, photos: await readRecipePhotoMeta(ctx.adminClient, id) };
}

export const recipeSave: ToolDef = {
  name: 'recipe_save',
  async execute(args: Record<string, unknown>, ctx: ToolContext) {
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
  },
};

registerTool(recipeSave);
