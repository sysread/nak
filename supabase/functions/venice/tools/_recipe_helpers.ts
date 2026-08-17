// Shared read-back of a recipe's current photo set.
//
// The newest `recipe_versions` row carries the recipe's live photo
// links, so "which photos does this recipe have right now" is a join
// against that one row. Both recipe_get and recipe_update need the
// answer: get because the model asked for it, update because every
// scalar edit inherits the previous version's links and has to report
// what it carried forward.
//
// RLS OFF: callers validate recipe ownership before calling - recipe_get
// with an explicit user_id filter, recipe_update through the RPC's own
// user scoping - and recipe_versions inherits ownership through
// recipe_id, so an unscoped lookup by recipe_id is safe here.

import type { SupabaseClient } from '@supabase/supabase-js';

export interface RecipePhotoMeta {
  id: string;
  position: number;
  label: string | null;
}

interface PhotoLinkRow {
  position: number;
  image_id: string;
  label: string | null;
}

export async function readRecipePhotoMeta(
  adminClient: SupabaseClient,
  recipeId: string,
): Promise<RecipePhotoMeta[]> {
  const { data: versionRow, error } = await adminClient
    .from('recipe_versions')
    .select('id, recipe_version_images(position, image_id, label)')
    .eq('recipe_id', recipeId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`listRecipePhotoMeta failed: ${error.message}`);
  if (!versionRow) return [];

  const links = (versionRow as { recipe_version_images?: PhotoLinkRow[] | null })
    .recipe_version_images;
  if (!Array.isArray(links)) return [];

  return links
    .map((l) => ({ id: l.image_id, position: l.position, label: l.label ?? null }))
    .sort((a, b) => a.position - b.position);
}
