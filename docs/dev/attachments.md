# Attachments

## Role

Per-message file attachments — queued in the composer, persisted to
Supabase, inlined into Venice chat requests where the model can
consume them, and reclaimed after a 30-day dormancy window.

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
  for user rows.
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
  under user-message bodies. Live rows render download anchors;
  expired rows render the filename plus a clock icon (no anchor)
  and the "Text" button if extracted text remains.
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
  attachments for user rows; `MessageAttachments` renders.
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

## Interactions

- **Chat**: the composer's paste/drag-drop UX lives in
  `Chat.svelte`; the `send()` path materialises attachments into
  the DB and builds the Venice wire shape. Docs in
  `./chat.md`.
- **Venice adapter**: we added `VeniceClient.extractText` and
  widened `VeniceMessage.content`. See `./architecture.md` for
  the adapter conventions.
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
  join `message_attachments`, so a user-row echo arrives with
  `attachments` unset. Chat.svelte's subscribe handler fires a
  follow-up `listAttachmentsByMessageIds([msg.id])` for every
  user-role INSERT and re-runs `appendMessage` with the hydrated
  row. Needed for (a) cross-tab sync (tab B sees tab A's insert
  and must hydrate itself) and (b) defense against a local race
  where the attachment-less echo arrives before the sender's own
  `appendMessage(userMsg)` can upgrade the row.
- **Logging**: the attachment-expiry worker's manager
  emits breadcrumbs through
  `createLogger('attachment-expiry-worker')`. Worker-side
  entries postMessage main-thread and appear in the
  in-app log drawer. See `./logging.md`.

## Gotchas

- **Base64 stored as text, not bytea**: the original design used a
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
