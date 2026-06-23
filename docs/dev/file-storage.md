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
| `attachments` | chat message files + generated images | `<user_id>/<attachment_id>/<filename>` | persistent; deleted by the user (Artifacts tab) or reclaimed when orphaned |
| `recipe-images` | cookbook photos | `<user_id>/<sha256>` (content-addressed) | persistent; reclaimed when orphaned |
| `wiki-record-files` | files attached to wiki records | `<user_id>/<file_id>/<filename>` | persistent; reclaimed when orphaned |

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
  the object is present; null means deleted/reclaimed. `extracted_text`
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

- **`attachment-gc`** (daily): deletes attachment-bucket objects with no
  `message_attachments` row - the orphans a thread deletion leaves behind
  (the cascade drops the rows; SQL can't drop the objects). Backed by
  `list_orphan_attachment_objects` (a `storage.objects` anti-join over the
  live `storage_path`s, with an age grace window so an in-flight upload's
  object isn't mistaken for an orphan). The client's `deleteThread` and the
  Artifacts-tab per-file delete remove their objects inline; this is the
  backstop for a failed inline remove or any pre-existing backlog. (There
  is no timed expiry sweep - attachments are kept until the user deletes
  them; images are compressed at upload so they're small at the source.)
- **`recipe-image-gc`** (every 6h): deletes `recipe_images` rows with no
  `recipe_version_images` link AND their bucket object - both insert-side
  and delete-side orphans. Backed by `list_orphan_recipe_images` /
  `delete_orphan_recipe_images`; the delete re-checks "still no link" to
  skip a row re-linked mid-sweep. Replaced the old in-transaction orphan
  trigger, which could only delete the row, never the object.
- **`wiki-record-file-gc`** (daily): deletes wiki-record-files bucket
  objects with no `wiki_record_files` row - the orphans a record/article
  delete cascade leaves behind (the cascade drops the rows; SQL can't drop
  the objects). Backed by `list_orphan_wiki_record_file_objects` (a
  `storage.objects` anti-join with an age grace window). The client's
  record-file delete + the `record_file_remove` tool remove objects
  inline; this is the backstop. A direct clone of `attachment-gc` (the
  orphan IS the object - no row-vs-object re-check). See
  [Wiki](./wiki.md).
- **`documents`** has no sweep - Library docs are persistent and deleted
  explicitly by the user (`deleteDocument` removes the object then the
  row).

The pure drain loops are unit-tested offline in
`supabase/functions/_shared/*` (`attachment-gc.ts`,
`recipe-image-gc.ts`); the edge handlers are glue.

## Text extraction

Non-image uploads (attachments + Library docs) are run through Venice's
`/augment/text-parser` to populate `extracted_text`. The browser calls
`SupabaseService.extractText(file, filename)`, which routes the
multipart upload through the venice edge function's `/text-parser`
route - the function holds the shared key server-side and relays the
response. Orthogonal to byte storage: extraction produces the
searchable text, the bucket holds the bytes.

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
