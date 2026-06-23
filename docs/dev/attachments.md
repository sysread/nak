# Attachments

## Role

Per-message file attachments - queued in the composer, the original
bytes stored in the private `attachments` Storage bucket, surfaced to
Venice chat requests as signed URLs (images) or fenced extracted text
(documents). Images are compressed in the browser on upload so they land
small at the source; attachments then persist until the user deletes them
from the Artifacts tab (there's no timed expiry sweep).

Byte storage follows the app-wide model in
[`./file-storage.md`](./file-storage.md) (private buckets, signed-URL
reads, `storage_path` pointers, server-side orphan GC). This doc
covers the attachment-specific pieces.

## Files

- `supabase/schema.sql` - the `message_attachments` table + RLS and the
  `attachments` bucket + its `storage.objects` policies. (The old timed
  expiry sweep RPCs + cron are retired - see the "Retired: scheduled
  attachment expiry" block.)
- `src/lib/attachments.ts` - pure helpers: size validation,
  `isConsumableBy` predicate, base64 helpers (composer-side, in-memory),
  canvas-based `compressImage` (the shared upload/generate compressor -
  caps the long edge AND walks a quality/dimension search toward
  `IMAGE_COMPRESSION_TARGET_BYTES`, returning before/after sizes),
  `maybeDownscaleImage` (the recipe-photo resizer - long-edge cap only, no
  byte target), and the `buildUserVeniceContent` transformer that builds
  the string-vs-content-array wire shape (it takes pre-resolved image URLs;
  it does not read bytes).
- `src/lib/ui/composer-attachments.ts` - pure `chipStatus` /
  `compressionLabel` primitives that resolve a pending attachment to its
  one chip state (compressing / pending / error / compressed / ready) and
  render the "Reduced from X to Y" note.
- `src/lib/supabase.ts` - `Attachment` / `NewAttachment` types,
  `addAttachments` (uploads to the bucket, stores `storage_path`),
  `listAttachmentsByMessageIds` (projects `storage_path`, no bytes),
  `createAttachmentSignedUrls` (batched), `downloadAttachmentBlob`,
  `findImageByFilenameInThread`, `findAttachmentByFilenameInThread`,
  `listAttachmentSummariesForThread`, `listArtifacts` (the cross-thread
  Artifacts listing, joined to each owning thread's title), and
  `deleteAttachment` (the Artifacts-tab per-file delete: mark expired +
  best-effort object remove). `listMessages` co-fetches attachments for
  user AND assistant rows (assistant rows can carry generate_image output).
- `src/lib/artifacts-store.svelte.ts` - reactive store for the Artifacts
  tab (results + query/kind/sort filters + paging), driven by
  `listArtifacts` with a monotonic load token guarding stale results.
- `src/lib/ui/artifacts-list.ts` - pure primitives for the tab: the
  kind/sort option tables, the empty/scanner labels, the image predicate.
- `src/components/ArtifactsList.svelte` - the Artifacts drawer list:
  filename search + type/sort filters, image thumbnails (batched signed
  URLs), per-row delete, click-to-open-conversation.
- `src/lib/venice.ts` - `VeniceMessage.content` widened to
  `string | ContentPart[]`.
- `src/lib/supabase.ts` - `SupabaseService.extractText(blob, filename)`
  routes the multipart upload through the venice edge function's
  `/text-parser` route; the function holds the shared key and relays
  the response.
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
- `src/components/GeneratedImageCard.svelte` - the dedicated card for a
  `generate_image` output, rendered as its own assistant bubble below
  the tool-call card. Resolves the image by filename
  (`findImageByFilenameInThread`) with a bounded retry, shows a Scanner
  placeholder sized to the image's aspect ratio until it lands, then
  delegates the render to `MessageAttachments`. See "Generated-image
  rendering" under Gotchas.
- `src/lib/ui/generated-image.ts` - pure browser-side primitives for
  the card: `parseGeneratedImageResult` (descriptor off the tool-result
  row), `aspectRatioCss`, and `generatedImagesForGroup` (which
  tool-group calls get a card). Unit-tested in
  `tests/generated-image.test.ts`.
- `src/lib/tools/generate_image.ts` + `.schema.ts` - the generate_image
  tool (gated `images` toolbox); returns a compact descriptor with the
  base64 payload stashed under a key the chat-loop harvests.
- `src/lib/tools/generated-image.ts` - pure harvest/strip helpers:
  `extractGeneratedImage`, `stripGeneratedImage`,
  `generatedImageToNewAttachment`, `GENERATED_IMAGE_RESULT_KEY`.
- `src/components/ExtractedTextDrawer.svelte` - full-height right-side
  drawer: filename header, extracted text as a `<pre>` body.
- `supabase/functions/attachment-gc/index.ts` +
  `_shared/attachment-gc.ts` - the daily orphan-object GC sweep, backed by
  the `list_orphan_attachment_objects` RPC. Reclaims bucket objects with no
  `message_attachments` row (the orphans a thread deletion leaves behind).
  See [`./file-storage.md`](./file-storage.md).
- `src/screens/Chat.svelte` - composer state, paperclip button, paste
  handler, drag-drop overlay, preview chips, pre-send guard, the
  signed-URL pre-resolution before a send, attachment rendering.

## Entry points

- **User picks a file** - `addAttachment(file)` in `Chat.svelte`.
  Validates size, compresses oversized images via `compressImage` (the chip
  shows a "Compressing large image..." spinner, then "Reduced from X to Y"
  when it shrank), base64-encodes into the in-memory `pendingAttachments` (a
  `LocalAttachment`), calls `app.supabase.extractText` for non-image files.
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
  edge orchestrator (`getStreamingResponse.ts`) harvests it, strips it
  from the tool-result row, and attaches it per-round to that round's
  assistant-with-tool-calls row via a `message_attachments` insert. The
  browser does NOT get a realtime nudge for that insert (it's a separate
  table, and the assistant row was already echoed), so
  `GeneratedImageCard` resolves the image by filename instead - see
  "Generated-image rendering" under Gotchas.
- **Manual delete** - from the Artifacts tab, `deleteAttachment` marks
  the row expired (null `storage_path` + stamp `expired_at`, RLS-scoped to
  the owner) and best-effort removes the bucket object; the `attachment-gc`
  sweep reclaims the object if that remove misses. This is the only path
  that reclaims an attachment now - there is no timed expiry.
- **Thread deletion** - `SupabaseService.deleteThread` collects the
  thread's live attachment keys before the cascade removes their rows, then
  best-effort removes those bucket objects after the thread is gone. The
  daily `attachment-gc` sweep is the backstop for whatever that misses (a
  failed inline remove, or objects from threads deleted before this path
  existed). See [`./file-storage.md`](./file-storage.md).

## Artifacts tab

A drawer tab (`drawer=artifacts`, routed alongside the other tabs in
`routing.svelte.ts`) that lists every LIVE attachment the user owns,
across all conversations, for review and cleanup. It's a management
surface, not a panel: clicking a row navigates to the file's
conversation (`navigate({ cid })`), so the tab shares the chats
main-view + top-bar rather than rendering its own panel (the
`drawerTab === 'chats' || 'artifacts'` branches in `Chat.svelte`).

- **Listing** - `listArtifacts` pages `message_attachments` newest- or
  largest-first, filtered by filename substring and kind (image vs
  file), with each row joined to its owning thread's title. Only live
  rows (`storage_path` non-null) are listed; RLS scopes the whole query
  (including the embedded `messages`/`threads`) to the caller. One extra
  row past the page size drives `hasMore` without a count query.
- **Delete** - `deleteAttachment` marks the row expired client-side
  (null `storage_path` + stamp `expired_at`, allowed by the
  self-update RLS policy) then best-effort removes the object. The row
  survives, so the message still renders the greyed placeholder;
  `attachment-gc` reclaims the object if the remove missed.
- **Thumbnails** - image rows resolve previews through the same batched
  `createAttachmentSignedUrls` the message renderer uses.

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
- **"Expired" is now user-initiated**: the null-`storage_path` +
  `expired_at` state and its placeholder rendering survive, but a manual
  delete from the Artifacts tab is what produces it - no timer does.
- **`isConsumableBy(attachment, spec)`**: single source of truth for
  whether the pre-send guard allows a file along. Image -> true (vision
  inlines it; non-vision tiers get an analyze_image note); non-empty
  `extracted_text` -> true; else false.
- **Thread-scoped image lookup**: `analyze_image` (server-side, in the
  venice edge function) reaches an image by joining `message_attachments`
  to `messages` on `thread_id` (most recent match regardless of expiry),
  downloads the bytes from the bucket, and inlines them to Venice as a
  base64 data URL; expired (`storage_path === null`) throws an actionable
  error. Thread-scoped so the model can re-analyze an image attached on a
  prior turn. (Inlining rather than a signed URL avoids Venice failing to
  fetch a URL that resolves to an internal host in local/dev runtimes.)
- **Generated images never put base64 on the tool-result row**: the
  ~700KB base64 rides under `GENERATED_IMAGE_RESULT_KEY` and is stripped
  before `encodeToolContent`; the bytes reach the user via the bucket
  upload on the round's assistant-with-tool-calls row (per-round, not at
  terminal commit - so a same-turn `recipe_photos_attach` can resolve
  the image by filename). Otherwise identical to uploads - same bucket,
  same RLS chain, same manual-delete path.
- **`<thread_attachments>` system block**: built once per turn from
  `listAttachmentSummariesForThread` (metadata-only projection). Lists
  live images, live documents, and expired filenames; empty sections add
  zero tokens.
- **Attachment-inspection reinforcement**: when the user message that
  opened the turn carries a file (`currentTurnHasAttachments`, threaded
  from `Chat.svelte` and keyed on the opening user-message id), the
  per-turn metadata system message gains an anti-fabrication paragraph
  (see `buildMetadataSystemMessage`). It pins any claim about a file's
  contents to material actually inspected this turn - the inlined
  extracted text, the inlined image, or an `analyze_image` result - and
  tells the model to call the tool or admit it can't see the file rather
  than answer from the filename. Gated on the current turn (not the
  thread-wide inventory) so a later text-only turn in a thread with an
  old upload pays nothing for it.

## Interactions

- **File storage** ([`./file-storage.md`](./file-storage.md)) - the
  bucket, signed-URL reads, and the `attachment-gc` orphan sweep follow the
  shared model; that doc is canonical for the storage mechanics.
- **Chat** ([`./chat.md`](./chat.md)) - composer paste/drag-drop UX +
  the `send()` path that materialises attachments and pre-resolves the
  vision URLs.
- **Venice adapter** - widened `VeniceMessage.content`. Vision URLs and
  generated-image bytes ride the wire through this type. See
  [`./architecture.md`](./architecture.md).
- **SupabaseService** - `extractText` (multipart upload routed through
  the venice edge function's `/text-parser` route) and `generateImage`
  (the `generate_image` tool runs server-side inside `/stream`'s tool
  dispatch). See
  [`../../supabase/functions/README.md`](../../supabase/functions/README.md).
- **Tools** ([`./tools.md`](./tools.md)) - `generate_image` (images
  toolbox) flows output through the attachment path; `analyze_image`,
  `doc_create`, `recipe_photos_attach` all read attachment bytes via the
  bucket (signed URL or `downloadAttachmentBlob`).
- **Models** - `ModelSpec.supportsVision` gates inline images.
- **Wiki records** (`docs/dev/wiki.md`) - the `record_file_attach` tool
  reuses the thread-scoped filename resolver (the `analyze_image` lookup)
  to find a file in the conversation, then copies its bytes out of the
  `attachments` bucket into the persistent `wiki-record-files` bucket. So
  a chat attachment (user upload or `generate_image` output) can be
  promoted onto a wiki record and outlive the 30-day attachment expiry.
- **Realtime**: `subscribeToMessages` echoes a `messages` INSERT without
  the joined attachments, so `Chat.svelte` fires a follow-up
  `listAttachmentsByMessageIds` for USER-role inserts and re-runs
  `appendMessage` with the hydrated row (upload cross-tab sync).
  Assistant rows are excluded on purpose: their only attachment source
  is `generate_image`, which is attached server-side AFTER the row's
  INSERT echo, so this fetch would race ahead of the attach and find
  nothing. `GeneratedImageCard` resolves those by filename instead - see
  "Generated-image rendering" below. `mergeMessagesById` prefers the
  DB-fetched row.

## Gotchas

- **Generated-image rendering goes through a dedicated card, not the
  message attachment slot.** The image is attached server-side to the
  round's assistant-with-tool-calls row, AFTER that row was inserted and
  echoed over realtime, and the `message_attachments` insert fires no
  `messages` event of its own. So the producing tab's in-memory row
  never re-hydrates with the attachment - before this card existed, the
  image only appeared after a full `listMessages` on reload.
  `Chat.svelte`'s message-block builder emits a `generated-image` block
  (via `generatedImagesForGroup`) right after the tool-group block, and
  `GeneratedImageCard` resolves the image itself by filename
  (`findImageByFilenameInThread`, thread-scoped + RLS-safe) with a
  bounded retry covering the rare mount-before-attach race. This is why
  `AssistantBody` no longer takes an `attachments` prop and the realtime
  hydration above skips assistant rows: generated images are the card's
  job now, resolved by filename rather than by the realtime path that
  never delivered them. The server attaches BEFORE it publishes the
  `tool_call_response` that makes the card appear, so the first lookup
  almost always wins; the retry is just insurance.

- **Liveness is `storage_path`, not bytes.** Reads project `storage_path`
  and mint signed URLs; a thread full of images no longer ships base64 on
  every open. See [`./file-storage.md`](./file-storage.md).
- **Multipart boundary on text-parser**: `SupabaseService.extractText`
  passes a `FormData` body through `functions.invoke`, which leaves
  Content-Type unset so the runtime writes the multipart boundary
  itself. Don't add a Content-Type override; doing so trashes the
  boundary parameter and Venice rejects the upload.
- **Canvas compression is main-thread**: `compressImage` (uploads) and
  `maybeDownscaleImage` (recipe photos) block while painting to a canvas.
  A worker/OffscreenCanvas path is rejected on purpose - Safari < 16.4
  lacks the decode+encode it needs, and the composer ships to every modern
  browser. The bounded quality/dimension search keeps it a sub-second
  one-off on user action; acceptable.
- **Extracted text outlives the object by design**: a year-old
  conversation with expired files still reads sensibly because
  `extracted_text` doesn't expire.
- **Non-vision tier + image in history**: history replay skips images on
  a non-vision tier silently (the model can't render them); the pre-send
  guard only judges the pending message, which is correct.
- **No empty text part in a multimodal content array**:
  `buildUserVeniceContent` only emits the leading `{type:'text'}` part
  when `composedText` is non-empty. An image-only turn (no typed words,
  no extracted-text blocks, no analyze_image note on a vision tier)
  leaves `composedText` empty; Venice 400s with "Text content cannot be
  empty" if that empty part ships. Image_url parts stand alone, so the
  array carries only the image part in that case.
