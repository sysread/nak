# Text parser milestone

*Skeleton - embeddings lessons folded in (step 8); target state
still to define.* Part of the [Venice edge functions](./README.md)
project.

Wraps `POST /augment/text-parser` (`VeniceClient.extractText`)
as a `/text-parser` route on the `venice` function. This is the
endpoint behind the attachments flow (see
[attachments](../../attachments.md)).

The one with a file upload: `extractText` posts a `Blob` +
filename as multipart, unlike the JSON-bodied endpoints.

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

To document: `extractText` in `src/lib/venice.ts`, the
attachments upload flow that calls it, and the size/expiration
constraints from the attachments feature doc.

## Target state

To define.

## Open questions

- Edge-function payload size limit vs the largest attachment we
  accept - does anything need chunking or a direct-to-Venice
  escape hatch for large files?

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
