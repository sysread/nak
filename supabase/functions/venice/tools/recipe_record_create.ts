// recipe_record_create (function-side port)
//
// Log a dated record in a recipe's cooking log: what happened when the
// user cooked it. Wire schema lives in
// src/lib/tools/recipe_record_create.schema.ts. Auth: b-strict - the
// recipe is ownership-checked, and user_id is stamped on insert so a
// service-role write can't land under another owner.
//
// source_conversation_id is stamped from ctx.threadId when present (a
// chat-driven write carries the live thread), so a record records
// where it came from; the UI's add form leaves it null.
//
// The result carries a dedup payload alongside the new row - the
// recipe's same-date sibling records plus its most recent PRIOR record
// (greatest date strictly before this one) - so the model sees a
// likely duplicate in the same turn without a second call. Create
// never refuses on a near-duplicate: two cooks on one date are
// legitimate, so the payload is information, not a veto. Same-date
// siblings alone can't catch the second duplicate shape (a later
// conversation re-describing yesterday's event), which is what the
// strict-prior row is for.

import { registerTool, type ToolContext, type ToolDef } from '../performToolCall.ts';
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

export const recipeRecordCreate: ToolDef = {
  name: 'recipe_record_create',
  async execute(args: Record<string, unknown>, ctx: ToolContext) {
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
  },
};

registerTool(recipeRecordCreate);
