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
import { createLogger } from './logger.svelte';

const log = createLogger('recipe-image-migrate');

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
  // Progress goes to the log drawer so the one-time run is observable -
  // a count up front, a line per image, and a final tally.
  if (rows.length === 0) {
    log.info('No recipe images need migrating - all already in the bucket.');
    return { total: 0, migrated: 0, errors: [] };
  }
  log.info(`Migrating ${rows.length} recipe image(s) to the bucket...`);
  const errors: Array<{ id: string; message: string }> = [];
  let migrated = 0;
  for (const row of rows) {
    try {
      const path = await supabase.uploadRecipeImageObject(row.sha256, row.data, row.mime_type);
      await supabase.setRecipeImageStoragePath(row.id, path);
      migrated += 1;
      log.info(`Moved ${migrated}/${rows.length} (${row.sha256.slice(0, 12)}...)`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push({ id: row.id, message });
      log.warn(`Failed to migrate recipe image ${row.id}: ${message}`);
    }
  }
  log.info(
    `Recipe-image migration done: moved ${migrated} of ${rows.length}` +
      (errors.length > 0 ? `, ${errors.length} failed (re-run to retry).` : '.')
  );
  return { total: rows.length, migrated, errors };
}
