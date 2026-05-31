# Attachments

## Role

Per-message file attachments - queued in the composer, the original
bytes stored in the private `attachments` Storage bucket, surfaced to
Venice chat requests as signed URLs (images) or fenced extracted text
(documents), and reclaimed 30 days after the owning thread goes dormant.

Byte storage follows the app-wide model in
[`./file-storage.md`](./file-storage.md) (private buckets, signed-URL
reads, `storage_path` pointers, server-side expiry sweep). This doc
covers the attachment-specific pieces.

## Files

- `supabase/schema.sql` - the `message_attachments` table + RLS, the
  `attachments` bucket + its `storage.objects` policies, and the expiry
  sweep RPCs (`list_expirable_attachments`,
  `mark_attachments_expired`) + cron dispatcher.
- `src/lib/attachments.ts` - pure helpers: size validation,
  `isConsumableBy` predicate, base64 helpers (composer-side, in-memory),
  canvas-based `maybeDownscaleImage`, and the `buildUserVeniceContent`
  transformer that builds the string-vs-content-array wire shape (it
  takes pre-resolved image URLs; it does not read bytes).
- `src/lib/supabase.ts` - `Attachment` / `NewAttachment` types,
  `addAttachments` (uploads to the bucket, stores `storage_path`),
  `listAttachmentsByMessageIds` (projects `storage_path`, no bytes),
  `createAttachmentSignedUrls` (batched), `downloadAttachmentBlob`,
  `findImageByFilenameInThread`, `findAttachmentByFilenameInThread`,
  `listAttachmentSummariesForThread`. `listMessages` co-fetches
  attachments for user AND assistant rows (assistant rows can carry
  generate_image output).
- `src/lib/venice.ts` - `VeniceMessage.content` widened to
  `string | ContentPart[]`; `VeniceClient.extractText(blob, filename)`
  (`POST /augment/text-parser`, multipart). NOTE: extractText is still a
  direct browser call and currently CORS-blocked - see
  [`./in-progress/venice-edge-functions/text-parser.md`](./in-progress/venice-edge-functions/text-parser.md).
- `src/lib/chat-loop.ts` - `toVeniceMessage` accepts `visionSpec` +
  `imageUrls` (the pre-resolved signed URLs) and routes user rows through
  `buildUserVeniceContent` when they carry attachments.
- `src/lib/extractedTextDrawer.svelte.ts` - rune-based singleton store
  driving the right-side drawer.
- `src/components/MessageAttachments.svelte` - per-message list. Splits
  attachments via `partitionAttachments`; resolves signed URLs in an
  effect and renders live images as previews / files + expired images as
  chips.
- `src/lib/ui/message-attachments.ts` - `partitionAttachments` (liveness
  on `storage_path`). Pure UI primitive.
- `src/components/AssistantBody.svelte` - renders `MessageAttachments`
  for generated images on the assistant reply.
- `src/lib/tools/generate_image.ts` + `.schema.ts` - the generate_image
  tool (gated `images` toolbox); returns a compact descriptor with the
  base64 payload stashed under a key the chat-loop harvests.
- `src/lib/tools/generated-image.ts` - pure harvest/strip helpers:
  `extractGeneratedImage`, `stripGeneratedImage`,
  `generatedImageToNewAttachment`, `GENERATED_IMAGE_RESULT_KEY`.
- `src/components/ExtractedTextDrawer.svelte` - full-height right-side
  drawer: filename header, extracted text as a `<pre>` body.
- `supabase/functions/expire-attachments/index.ts` +
  `_shared/expire-attachments.ts` - the server-side expiry sweep
  (replaced the old browser `attachment_expiry` worker). See
  [`./file-storage.md`](./file-storage.md).
- `src/screens/Chat.svelte` - composer state, paperclip button, paste
  handler, drag-drop overlay, preview chips, pre-send guard, the
  signed-URL pre-resolution before a send, attachment rendering.

## Entry points

- **User picks a file** - `addAttachment(file)` in `Chat.svelte`.
  Validates size, downscales images via `maybeDownscaleImage`,
  base64-encodes into the in-memory `pendingAttachments` (a
  `LocalAttachment`), calls `app.venice.extractText` for non-image files.
- **User sends** - `send()`: pre-send guard, `addMessage` for the user
  row, then `addAttachments` which uploads each file's bytes to the
  `attachments` bucket (client-minted id -> `<uid>/<id>/<filename>`) and
  inserts the row with `storage_path`. Before the Venice call the
  chat-loop pre-resolves signed URLs for the live image attachments and
  threads them through `toVeniceMessage` -> `buildUserVeniceContent`.
- **Message replayed on reload** - `listMessages` co-fetches attachment
  metadata (storage_path, no bytes); `MessageAttachments` resolves signed
  URLs for rendering.
- **Model generates an image** - `generate_image` returns a compact
  descriptor with the base64 under `GENERATED_IMAGE_RESULT_KEY`; the
  chat-loop harvests it, strips it from the tool-result row, and at end
  of turn writes it via `addAttachments` (same bucket upload path),
  firing `onAssistantAttachments` to patch the live row.
