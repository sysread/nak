# Attachments

> **Storage migration in progress.** Attachment bytes now live in a
> private `attachments` Storage bucket (the `documents` pattern), not as
> base64 in `message_attachments.data`. Liveness keys on `storage_path`,
> reads go through signed URLs, and the legacy base64 was reclaimed
> one-time (pre-bucket rows are treated as expired). Expiry now runs
> **server-side** (the standalone `expire-attachments` edge function +
> hourly cron deletes bucket objects 30 days after a thread goes
> dormant; the browser `attachment_expiry` worker + its RPC have been
> removed; the legacy `data` column is dropped). The migration is
> complete bar a post-deploy check that the expiry sweep deletes an
> object. See
> [`./in-progress/attachments-storage-migration.md`](./in-progress/attachments-storage-migration.md).
> Sections below are mid-update; where they describe base64-in-`data`,
> read it as "historical, now storage_path + bucket".

## Role

Per-message file attachments — queued in the composer, the original
bytes stored in the private `attachments` Storage bucket, surfaced to
Venice chat requests as signed URLs the model can consume, and (once the
server-side sweep lands) reclaimed after a 30-day dormancy window.

## Files

- `supabase/schema.sql` — the `message_attachments` table + RLS
  policies + `expire_old_attachments(days int)` RPC.
- `src/lib/attachments.ts` — pure helpers: size validation,
  `isConsumableBy` predicate, base64 round-trip, canvas-based
  `maybeDownscaleImage`, and the `buildUserVeniceContent`
  transformer that decides string-vs-content-array for the wire.
- `src/lib/supabase.ts` — `Attachment` / `NewAttachment` types,
  `addAttachments`, `listAttachmentsByMessageIds`,
  `expireOldAttachments`. `listMessages` co-fetches attachments
  for user AND assistant rows (assistant rows can carry
  generate_image output).
- `src/lib/venice.ts` — `VeniceMessage.content` widened to
  `string | ContentPart[]`; new `VeniceClient.extractText(blob,
  filename)` that calls `POST /augment/text-parser` as
  multipart/form-data.
- `src/lib/chat-loop.ts` — `toVeniceMessage` accepts a
  `visionSpec` option and routes user rows through
  `buildUserVeniceContent` when they carry attachments.
- `src/lib/extractedTextDrawer.svelte.ts` — rune-based singleton
  store driving the right-side drawer.
- `src/components/MessageAttachments.svelte` — per-message list
  under user- and assistant-message bodies. Splits attachments via
  `partitionAttachments`: live images render as large previews
  (~85% of card width, wrapped in an anchor that opens the image in
  a new tab via its `blob:` URL); files and
  expired images render as compact chips - download anchor when
  live, filename plus clock icon (no anchor) plus the "Text" button
  when expired.
- `src/lib/ui/message-attachments.ts` — `partitionAttachments`, the
  image-vs-chip split. Pure UI primitive so the decision logic
  stays out of the `.svelte` markup.
- `src/components/AssistantBody.svelte` — takes an `attachments`
  prop and renders `MessageAttachments` between the body and the
  action bar; this is how generated images surface on the
  assistant reply (the plain assistant block and the tool-group
  block both pass it).
- `src/lib/tools/generate_image.ts` + `.schema.ts` — the
  generate_image tool (gated `images` toolbox). Calls
  `VeniceClient.generateImage` and returns a compact descriptor
  with the base64 payload stashed under a key the chat-loop
  harvests.
- `src/lib/tools/generated-image.ts` — pure harvest/strip helpers
  shared by the tool and the chat-loop: `extractGeneratedImage`,
  `stripGeneratedImage`, `generatedImageToNewAttachment`, and the
  `GENERATED_IMAGE_RESULT_KEY` constant.
- `src/components/ExtractedTextDrawer.svelte` — full-height
  right-side drawer with the filename as header and the
  extracted text as a `<pre>` body.
- `src/lib/agents/attachment_expiry/{manager,worker,loop}.ts` —
  the background worker that calls `expire_old_attachments`
  hourly.
- `src/screens/Chat.svelte` — composer state, paperclip button,
  paste handler, drag-drop overlay, preview chips, pre-send
  guard, attachment rendering in the user-message branch.

## Entry points

- **User picks a file** — `addAttachment(file)` in
  `Chat.svelte`. Validates size, downscales images via
  `maybeDownscaleImage`, base64-encodes, calls
  `app.venice.extractText` for non-image files, pushes into the
  `pendingAttachments` state.
- **User sends** — the `send()` function: pre-send guard
  (blocks on pending, errored, or tier-unreadable chips),
  `app.supabase.addMessage` for the user row, then
  `app.supabase.addAttachments` for every chip. Venice payload
  built by `toVeniceMessage(m, { visionSpec })` with
  `m.attachments` in play.
