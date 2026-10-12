# Image editing

Three chat tools that **change pictures the conversation already
holds** - `edit_image`, `upscale_image`, and `remove_background` -
against Venice's image-edit endpoints. They reuse the generate_image
result contract end to end, so a new image op costs one tool module
plus one wire helper; everything about lookup, size-guarding,
attaching, and rendering is shared.

The user-facing surface is described in
[`../user/image-editing.md`](../user/image-editing.md); the tool
catalog entries are in [`./tools.md`](./tools.md); the design and
refinement record (kept for rationale) is
[`./plans/image-editing-plan.md`](./plans/image-editing-plan.md).

## Files

- `supabase/functions/_shared/venice.ts` - the wire helpers
  `veniceEditImage` / `veniceUpscaleImage` / `veniceRemoveBackground`:
  camel-to-snake translation, binary response parsing (the edit
  family returns raw bytes with the format in `Content-Type`, unlike
  `/image/generate`'s JSON envelope), 422 content-policy mapping,
  defensive `x-venice-is-content-violation` check on 200s, and a 180s
  per-attempt wall bound (`imageOpSignal`) composed with the turn's
  abort signal.
- `supabase/functions/venice/tools/_image_ops.ts` - the shared
  machinery (below).
- `supabase/functions/venice/tools/{edit_image,upscale_image,remove_background}.ts`
  - the tools, registered through the `tools/index.ts` side-effect
  barrel like every other tool.
- `supabase/functions/_shared/price-cap.ts` - the per-op cap checks.
- `src/lib/tools/{edit_image,upscale_image,remove_background}.schema.ts`
  - wire schemas; browser ToolDefs are schema-only (server dispatch).
- `src/lib/models/edit-image-catalog.ts` +
  `src/lib/edit-image-models-catalog.svelte.ts` - the `?type=inpaint`
  catalog coercion and its reactive store (twins of the generation
  pair).
- `src/lib/ui/edit-image-picker.ts` + `src/screens/Settings.svelte` -
  the picker primitives and the Settings -> AI pane section.
- `src/lib/ui/generated-image.ts` - the dedicated image card's
  `IMAGE_TOOL_NAMES` set covering all four image tools.

## The three ops

| Tool | Endpoint | Model | Output | Input encoding |
|---|---|---|---|---|
| `edit_image` | `/image/edit` | user-configurable | webp (requested) | data URI |
| `upscale_image` | `/image/upscale` | fixed `upscaler` | PNG | **raw base64 only** |
| `remove_background` | `/image/background-remove` | fixed `bria-bg-remover` | PNG + alpha | data URI |

Every tool returns the same envelope `generate_image` does: a compact
model-visible descriptor (filename, format, note) plus the heavy
payload under `GENERATED_IMAGE_RESULT_KEY`, which the orchestrator
harvests structurally and attaches to the round's assistant row. That
is the whole reason the tools are cheap to add - the attach pipeline
is name-agnostic. Filenames are minted with a timestamp plus a random
suffix (`edited-<ts>-<4 chars>.webp`), because two parallel calls in
the same millisecond would otherwise collide on the
most-recent-by-created_at lookups.

## Shared machinery (`_image_ops.ts`)

- **`findImageAttachmentByFilename(ctx, filename, toolName)`** - the
  thread-scoped `image/%` lookup extracted from `analyze_image`
  (ownership rides the validated threadId). Miss diagnostics are
  parameterized by calling tool so the not-an-image redirect names the
  right limitation; `analyze_image`'s renderings stay byte-identical
  (pinned by
  `supabase/functions/tests/attachment-vision-tools.test.ts`). The
  expired-`storage_path` branch travels with the lookup - manual
  deletion nulls the path, and "expired" must not read as "try again".
- **`attachmentObjectAsBase64`** - one download from the attachments
  bucket returning raw base64; the data-URI form is derived by
  concatenation (upscale rejects data URIs, the other two accept
  them). Same inlining rationale as `_vision.ts`'s data-URL helper:
  Venice cannot fetch our signed URLs.
- **`decodeImageDimensions`** - PNG IHDR / JPEG SOF / WebP VP8X-VP8L
  header reads, no decode step. Feeds the upscale pre-flight.
- **Size guard, two layers.** The upscaler's output is unbounded by
  the request (a 4x of a 2048px upload is a 30-80MB PNG) while the
  attachments bucket rejects over-50MiB files and
  `attachGeneratedImages` swallows upload failures - an unguarded
  success would name a file that never exists. The pre-flight refuses
  a scale whose output must exceed a ~30MP budget (45MiB at a 1.5
  bytes/px floor) BEFORE Venice is paid, with guidance that is always
  achievable (4x failure says "retry with scale 2"; a 2x failure says
  the source is too large, full stop). The post-hoc byte check
  backstops formats the decoder cannot read (HEIC/AVIF).

## Model selection and caps

`edit_image` resolves `profiles.settings.editImageModel` service-side
(the picker's only consumer is the id), falling back to
`firered-image-edit`. The default is mirrored in
`src/lib/models/index.ts` as `DEFAULT_EDIT_IMAGE_MODEL`; the two
copies exist because the edge bundle cannot import from src/lib -
create them atomically, the mirror pattern's one historical failure
was a comment pointing at a constant that did not exist. Upscale and
background-remove use fixed models; no settings.

One flat `maxImageUsd` cap (app_config) covers all four image ops -
"max USD per image op". The edit check prices from
`?type=inpaint`'s `pricing.inpaint.usd`; the upscale check is
tier-aware (scale <= 2 bills at 2x, above at 4x). `bria-bg-remover`
is not catalog-listed, so its cap check fails open like every
unpriced model. The Settings picker hides over-cap models
(`filterEditCatalogByCap`) and shows the stale-pick note; the tool-side
403 is the boundary.

## Provenance split in `<thread_attachments>`

The block's "directly visible to you" phrasing was false for
assistant-minted images: only user-row attachments are inlined into
the turn (`toVeniceMessage`), while generate/edit outputs hang on
assistant rows. A vision model told it could see pixels would fabricate
edits from the filename instead of calling `analyze_image`. The block
now splits by **message role** (`messages.role` projected through
`listAttachmentSummariesForThread` into `ThreadAttachmentSummary.posted_by`):
user uploads keep the "directly visible" wording, assistant-minted
images get their own line - attached to an earlier reply, not visible
inline, analyze first. Role, not filename prefix: a user upload named
`edited-sunset.png` is a user image.

## Gotchas

- **Edit before upscaling.** An upscaled output can exceed the edit
  endpoints' input caps (pixels and bytes); the schemas teach the
  model the ordering and the QA use-case covers the failure shapes.
- **`firered-image-edit` latency is volatile** (observed 15s to
  170s+ under provider load). The 180s bound turns a hang into a
  clean tool error the model can retry once; a turn with two slow
  edits can still end at the 380s wall deadline. Degradation is clean
  at every step; if slow turns become common, the lever is a smaller
  bound, not a larger one.
- **Local dev stack + uploaded images.** Chat inlines user images as
  signed URLs pointing at `127.0.0.1:54321`, which Venice cannot
  fetch - any turn carrying an upload 400s locally (fine in prod).
  To exercise the image tools locally, generate first and edit the
  generated image; the tools themselves are unaffected (service-role
  download, base64 to Venice).
- **422 is a content-policy rejection**; the helper's message tells
  the model to rephrase or relay. Venice may also flag a violation
  via header on a 200 - checked defensively since the check is free.

## Tests

- `supabase/functions/tests/venice-image-edit.test.ts` - wire shapes,
  binary parsing, 422/429 mapping, raw-base64 discipline.
- `supabase/functions/tests/image-op-tools.test.ts` - tool behavior
  against a fake admin client and stubbed fetch: model resolution,
  cap backstop, miss/expired diagnostics, pre-flight refusal, wire
  encodings, envelope shape.
- `supabase/functions/tests/price-cap.test.ts` - the inpaint and
  upscale cap checks (403 / within / unpriced / inert / fail-open).
- `tests/edit-image-catalog.test.ts`, `tests/edit-image-picker.test.ts`,
  `tests/edit-image-models-catalog.test.ts`, `tests/price-caps.test.ts`,
  `tests/user-settings.test.ts` - the browser half.
- `docs/qa/use-cases/image-editing.md` - the manual pass, with the
  environmental limits.
