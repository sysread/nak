# Text parser milestone

*Skeleton.* To be fleshed out after the
[embeddings milestone](./embeddings.md) and informed by its
lessons. Part of the [Venice edge functions](./README.md)
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

To be filled in when embeddings completes.
