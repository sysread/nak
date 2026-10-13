// recipe_record_list (function-side port)
//
// List one recipe's cooking log, most recent event first, with
// optional date-range, tag (AND), and outcome filters. Wire schema
// lives in src/lib/tools/recipe_record_list.schema.ts. RLS OFF: filter
// by userId. Also the dedup guard's read side: recipe_record_create's
// prompt tells the model to list before logging.

import { registerTool, type ToolContext, type ToolDef } from '../performToolCall.ts';
import {
  RECIPE_RECORD_COLUMNS,
  isRecipeRecordOutcome,
  normalizeRecipeRecordDate,
} from './_recipe_record_helpers.ts';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export const recipeRecordList: ToolDef = {
  name: 'recipe_record_list',
  async execute(args: Record<string, unknown>, ctx: ToolContext) {
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
        ? Math.min(Math.floor(args.limit), MAX_LIMIT)
        : DEFAULT_LIMIT;

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
  },
};

registerTool(recipeRecordList);
