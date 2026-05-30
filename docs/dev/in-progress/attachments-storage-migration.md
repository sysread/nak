# Attachments storage migration

An in-progress plan to move `message_attachments` file bytes off
base64-in-Postgres and into a private Supabase Storage bucket -
the same `documents` bucket pattern the Library already uses - so
the app has one file-storage mechanism instead of two.

This is the FOLLOW-UP noted in `supabase/schema.sql` on the
`message_attachments` block and in
[`../../attachments.md`](../../attachments.md) (Gotchas).

## Why

`message_attachments.data` holds the file body as base64 in a
`text` column. That was a deliberate, bounded choice: attachments
expire after 30 days, so the bloat is capped (see
[`../../attachments.md`](../../attachments.md)). The Library then
introduced a private `documents` bucket for persistent originals,
leaving the repo with two storage mechanisms. This unifies them:
attachments move to an `attachments` bucket, the same way
documents already work.

Secondary win: thread load stops dragging every attachment's
base64 into memory. Today `listMessages` co-fetches the `data`
column for every message; a thread full of images ships megabytes
of base64 on every open. Post-migration, thread load carries only
metadata + a `storage_path`, and bytes are fetched on demand (or,
for the model, fetched by Venice directly via a signed URL).

## Resolved decisions

The four forks, settled with the user:

1. **Venice vision wire = signed URL, not inlined base64.**
   Venice's chat/completions `image_url.url` accepts "a data URL
   with a base64 encoded image OR a public URL. URL must be
   publicly accessible"
   (https://docs.venice.ai/api-reference/endpoint/chat/completions).
   A Supabase signed URL from the private bucket is publicly
   fetchable for its TTL, so we hand Venice a signed URL and it
   pulls the image server-side. No client byte download; history
   replay regenerates cheap URLs (batched) instead of re-shipping
   bytes. The base64 data URI stays available as a fallback.
2. **Expiry runs server-side** (pg_cron -> edge function, service
   role), not in the browser worker. Bucket objects are real
   storage cost; cleanup must not depend on an open tab. Reuses
   the embeddings-backfill cron/edge-function/Vault-key infra.
3. **`recipe_images` is out of scope.** It is a third base64 store
   (dedup-by-sha256, different lifecycle); folding it in is a
   separate task.
4. **No backfill of existing rows.** Liveness keys off
   `storage_path`, so every pre-migration row is "expired" by
   definition - no migration code, no dual-read. Existing rows
   keep their preserved `extracted_text`, so they still render as
   expired chips and `doc_create` can still promote them from
   text. The bytes of recently-uploaded (not-yet-expired)
   attachments are lost immediately; acceptable for an app in
   active development.

## State machine change

Liveness flips from the `data` column to `storage_path`:

- **Live:** `storage_path is not null` (bytes in the bucket).
- **Expired / unavailable:** `storage_path is null` (a legacy
  base64 row treated as expired, or a bucket row whose object the
  sweep deleted). `extracted_text` survives either way.

`expired_at` becomes informational (when it expired). Every read
that currently tests `data_base64 !== null` for liveness switches
to `storage_path !== null`. The inventory of those sites is in
[`../../attachments.md`](../../attachments.md) Files/Contracts and
was re-confirmed during planning.

## Schema (`supabase/schema.sql`)

- Add `storage_path text` to `message_attachments` (null =
  legacy/expired; non-null = in bucket).
- Add an `attachments` Storage bucket + three `storage.objects`
  RLS policies, mirroring the `documents` bucket exactly
  (`(storage.foldername(name))[1] = auth.uid()::text`).
- Keep the `data` column this PR (the reclaim UPDATE references
  it; reads stop touching it).
- One-time, idempotent bloat reclaim:

  ```sql
  update public.message_attachments
     set data = null, expired_at = now()
   where storage_path is null and data is not null;
  ```

  Re-runs are no-ops: new rows never set `data`, and once nulled
  the `WHERE` matches nothing.
- Rewrite `expire_old_attachments` (or replace it) for the
  server-side sweep - see Expiry below.

**Object key:** `<user_id>/<attachment_id>/<filename>`, matching
the documents convention. The id is needed to build the path, so
**generate attachment UUIDs client-side** (override the
`gen_random_uuid()` default) and `addAttachments` uploads + writes
`storage_path` in one shot. (Documents used a two-phase
create->upload->update; client UUIDs are tidier for the bulk
insert here.)

## Write paths

- `SupabaseService.addAttachments` (uploads) and the
  generated-image path in `src/lib/chat-loop.ts` (via
  `generatedImageToNewAttachment`) upload bytes to the bucket and
  store `storage_path`; they stop writing base64 into `data`.
- New Storage helpers on `SupabaseService`, mirroring the document
  ones: `uploadAttachmentFile`, `createAttachmentSignedUrl(s)`,
  and object removal used by the sweep.

## Read paths

- `listMessages` / `listAttachmentsByMessageIds` stop projecting
  `data`; they return metadata + `storage_path`. Thread load gets
  lighter.
- `src/components/MessageAttachments.svelte` +
  `src/lib/ui/message-attachments.ts`: liveness on `storage_path`;
  image previews and download links use **signed URLs** resolved
  asynchronously (batched `createSignedUrls`) instead of in-memory
  base64 / object URLs.
- `src/lib/attachments.ts` `buildUserVeniceContent` becomes
  URL-driven: the chat-loop pre-resolves signed URLs for the live
  image attachments and passes them in, keeping the builder a
  (mostly) pure transform. The data-URI builder `dataUrlFor` is
  retired once nothing inlines base64.
- `src/lib/tools/analyze_image.ts`: hand Venice a signed URL for
  the looked-up image instead of downloading + inlining base64;
  the "expired" branch becomes `storage_path is null`.
- `src/lib/tools/doc_create.ts`: an attachment being promoted is
  downloaded from the attachments bucket (via signed URL or the
  storage download API) to re-upload into the documents bucket;
  the expired branch (no bytes, text only) is unchanged.
- `src/lib/tools/recipe_photos_attach.ts`: fetch bytes from the
  bucket to compute the sha256 + upsert into `recipe_images`
  (still base64 - out of scope to change). The expired branch is
  unchanged.

A shared helper resolves "bytes / signed URL for this attachment"
so consumers do not each branch on storage-vs-legacy. Since legacy
rows are treated as expired, the helper only has to handle
"bucket" vs "gone" - no base64 branch.

## Expiry (server-side)

Supabase Storage has **no native per-object TTL**, so expiry is
explicit deletion. The sweep:

1. Find live bucket attachments whose thread settled >= 30 days
   ago (`storage_path is not null`, thread `updated_at` old),
   bounded per invocation.
2. `storage.from('attachments').remove([paths])` (service role);
   deleting an already-gone object is harmless, so a crash
   mid-sweep just retries cleanly.
3. Stamp `expired_at`, null `storage_path`.

Driven by `pg_cron` -> the edge function, reusing the
embeddings-backfill plumbing (see
[`./venice-edge-functions/embeddings.md`](./venice-edge-functions/embeddings.md)).
The SQL can't delete objects, so even the "RPC" half is the edge
function holding the service-role storage client; SQL only does
the row claim/mark. The legacy `data`-nulling path folds in: a
row with `data` set but no `storage_path` just gets `data` nulled
(no object to delete).

## Migration sequencing (tetris)

- **Stage 1 - data path (LANDED).** Bucket + RLS, client-UUID
  uploads, signed-URL reads (render + vision + analyze_image +
  doc_create + recipe_photos), the one-time reclaim UPDATE. The
  `data` column stays (write-never, read-never after the reclaim).
  The old browser expiry worker / `expire_old_attachments` RPC are
  left INERT - so bucket objects do not yet expire.
- **Stage 2 - server-side expiry sweep (LANDED, server side).** The
  standalone `expire-attachments` edge function + hourly pg_cron job,
  with the `list_expirable_attachments` / `mark_attachments_expired`
  service-role RPCs and the I/O-free `runExpiry` drain loop
  (`_shared/expire-attachments.ts`, unit-tested). Deployed via its own
  line in `deploy.yml`. Cron/Storage round-trip is unverified from the
  cloud env - confirm after deploy that an object actually disappears
  ~30 days after its thread goes dormant.
- **Stage 2b - retire the browser worker (LANDED).** Removed the
  `attachment_expiry` unit from the supervisor
  (`src/lib/agents/supervisor/{loop,manager,worker}.ts`), deleted
  `src/lib/agents/attachment_expiry/`, dropped
  `SupabaseService.expireOldAttachments` + the `expire_old_attachments`
  RPC (schema carries the idempotent `drop`), and removed
  `tests/attachment-expiry-loop.test.ts`. The supervisor now walks six
  units, not seven; expiry is entirely server-side.
- **Collapse PR (follow-up)** drops the `data` column AND removes
  the reclaim UPDATE together. Splitting is required: a single
  apply can't both keep an UPDATE that references `data` and drop
  `data` (the next sync would fail on the dangling reference).

## Stage 1 verification owed (no browser / live Venice from the cloud)

- Venice actually fetches the signed URL on a vision turn (the
  load-bearing assumption); fall back to the retained base64 data-
  URI path if it rejects URLs.
- Image preview + download links render from signed URLs
  (`MessageAttachments.svelte`), including the async resolve flicker.
- Upload round-trip (`addAttachments` -> bucket), and the
  download-from-bucket paths in `doc_create` / `recipe_photos_attach`.

## Tests

- `tests/attachments.test.ts`: `buildUserVeniceContent` switches
  from asserting inlined base64 data URIs to asserting the passed
  signed URLs; liveness fixtures use `storage_path`.
- `tests/generated-image.test.ts`: `partitionAttachments` /
  liveness on `storage_path`; `generatedImageToNewAttachment`
  shape (bytes now go to the bucket, not `data`).
- `tests/attachment-expiry-loop.test.ts`: rework for the
  server-side sweep shape (object delete + row mark) rather than
  the browser RPC cycle.
- `tests/chat-loop.test.ts`: `buildThreadAttachmentsBlock` is
  unaffected (already metadata-only), but the attachment-hydration
  fixtures drop `data`.

## Risks / verification

- **Signed-URL fetch by Venice** is the load-bearing assumption.
  Verify against the live API early: upload an image, send a
  vision turn, confirm Venice fetches the signed URL and the
  model sees the image. If a URL is ever rejected, fall back to
  the retained base64 data-URI path for that call.
- **Signed-URL TTL** must cover Venice's fetch window; use a
  generous TTL (minutes) and regenerate per send. No byte
  transfer, so a longer TTL is cheap.
- **Image preview flicker / loading state** in
  `MessageAttachments.svelte` now that URLs resolve async - needs
  a browser pass (the cloud agent can't render).
- **Recipe-photo + doc-create promotion** of a live attachment
  now crosses the network to fetch bytes; confirm both still work
  end to end.