- **Message replayed on reload** — `listMessages` co-fetches
  attachments for user and assistant rows; `MessageAttachments`
  renders (under the user body, or inside `AssistantBody` for
  generated images).
- **Model generates an image** — the main model calls
  `generate_image` (gated `images` toolbox). The tool runs one
  `VeniceClient.generateImage` and returns a compact descriptor
  (`filename`, `width`, `height`) with the base64 stashed under
  `GENERATED_IMAGE_RESULT_KEY`. The chat-loop harvests the payload
  (`extractGeneratedImage`), strips it from the model-visible
  tool-result row (`stripGeneratedImage`), and at end of turn
  writes the image as a `message_attachments` row on the terminal
  assistant message via `addAttachments`, firing
  `onAssistantAttachments` so the live UI patches the in-memory row.
- **Expiration sweep** — `attachmentExpiryManager.start` spawns
  the Web Worker on unlock (parallel to the reflection and
  summary managers). The worker acquires the
  `'attachment_expiry'` lease kind and calls
  `expireOldAttachments(30)` hourly.

## Data model

`public.message_attachments` columns:

| Column | Purpose |
| --- | --- |
| `id uuid pk` | Surrogate key. |
| `message_id uuid` | FK → `messages(id)` `on delete cascade`. |
| `position int` | Stable render order within the message. |
| `filename text` | Original filename, preserved across expiry. |
| `mime_type text` | MIME captured at upload time. |
| `size_bytes int` | Original size; truthful post-expiry. |
| `data text` | Base64-encoded file body; NULL after expiry. |
| `extracted_text text` | Venice text-parser output; survives expiry. |
| `expired_at timestamptz` | NULL while live; stamped when binary is reclaimed. |
| `created_at timestamptz` | Insert time. |

Indexes:

- `message_attachments_message_idx` on `(message_id, position)` —
  drives the per-message list fetch and keeps the attachment order
  stable.
- `message_attachments_live_idx` on `(message_id) where data is not
  null` — keeps the expiration sweep's scan tiny in steady state.

RLS: four policies (select/insert/update/delete), each using the
via-parent-of-parent pattern —
`messages.thread_id → threads.user_id = auth.uid()`.

## Contracts

- **"Live" vs "expired"**: `data is not null AND expired_at is
  null` means live; `data is null AND expired_at is not null`
  means expired. The `extracted_text` column is independent of
  both and stays populated across the transition.
- **Conversation "last updated"**: measured by `threads.updated_at`,
  already bumped by `SupabaseService.addMessage` at
  `src/lib/supabase.ts:1255-1258`. Don't add a trigger — it would
  double-fire.
- **`isConsumableBy(attachment, spec)`**: single source of truth
  for whether the pre-send guard should allow a file to ride
  along. Image on vision tier → true; non-empty
  `extracted_text` → true; otherwise false. Both the composer
  guard and the `buildUserVeniceContent` send-path use it.
- **`expire_old_attachments(days)`**: returns row count; worker
  loops as long as >0, naps 1 hour on 0. `for update skip
  locked` in the CTE prevents two workers from clobbering the
  same row.
- **Thread-scoped attachment lookup**: `analyze_image` reaches
  image bytes via `SupabaseService.findImageByFilenameInThread`,
  which joins `message_attachments` against `messages.thread_id`
  and returns the most recent matching row regardless of expiry
  state. The tool itself decides whether to call (live), throw
  "expired" (`data_base64 === null`), or throw "not found" (null
  return). The earlier per-message contract — passing only the
  current user message's attachments through `ToolContext` —
  left the model unable to re-analyze an image once any
  follow-up message was sent; the thread-scoped lookup fixes
  that by trusting RLS to keep the scope honest.
