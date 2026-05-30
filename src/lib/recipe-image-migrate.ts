/**
 * One-time migration: move legacy base64 `recipe_images.data` rows into
 * the `recipe-images` Storage bucket. Driven by a single Settings button
 * (see Settings.svelte). Self-contained on purpose - the collapse PR
 * deletes this file and the button together once the migration has run.
 *
 * Idempotent: it only touches rows that still lack a `storage_path`, and
 * the upload is content-addressed (`<user_id>/<sha256>`, upsert:true), so
 * re-running after a partial failure simply finishes the remainder.
 */
import type { SupabaseService } from './supabase';

export interface RecipeImageMigrationResult {
  /** Rows that needed moving at the start. */
  total: number;
  /** Rows successfully moved to the bucket this run. */
  migrated: number;
  /** Per-row failures (id + message); the rest still migrate. */
  errors: Array<{ id: string; message: string }>;
}

export async function migrateRecipeImagesToBucket(
  supabase: SupabaseService
): Promise<RecipeImageMigrationResult> {
  const rows = await supabase.listRecipeImagesNeedingMigration();
  const errors: Array<{ id: string; message: string }> = [];
  let migrated = 0;
  for (const row of rows) {
    try {
      const path = await supabase.uploadRecipeImageObject(row.sha256, row.data, row.mime_type);
      await supabase.setRecipeImageStoragePath(row.id, path);
      migrated += 1;
    } catch (err) {
      errors.push({ id: row.id, message: err instanceof Error ? err.message : String(err) });
    }
  }
  return { total: rows.length, migrated, errors };
}
