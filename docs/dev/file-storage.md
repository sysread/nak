# File storage

How Nak stores user file bytes. One mechanism: **private Supabase
Storage buckets**, read through short-lived **signed URLs**, with row
tables holding only metadata + a `storage_path` pointer. No file bytes
live in Postgres columns anymore.

This is the overview; each feature doc covers its own specifics:
[Attachments](./attachments.md) (chat files), [Library](./library.md)
(uploaded documents), [Cookbook](./cookbook.md) (recipe photos).

## Why buckets, not base64

All three byte stores were originally base64 in a `text` column. That
bloated rows and backups (a 10 MB PDF is ~13 MB of base64, replicated
into every backup) and dragged the bytes into memory on every read.
The Library shipped on a bucket from the start; attachments and recipe
images were migrated onto the same pattern. The win: lighter reads,
smaller backups, and the model's vision input can fetch an image URL
directly instead of us inlining megabytes of base64 per turn.

## The three buckets

All `public = false`; reachable only via signed URLs or an authenticated
download. Each has three `storage.objects` RLS policies (select / insert
/ delete) scoped to the caller's own top-level folder:
`(storage.foldername(name))[1] = auth.uid()::text`. Defined + created
idempotently in `supabase/schema.sql` (`insert into storage.buckets ...
on conflict do nothing`).

| Bucket | Holds | Object key | Lifecycle |
| --- | --- | --- | --- |
| `documents` | Library uploads | `<user_id>/<document_id>/<filename>` | persistent |
| `attachments` | chat message files + generated images | `<user_id>/<attachment_id>/<filename>` | expire 30d after the thread goes dormant |
| `recipe-images` | cookbook photos | `<user_id>/<sha256>` (content-addressed) | persistent; reclaimed when orphaned |

The key's top folder is always `<user_id>` - that's what the RLS policy
keys on. `recipe-images` is content-addressed (the sha256, which is also
the table's per-user dedup key), so the same image always maps to the
same object; the others use the row id so re-uploads get distinct keys.

## Conventions

- **Write = upload, then record the path.** The client uploads the bytes
  to the bucket and stores the returned key in the row's `storage_path`
  (attachments mint the id client-side so upload + insert reference one
  key in a single pass; recipe images compute the key from the sha).
  Row tables never store bytes.
- **Read = signed URL, never bytes.** List queries project `storage_path`
  (not bytes), and the consumer mints a short-lived signed URL on demand
  (`createSignedUrl(s)`), batched where a view shows many files. The UI
  renders `<img src={signedUrl}>` / download anchors from it; the chat
  model's vision input is handed a signed URL and Venice fetches it
  server-side (its `image_url.url` accepts a public URL, which a signed
  URL is for its TTL). TTLs are generous (hours) so an open view keeps
  rendering; a long-open view re-resolves on reload.
- **Liveness keys on `storage_path`.** A non-null `storage_path` means
  the object is present; null means expired/reclaimed. `extracted_text`
  (attachments, documents) survives object deletion so old conversations
  still read sensibly.
- **SupabaseService owns the I/O.** Per-bucket upload / signed-URL /
  download / remove helpers live there (e.g. `uploadDocumentFile` +
  `createDocumentDownloadUrl`; `addAttachments` +
  `createAttachmentSignedUrls` + `downloadAttachmentBlob`;
  `uploadRecipeImageObject` + the signed-URL resolution inside
  `listRecipePhotos`).

## Object lifecycle: the server-side sweeps

**SQL cannot delete a Storage object.** So anywhere objects need
reclaiming, the deletion runs in an **edge function** (service-role
Storage client), triggered by `pg_cron` -> `pg_net`, reusing the same
Vault-secret plumbing as the embeddings backfill (see
[`./embeddings.md`](./embeddings.md) and
[`./build-deploy.md`](./build-deploy.md)). Each is idempotent (deleting a
missing object or row is a no-op), self-bounding (batch + time budget),
and deployed via its own line in `.github/workflows/deploy.yml`.

- **`expire-attachments`** (hourly): deletes attachment objects whose
  owning thread has been dormant 30 days, then nulls `storage_path` +
  stamps `expired_at`. Backed by `list_expirable_attachments` /
  `mark_attachments_expired`.
- **`recipe-image-gc`** (every 6h): deletes `recipe_images` rows with no
  `recipe_version_images` link AND their bucket object - both insert-side
  and delete-side orphans. Backed by `list_orphan_recipe_images` /
  `delete_orphan_recipe_images`; the delete re-checks "still no link" to
  skip a row re-linked mid-sweep. Replaced the old in-transaction orphan
  trigger, which could only delete the row, never the object.
- **`documents`** has no sweep - Library docs are persistent and deleted
  explicitly by the user (`deleteDocument` removes the object then the
  row).

The pure drain loops are unit-tested offline in
`supabase/functions/_shared/*` (`expire-attachments.ts`,
`recipe-image-gc.ts`); the edge handlers are glue.

## Text extraction (the one direct-to-Venice exception)

Non-image uploads (attachments + Library docs) are run through Venice's
`/augment/text-parser` to populate `extracted_text`. That call is still
made **directly from the browser** (`VeniceClient.extractText`), and is
currently CORS-blocked - the fix (route it through the venice edge
function) is tracked in
[`./in-progress/venice-edge-functions/text-parser.md`](./in-progress/venice-edge-functions/text-parser.md).
It's orthogonal to byte storage: extraction produces the searchable text,
the bucket holds the bytes.

## Gotchas

- **Signed URLs, not public URLs.** The buckets are private; never switch
  one to public to "simplify" rendering - the signed URL with its TTL is
  the access control.
- **The RLS self-prefix is load-bearing.** Every object key must start
  `<user_id>/`; the `storage.objects` policy enforces it. A key that
  doesn't start with the caller's uid is unreadable/unwritable by them.
- **SQL can't touch Storage** - any object cleanup is an edge-function
  concern, never a trigger or RPC. This is why the sweeps exist.
- **Re-applying `schema.sql` is safe**: bucket inserts are
  `on conflict do nothing`, policies are `drop ... if exists` + recreate,
  and the retired base64 columns are `drop column if exists`.
