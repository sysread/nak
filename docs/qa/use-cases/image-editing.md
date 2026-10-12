# Image editing: edit_image, upscale_image, remove_background

## Covers

The image-op tools ([dev: tools](../../dev/tools.md) and the
implementation plan
[dev: plans/image-editing-plan](../../dev/plans/image-editing-plan.md)):
the three Venice image-edit wire helpers, the edge tools with their
shared `_image_ops` lookup, the `__generated_image` envelope reuse, the
Settings edit-model picker, and the `<thread_attachments>` role
provenance split.

## Preconditions

- Local stack up (`mise run dev-start`), signed in as the dev user.
- `app_config` seeded with a Venice key.
- The image edit smoke test spends a few cents of Venice credit
  (generation ~$0.01, edits ~$0.04, upscale 4x $0.08).
- The venice function's local edge runtime picks up source edits on
  container restart: `docker restart supabase_edge_runtime_nak`.

## Steps

1. Open Settings -> AI. Both **Image generation** and **Image editing**
   sections render. The edit picker loads the inpaint catalog; each row
   shows a per-edit price and a privacy badge (lock Private / mask
   Anonymized). Pick a model, reload the page, confirm the pick
   persisted and "Saved" state reads correctly. Pick the default
   (`FireRed Image Edit`) and confirm the override clears (settings blob
   has no `editImageModel` key).

1. In chat, upload a photo (or generate one: "draw a lighthouse") and
   ask **"make the sky a vivid orange sunset"**. Expect: the model calls
   `edit_image` with the filename from `<thread_attachments>`; the
   edited image renders in the dedicated card below the tool call
   WITHOUT a page reload; the original image row is untouched.

1. Iterate on the result: **"now add a bird"**. Expect the model to
   reference the `edited-...` filename and succeed - the per-round
   attach made the first edit's output resolvable in the same thread.

1. Ask **"remove the background"**. Expect a `no-bg-...png` result card
   and a transparent cutout when downloaded.

1. Ask **"make it 4 times bigger"** on a large source. Expect EITHER a
   clean pre-flight refusal (the model reports the scale won't fit and
   suggests 2x, no tool-call success shown) OR a successful
   `upscaled-...png`. The model must never claim success when no
   `upscaled-` attachment row exists.

1. Ask **"what's in the edited picture?"** on a vision-tier model.
   Expect the model to call `analyze_image` on the `edited-...` file
   rather than claiming it can already see it - the block's
   "produced by you in earlier replies ... NOT visible inline" line is
   the phrasing under test. (Assistant-minted images are never inlined
   into the turn.)

1. Chain check, upscale-then-edit: after a successful upscale, ask the
   model to edit the upscaled output. Expect EITHER success (small
   source) or a clean tool error naming the input caps; the model
   should relay the failure, not fabricate.

1. Settings: temporarily set `app_config.max_image_usd` to `0.02` (via
   service-role update), hard-reload Settings, and confirm the edit
   picker hides every model above $0.02 and shows the over-cap note;
   then set it back to `0.1`.

1. Restart the edge runtime, then send one image-op turn and watch
   `docker logs supabase_edge_runtime_nak` for the round outcome - the
   tool name should appear in the round outcomes line.

## Known environmental limits (observed 2026-10-12)

- **Local stack + user-uploaded images do not mix for VISION turns.**
  The chat send path inlines user images as SIGNED URLs
  (`createAttachmentSignedUrls`), which point at
  `http://127.0.0.1:54321/...` locally; Venice fetches them
  server-side, cannot reach localhost, and 400s the whole turn with
  "Supplied image did not pass validation checks." Pre-existing (not
  image-editing's code path). Two consequences for local QA: (1) to
  exercise the image tools locally, generate first ("draw a ...") and
  edit the generated image - assistant-minted images are never
  inlined, so no part of the turn hits the validator; (2) a thread
  that already holds an image upload stays broken for every
  subsequent send on the local stack (history replay re-inlines it).
  The edit tool itself is unaffected - it downloads bytes via the
  service role on the same host and ships base64 to Venice.
- **firered-image-edit latency varies wildly.** Same key, same image
  class: ~15s at 21:00, ~86s at 21:16 (provider load). The tool's
  180s per-attempt bound and the turn's 380s wall deadline mean a
  turn fits ONE slow edit; when the model retries an aborted edit the
  turn can end at the wall deadline. Observed chain: 170s abort ->
  model retry -> wall deadline ends the turn. Not a code defect; the
  degradation is clean at every step.

## Baseline

| Date | Commit | Result |
|------|--------|--------|
| 2026-10-12 | 337911af | Local stack E2E: generate -> card ok; edit_image dispatched on the generated filename (provenance block cited), edit_image=ok in 64s, edited card rendered; settings picker + cap note verified; direct-curl probes of all three endpoints verified binary responses, output_format, alpha PNG. Chain turn hit provider slowness (170s+ aborts) and ended at the wall deadline - degradation clean. |
