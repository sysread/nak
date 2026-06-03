// recipe_list (function-side port)
//
// List recipes in the user's cookbook, optionally filtered by a
// title substring. Wire schema lives in
// src/lib/tools/recipe_list.schema.ts. Sort modes mirror the
// browser path: 'updated' (default) or 'rating'.
//
// Auth: b-strict. recipes has user_id directly so the // RLS OFF
// filter is a single .eq('user_id', userId).

import { registerTool, type ToolContext, type ToolDef } from '../performToolCall.ts';

// Mirror of RECIPE_LIST_DEFAULT_LIMIT / _MAX_LIMIT in
// src/lib/tools/recipe_list.schema.ts.
const RECIPE_LIST_DEFAULT_LIMIT = 100;
const RECIPE_LIST_MAX_LIMIT = 500;

// ILIKE pattern helper. Mirrors src/lib/supabase.ts ilikeFilterPattern -
// escape ILIKE metacharacters in the user input, then wrap in %...%.
// Keeps the substring match honest when the title contains a literal
// % or _ (rare for recipe titles but cheap insurance).
function ilikeFilterPattern(raw: string): string {
  return `%${raw.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
}

export const recipeList: ToolDef = {
  name: 'recipe_list',
  async execute(args: Record<string, unknown>, ctx: ToolContext) {
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
  },
};

registerTool(recipeList);