- **Generated images never put base64 on the tool-result row**: a
  generate_image result the model reads carries only the compact
  descriptor; the ~700KB base64 rides under
  `GENERATED_IMAGE_RESULT_KEY` and is stripped before
  `encodeToolContent`. The bytes reach the user via the
  `message_attachments` attach on the terminal assistant row, never
  via the `role='tool'` content - otherwise the blob would replay
  into context every round and bloat every thread reload for no
  benefit (the model can't read pixels from a tool string). Generated
  images are otherwise indistinguishable from uploads: same table,
  same `expire_old_attachments` 30-day sweep, same RLS chain, same
  `findImageByFilenameInThread` reachability for `analyze_image`.
- **`<thread_attachments>` system block**: built once per turn in
  `runChatLoop` from
  `SupabaseService.listAttachmentSummariesForThread` (a
  lightweight projection — no `data` or `extracted_text` payload
  on the wire). Lists live images, live documents, and expired
  filenames in three sections; each section appears only when
  non-empty, and a thread with no attachments adds zero tokens.
  The block coexists with `buildUserVeniceContent`'s per-message
  inline note - the inline note remains the local "this turn
  brought these" signal, while the system block is the
  conversation-wide recall surface.

## Interactions

- **Chat**: the composer's paste/drag-drop UX lives in
  `Chat.svelte`; the `send()` path materialises attachments into
  the DB and builds the Venice wire shape. Docs in
  `./chat.md`.
- **Venice adapter**: we added `VeniceClient.extractText`,
  `VeniceClient.generateImage` (`POST /image/generate`), and
  widened `VeniceMessage.content`. See `./architecture.md` for
  the adapter conventions.
- **Tools**: `generate_image` is a gated tool in the `images`
  toolbox; its output flows back through the attachment path
  rather than the tool-result content. Catalog + toolbox model in
  `./tools.md`.
- **Models**: `ModelSpec.supportsVision` gates inline images.
  Keep the flag truthful as tiers are repointed; documented in
  `./chat.md`.
- **Workers / leases**: the attachment-expiry worker is another
  `worker_kind` on the existing `worker_leases` infra — see
  `./embeddings.md` for the lease + Web-Lock pattern. The
  manager mirrors `summary/manager.ts` and
  `reflection/manager.ts`.
- **Realtime**: `subscribeToMessages` fires for every `messages`
  INSERT with the row payload only — Postgres replication doesn't
  join `message_attachments`, so a row echo arrives with
  `attachments` unset. Chat.svelte's subscribe handler fires a
  follow-up `listAttachmentsByMessageIds([msg.id])` for every
  user- AND assistant-role INSERT and re-runs `appendMessage` with
  the hydrated row. Needed for (a) cross-tab sync (tab B sees tab
  A's insert and must hydrate itself) and (b) defense against a
  local race where the attachment-less echo arrives before the
  sender's own `appendMessage` can upgrade the row. The assistant
  case covers generated images; on the local sender the chat-loop's
  `onAssistantAttachments` handler already patched the row, so the
  realtime fetch is a redundant-but-harmless second attempt there.
  `mergeMessagesById` prefers the DB-fetched row, so a background
  slot whose buffered assistant row is attachment-less still shows
  the image on thread re-entry.
- **Logging**: the attachment-expiry worker's manager
  emits breadcrumbs through
  `createLogger('attachment-expiry-worker')`. Worker-side
  entries postMessage main-thread and appear in the
  in-app log drawer. See `./logging.md`.

## Gotchas

- **Bytes live in the `attachments` bucket, keyed on `storage_path`.**
  Liveness is `storage_path !== null`; a null path is the expired /
  legacy state (`extracted_text` survives). Reads never load bytes into
  the row - the UI mints signed URLs and Venice's vision input fetches a
  signed URL server-side. The `data` column is retained only for the
  one-time reclaim + the eventual drop. See the migration plan linked at
  the top. The base64-as-text notes below are historical.
- **Base64 stored as text, not bytea** (historical): the original design used a
  `bytea` column on the assumption that PostgREST serialises bytea
  as base64 on SELECT. It doesn't — PostgREST returns bytea as a
  hex-escaped string (`\x4869…`), which our client fed straight
  into `atob()` and tripped `InvalidCharacterError`. The write
  path was equally wrong: we were sending a base64 string into a
  bytea column and PostgreSQL stored whatever bytes happened to
  match, producing garbage on read-back. Switching to plain `text`
  storing the base64 directly makes the round-trip unambiguous.
  The TS type renames the column to `data_base64` to keep callers
  from confusing the base64 string with raw bytes.
- **Multipart boundary on text-parser**: don't set a
  Content-Type header on the text-parser fetch — the browser
  emits the correct `multipart/form-data; boundary=…` from the
  `FormData` body. Setting a JSON content type clobbers it and
  the server responds 400.
- **Canvas downscale is main-thread**: `maybeDownscaleImage`
  blocks while painting to a canvas. One-off on user action so
  the tradeoff is acceptable; OffscreenCanvas would improve
  this but Safari's support is recent enough that it would
  need a feature check + fallback.
- **Extracted text outlives binaries by design**: a year-old
  conversation with expired PDFs still reads sensibly because
  `extracted_text` doesn't expire. If this ever becomes a
  storage problem, the knob to turn is in
  `expire_old_attachments` — clear `extracted_text` too and
  the column goes away next sync.
- **Non-vision tier + image in history**: if a conversation
  accumulated images on a vision tier and the user later
  switches to a non-vision tier, history replay skips the
  images silently (the model can't render them anyway). The
  pre-send guard only looks at the pending message, so this is
  the correct behavior — blocking the switch would be worse.
