# Text parser milestone

*Now bug-driven: text extraction is **broken from the browser**
(see [Motivating bug](#motivating-bug-text-extraction-broken-from-the-browser)),
so this milestone is the fix, not just a consolidation. Embeddings
lessons folded in (step 8).* Part of the
[Venice edge functions](./README.md) project.

Wraps `POST /augment/text-parser` (`VeniceClient.extractText`)
as a `/text-parser` route on the `venice` function. This is the
endpoint behind the attachments flow (see
[attachments](../../attachments.md)) AND the Library document
upload (see [library](../../library.md)).

The one with a file upload: `extractText` posts a `Blob` +
filename as multipart, unlike the JSON-bodied endpoints.

## Motivating bug: text extraction broken from the browser

Observed 2026-05-30 during attachments-storage QA, on current
`main`.

**Symptom.** Uploading any non-image file (tried `.pdf`,
`.txt`, `.md`, all <1 KB) fails at the composer: the attachment
pill turns red and sending shows

> "dishes.txt": Text extraction failed: Network error
> contacting Venice: Failed to fetch

That string is `extractText`'s catch block in
`src/lib/venice.ts` wrapping a thrown `TypeError: Failed to
fetch` as `VeniceError(..., 'network')`. "Failed to fetch" is a
browser network/CORS-layer rejection - the request never
completed in a CORS-readable way - NOT an HTTP error response
(a 4xx/5xx would surface through `classifyError`, with a status).

**Why it is CORS, not a bad request.**

- The endpoint path is correct and current: Venice's docs list
  `POST /api/v1/augment/text-parser`, multipart/form-data,
  accepting PDF/DOCX/PPTX/XLSX/plain-text up to 25 MB - exactly
  the files that failed. So it is not a wrong URL (would 404)
  or a rejected format (would 400); both are HTTP errors, not
  "Failed to fetch".
- `app.venice` is a `VeniceClient` pointed at the default
  `https://api.venice.ai/api/v1` (`new VeniceClient({ apiKey })`
  in `src/lib/state.svelte.ts`), calling **directly from the
  browser**.
- Image paths work against the **same host and key**: inline
  vision (`/chat/completions`) and `analyze_image` were verified
  live in the same session, and `generate_image` hits
  `/image/generate`. So the browser can reach Venice with CORS
  for those endpoints - the key, origin, and general CORS are
  fine.
- Therefore the failure is **endpoint-specific**: Venice
  CORS-enables its chat/image endpoints but evidently NOT
  `/augment/text-parser`. (Their docs make no browser-safety
  claim for it.) A 404 whose error response omits CORS headers
  would also read as "Failed to fetch", so a quietly-moved or
  gated route is a secondary possibility - but the path matches
  the live docs.

**This is pre-existing, not caused by the attachments-storage
migration.** Extraction runs at the composer BEFORE any storage
write; the storage migration is entirely downstream. It was
simply never exercised live with a non-image file until now
(image uploads skip extraction). Unconfirmed whether it ever
worked from the browser or Venice tightened CORS later - the
browser devtools Network entry for the failed request (CORS
error vs a status code) would settle that, but does not change
the fix.

**The fix = this milestone.** Routing text extraction through
the `venice` edge function makes the call **server-side**, where
browser CORS does not apply and the project-global key already
lives. Fixes both the chat-attachment path and the Library
upload path in one move.

## Why this one is different

- **Multipart upload.** The request carries file bytes, not
  JSON. The function has to accept the upload and forward it -
  watch the edge-function request size limit and multipart
  handling.
- **User-triggered, not background.** It fires when a user
  attaches a file, so it is a phase-4 (user-facing) move, not a
  scheduled one. Latency is felt but the operation is already
  understood to be slow, so the hop is more tolerable than on
  the chat path.

## Current state

`extractText(file: Blob, filename: string): Promise<string>` in
`src/lib/venice.ts`:

- Builds a `FormData` with `file` (the Blob + filename) and
  `response_format: 'json'`.
- `POST`s to `${baseUrl}/augment/text-parser` with ONLY an
  `Authorization: Bearer <key>` header - deliberately not
  `this.headers()`, because a JSON Content-Type would clobber
  the multipart boundary the browser sets.
- On a thrown fetch error wraps it as `VeniceError('Network
  error contacting Venice: ...', 'network')` - the string the
  user saw.
- On `!res.ok` calls `classifyError`; on success reads `text`
  off the JSON body (with a couple of fallback keys).

**Two call sites**, both must end up routed server-side:

1. **Chat attachments** - `src/screens/Chat.svelte`
   `addAttachment(file)` calls `app.venice.extractText(file,
   file.name)` for non-image files at compose time, before the
   message is sent. This is the path the bug report hit.
2. **Library uploads** - `src/lib/documents.ts` `ingestDocument`
   calls `venice.extractText(file, file.name)` after the bucket
   upload; a failure there marks the document `extraction_status
   = 'failed'` (the doc is still stored, just not searchable).

Size/expiration constraints to mind: attachments cap at
`MAX_ATTACHMENT_BYTES` (10 MB); Library at
`MAX_DOCUMENT_FILE_BYTES` (25 MB) - which is also Venice's
text-parser limit. The edge-function request-size ceiling vs
these caps is the open question below.

## Target state

A `/text-parser` route on the `venice` edge function that accepts
the multipart upload (user JWT auth, `verify_jwt` on, shared key
from `app_config` via service role - copy `/embed`'s model, not
`/backfill`'s), forwards it to Venice server-side, and returns
the parsed `{ text, ... }`. The browser stops calling Venice
directly: `extractText` becomes a thin call to the function
(e.g. a `SupabaseService.extractText` mirroring how browser
embeds now go through the function), and both call sites above
move onto it. Keep the `VeniceError` shape so the composer pill
and the `ingestDocument` failure branch render unchanged.

## Open questions

- Edge-function payload size limit vs the largest attachment we
  accept (10 MB attachments, 25 MB Library docs) - does anything
  need chunking or a direct-to-Venice escape hatch for large
  files? If a large file can't round-trip through the function,
  the direct-from-browser path it would fall back to is the very
  one that's CORS-broken - so the escape hatch may have to be a
  signed-upload-to-storage-then-server-fetch shape rather than
  browser-direct-to-Venice.
- Confirm the CORS diagnosis from devtools (nice-to-have; the
  server-side route fixes it regardless).

## Lessons from the embeddings milestone

Folded in after embeddings shipped (step 7):

- **User-triggered, so the cron / definer / Vault stack does not
  apply.** Like chat and usage, this fires from the browser with the
  user's session JWT; `verify_jwt` stays on and `/text-parser` reads
  the shared key from `app_config` via the service role. Copy
  `/embed`'s auth model, not `/backfill`'s.
- **One route per concern (`/text-parser`).**
- **Multipart is the genuinely new wire concern.** Embeddings only
  ever sent JSON, so `_shared/venice.ts` is `JSON.stringify(body)`.
  This endpoint forwards file bytes: the function reads
  `multipart/form-data` (a `FormData` with the `Blob` + filename) and
  re-posts it to Venice. The fetch-injectable test pattern still holds
  - build the outgoing `FormData` in a pure helper and assert its parts
  with a fake `fetch` under `deno test` - but the body construction is
  new code, not a copy of the embed shape.
- **The payload-size question is real and unmeasured.** Embeddings
  gave no data here (text is tiny). The edge-function request-size
  limit versus the largest attachment we accept is the open question
  below; it has to be measured, and may force a direct-to-Venice escape
  hatch for large files (the browser uploads straight to Venice,
  skipping the function) - a partial-migration shape embeddings never
  needed.
- **Trust model unchanged.** The attachments flow's download/upload
  confirmations (see [attachments](../../attachments.md)) are a client
  concern; the function just must not become an unauthenticated
  file-forwarding proxy - the user-JWT gate is what prevents that.
