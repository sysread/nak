# Recipe-images storage migration

Move `recipe_images` file bytes off base64-in-Postgres into a
dedicated private Storage bucket, the same consolidation the
attachments migration did (see
[`./attachments-storage-migration.md`](./attachments-storage-migration.md)).
Unlike attachments, recipe images are **persistent** (no expiry),
so existing bytes must actually be moved - hence a one-time
migrate button.

## Resolved decisions

1. **Dedicated `recipe-images` bucket** (content-addressed,
   persistent - distinct lifecycle from `attachments` /
   `documents`).
2. **Object key = `<user_id>/<sha256>`.** Deterministic from data
   already on the row, so dedup is preserved for free (same image
   -> same key) and any repoint is computable without the button
   reporting paths back.
3. **Rip-out-able migrate button** in Settings (single function so
   PR2 deletes it cleanly; could also be hung off `window` for a
   desktop console).
4. **Fix the orphan bug, don't punt it.** The current
   `AFTER DELETE` trigger reclaims a `recipe_images` row when its
   last link goes, but (a) never catches insert-side orphans (row
   created, the save that would link it failed) and (b) can't
   delete a bucket object. Replace it with an **idempotent
   server-side GC sweep** that reclaims every unreferenced
   `recipe_images` row AND its bucket object - both orphan kinds,
   one mechanism, edge-function-shaped. Self-healing under a
   GC-vs-reattach race because content addressing means the next
   `upsertRecipeImage` re-uploads the same `<uid>/<sha256>` key.

## Current shape (what we're changing)

- `recipe_images`: `data text not null` (base64), dedup
  `unique(user_id, sha256)`, `mime_type`, `size_bytes`. Writes go
  through the `recipe_image_upsert(p_sha256, p_mime_type,
  p_size_bytes, p_data)` RPC (dedup + returns id).
- `recipe_version_images`: link table (many-to-many, ordered,
  per-link `label`). Orphan-GC trigger reclaims `recipe_images`
  rows on last-link delete.
- Write callers (both hit `SupabaseService.upsertRecipeImage`):
  the Cookbook file-picker (`onPickPhotos` in `Cookbook.svelte` -
  upserts at PICK time, so the draft carries a stable `imageId`)
  and the `recipe_photos_attach` tool.
- Read: `SupabaseService.listRecipePhotos` embeds
  `recipe_images(... data)`; `cookbook-store`'s `loadRecipePhotos`
  fills `cookbook.photos[recipeId]`; `Cookbook.svelte` renders
  `dataUrlFor(p.mime_type, p.data_base64)` in the detail strip,
  the edit strip (via the `DraftPhoto.dataBase64` copy), and the
  lightbox.

## PR1a - bucket + dual-read + migrate button

- **Schema:** create the private `recipe-images` bucket + three
  self-prefix `storage.objects` RLS policies. `recipe_images`:
  add `storage_path text`, make `data` nullable.
  `recipe_image_upsert` gains `p_storage_path` and writes it
  (p_data now nullable). Keep the orphan trigger for now (PR1b
  replaces it).
- **Write:** `upsertRecipeImage(sha, mime, size, base64)` uploads
  the bytes to `<uid>/<sha256>` (idempotent `upsert: true`), then
  calls the RPC with `storage_path` and null data. Signature
  unchanged for its two callers - the bucket upload is
  encapsulated.
- **Read (single-point dual-read):** `listRecipePhotos` projects
  `storage_path` + `data`, batch-resolves signed URLs for the
  bucket-backed rows (`createSignedUrl(s)` on `recipe-images`),
  and returns a resolved **`url`** per photo (signed URL, or
  `dataUrlFor(mime, data)` for not-yet-migrated rows). `RecipePhoto`
  swaps `data_base64` -> `url`. This keeps the component
  synchronous - no per-site async signing.
- **Component:** render sites use `p.url`. `DraftPhoto.dataBase64`
  -> `src` (display only; new uploads set `src = dataUrlFor(base64)`
  from the in-memory bytes, converted-from-loaded drafts set
  `src = loadedPhoto.url`). Save still sends `{ id, label }`, so no
  bytes needed at save.
- **Migrate button (Settings):** a single
  `migrateRecipeImagesToBucket()` - list the user's `recipe_images`
  with `storage_path is null and data is not null`, upload each
  row's base64 to `<uid>/<sha256>`, set `storage_path`. Idempotent
  (re-run skips already-migrated rows). Wired to one Settings
  button + reported progress.

## PR1b - GC sweep (replaces the orphan trigger)

- Drop the `AFTER DELETE` orphan trigger.
- RPCs (service-role): `list_orphan_recipe_images(p_limit)` ->
  `(id, storage_path)` for rows with no `recipe_version_images`
  link; `delete_recipe_images_if_orphan(p_ids)` -> re-checks "no
  link" under `FOR UPDATE` and deletes, returning the storage_paths
  actually removed (so a row re-linked between list and delete is
  skipped).
- Standalone `recipe-image-gc` edge function + cron (mirror
  `expire-attachments`): list orphans -> delete rows (re-checked)
  -> delete their bucket objects. Idempotent end to end. I/O-free
  core in `_shared/`, unit-tested. Add a `deploy.yml` line.
- Fixes both orphan kinds (insert-side + delete-side) and the
  bucket-object leak the trigger could never address.

## You click migrate

After PR1a + PR1b deploy: hit the Settings button once. Every
`recipe_images` row gets `storage_path`; objects land in the
bucket.

## PR2 - collapse

- Drop the `recipe_images.data` column (idempotent
  `drop column if exists`), drop the dual-read (signed-URL only in
  `listRecipePhotos`), remove the migrate button + its function.

## Gotchas / notes

- **Content addressing makes the upload idempotent and the GC
  self-healing.** Same image -> same `<uid>/<sha256>` key, so
  re-upload is a no-op and a GC-vs-reattach race resolves on the
  next `upsertRecipeImage`.
- **Signed-URL TTL** on the detail/lightbox view: use a generous
  TTL (hours); a long-open detail pane re-resolves on reload.
- **`recipe_photos_attach` tool** is unchanged - it already hands
  `upsertRecipeImage` the base64; the bucket upload is internal.
- **Verification owed post-deploy** (no browser / cron from the
  cloud env): the migrate button round-trip, thumbnail/lightbox
  rendering from signed URLs, and the GC sweep actually deleting
  an orphaned row + object.