- **Expiry** - the `expire-attachments` edge function (hourly cron)
  deletes bucket objects whose thread is 30 days dormant, then nulls
  `storage_path` + stamps `expired_at`. No open tab required.

## Data model

`public.message_attachments` columns:

| Column | Purpose |
| --- | --- |
| `id uuid pk` | Surrogate key (minted client-side so upload + insert share the key). |
| `message_id uuid` | FK -> `messages(id)` `on delete cascade`. |
| `position int` | Stable render order within the message. |
| `filename text` | Original filename, preserved across expiry. |
| `mime_type text` | MIME captured at upload time. |
| `size_bytes int` | Original size; truthful post-expiry. |
| `storage_path text` | Object key in the `attachments` bucket; NULL once the object is deleted (expired). |
| `extracted_text text` | Venice text-parser output; survives expiry. |
| `expired_at timestamptz` | NULL while live; stamped when the object is deleted. |
| `created_at timestamptz` | Insert time. |

Indexes: `message_attachments_message_idx` on `(message_id, position)`
(per-message fetch order); `message_attachments_live_idx` on
`(message_id) where storage_path is not null` (keeps the expiry scan
tiny).

RLS: four policies (select/insert/update/delete), each via-parent-of-
parent - `messages.thread_id -> threads.user_id = auth.uid()`.

## Contracts

- **"Live" vs "expired"**: `storage_path is not null` is live;
  `storage_path is null AND expired_at is not null` is expired.
  `extracted_text` is independent and survives the transition.
- **Conversation "last updated"**: `threads.updated_at`, bumped by
  `SupabaseService.addMessage`. The expiry sweep reads it for the
  30-day dormancy gate.
- **`isConsumableBy(attachment, spec)`**: single source of truth for
  whether the pre-send guard allows a file along. Image -> true (vision
  inlines it; non-vision tiers get an analyze_image note); non-empty
  `extracted_text` -> true; else false.
- **Thread-scoped image lookup**: `analyze_image` reaches an image via
  `findImageByFilenameInThread` (joins `messages.thread_id`, most recent
  match regardless of expiry), then hands Venice a signed URL; expired
  (`storage_path === null`) throws an actionable error. Thread-scoped so
  the model can re-analyze an image attached on a prior turn.
- **Generated images never put base64 on the tool-result row**: the
  ~700KB base64 rides under `GENERATED_IMAGE_RESULT_KEY` and is stripped
  before `encodeToolContent`; the bytes reach the user via the bucket
  upload on the terminal assistant row. Otherwise identical to uploads -
  same bucket, same expiry sweep, same RLS chain.
- **`<thread_attachments>` system block**: built once per turn from
  `listAttachmentSummariesForThread` (metadata-only projection). Lists
  live images, live documents, and expired filenames; empty sections add
  zero tokens.

## Interactions

- **File storage** ([`./file-storage.md`](./file-storage.md)) - the
  bucket, signed-URL reads, and the `expire-attachments` sweep follow the
  shared model; that doc is canonical for the storage mechanics.
- **Chat** ([`./chat.md`](./chat.md)) - composer paste/drag-drop UX +
  the `send()` path that materialises attachments and pre-resolves the
  vision URLs.
- **Venice adapter** - `extractText`, `generateImage`
  (`POST /image/generate`), widened `VeniceMessage.content`. See
  [`./architecture.md`](./architecture.md).
- **Tools** ([`./tools.md`](./tools.md)) - `generate_image` (images
  toolbox) flows output through the attachment path; `analyze_image`,
  `doc_create`, `recipe_photos_attach` all read attachment bytes via the
  bucket (signed URL or `downloadAttachmentBlob`).
- **Models** - `ModelSpec.supportsVision` gates inline images.
- **Realtime**: `subscribeToMessages` echoes a `messages` INSERT without
  the joined attachments, so `Chat.svelte` fires a follow-up
  `listAttachmentsByMessageIds` for user- AND assistant-role inserts and
  re-runs `appendMessage` with the hydrated row (cross-tab sync + the
  generated-image case). `mergeMessagesById` prefers the DB-fetched row.

## Gotchas

- **Liveness is `storage_path`, not bytes.** Reads project `storage_path`
  and mint signed URLs; a thread full of images no longer ships base64 on
  every open. See [`./file-storage.md`](./file-storage.md).
- **Multipart boundary on text-parser**: don't set a Content-Type header
  on the `extractText` fetch - the browser emits the correct
  `multipart/form-data; boundary=...` from the `FormData`. (This call is
  also the CORS-blocked one pending the edge-function route.)
- **Canvas downscale is main-thread**: `maybeDownscaleImage` blocks while
  painting to a canvas. One-off on user action; acceptable.
- **Extracted text outlives the object by design**: a year-old
  conversation with expired files still reads sensibly because
  `extracted_text` doesn't expire.
- **Non-vision tier + image in history**: history replay skips images on
  a non-vision tier silently (the model can't render them); the pre-send
  guard only judges the pending message, which is correct.
