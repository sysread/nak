// recipe_update (function-side port)
//
// Patch an existing recipe via recipe_update_with_version RPC
// (p_user_id-aware). Cooklang validation mirrors recipe_save's
// inline check.
//
// This tool never sets the photo list (p_set_image_ids=false), so the
// RPC carries the previous version's links onto the new version. The
// response still reads those links back and reports them: an update
// that reported `photos: []` looked like it had wiped the recipe's
// photos, and the model relayed that to the user as data loss on an
// edit that had in fact preserved every photo. Changing the photo set
// is the recipe_photos_* tools' job.

import { registerTool, type ToolContext, type ToolDef } from '../performToolCall.ts';
import { readRecipePhotoMeta } from './_recipe_helpers.ts';
import { ArgErrors } from './_validate.ts';

// Mirror of src/lib/recipe-limits.ts - the caps the wire schema
// advertises. Divergent copies here rejected schema-legal bodies.
const MAX_RECIPE_TITLE_CHARS = 160;
const MAX_RECIPE_COOKLANG_CHARS = 20_000;

import { validateCooklangSource } from '../../_shared/cooklang-validate.ts';

export const recipeUpdate: ToolDef = {
  name: 'recipe_update',
  async execute(args: Record<string, unknown>, ctx: ToolContext) {
    const id = typeof args.id === 'string' ? args.id : '';

    const errs = new ArgErrors();
    if (!id) errs.add('id is required');

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

    // The star rating is the user's evaluation of a recipe they cooked,
    // not recipe content. The model would set it from conversational
    // praise ("that turned out great") and overwrite a verdict only the
    // user gets to make, so the tool refuses it outright rather than
    // ignoring it silently - a silent drop reads to the model as a
    // successful write and it tells the user the rating changed.
    if ('rating' in args) {
      errs.add(
        'rating is not editable by this tool - the star rating is the ' +
          "user's own evaluation and only they can set or clear it",
      );
    }

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
  },
};

registerTool(recipeUpdate);
