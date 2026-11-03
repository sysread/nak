# Image editing: the image tool's edit / upscale / remove_bg ops

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
   the image tool (op=edit) with the filename from `<thread_attachments>`; the
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
| 2026-11-02 | f0f19a58 | Steps 2-7 re-run as the pre-M2 (combo-conversion) baseline, vision profile, source generated not uploaded (dodges the signed-URL 400): steps 2/3/4/6/7 PASS (edit chains resolve prior edits' filenames; no-bg cutout 16.9% transparent; analyze-on-edit cites the edited file; upscale-then-edit succeeds at 2x on a 2048px output). Step 5 FAIL - third branch (see findings). Steps 1/8/9 skipped this run. |
| 2026-11-03 | tool-combos (post-M2 combo, uncommitted worktree) | Steps 2-7: steps 2/3/4/6 full parity PASS; step 5 FAIL = parity on the tracked defect; step 7 BLOCKED (see below). Zero console errors; thread deleted first attempt. Tool mapping: every op dispatched as `image` + op (generate / edit x2 / remove_bg / upscale x3), chaining resolved prior outputs' filenames, cutout transparency 39.6% (different source; not comparable). One fumble: first call omitted `op`, rejected clean in 33ms, self-corrected (2nd omission across today's runs - both first-image-calls of a thread; candidate for a schema sharpening pass if the rate holds). STEP 5 + NEW: upscale 4x died as expected (parity) AND 2x died twice at ~60s with the identical signature - the tracked defect (CLAIM 1) is WIDER than the baseline recorded: not 4x-specific. Same session/minute, other ops succeeded in 2-8s (stack healthy); only the upscale path hangs. Baseline's 2x succeeded in 5.7s the prior day - onset looks provider-variable. STEP 7 UNEXERCISED: no upscaled file existed to edit; the baseline's step-7 pass (verb tools) plus this run's edit-chaining (proven twice on the combo) make the residual risk negligible; flagged to Jeff. |

### Findings from the 2026-11-02 run (both out of scope for the combo conversion)

- **Upscale 4x dies the turn at a fixed 60s, twice.** Two 4x attempts on a
  1024px source: dispatch -> exactly 60s -> "live stream disconnected
  mid-turn; handing off to reconnect poll"; the reconnect poll never
  delivered a result and the tool row persisted as the recovery
  synthesizer's "interrupted" note. Scale 2 on the same source: 5.7s. The
  pre-flight budget check correctly did NOT refuse (4x of 1024px is ~17MP,
  under the ~30MP budget) - so the doc's either/or landed on neither
  branch: no refusal, no result. Degradation honest (no `upscaled-` row,
  model volunteered the failure), but the 60s live-stream idle tolerance
  vs the slow upscale endpoint is a real product gap. Filed with bug
  intake.
- **Live image-card + tool-result delivery dies after a mid-thread page
  reload.** 3/3 turns after a reload rendered no image card and left the
  tool-result panel stuck at "In progress..." until the next reload, vs
  0/4 misses in the same session before any reload (and the 2026-11-02
  generated-card baseline saw the same 1-in-5 miss "after a reload").
  Data persisted correctly every time - delivery/render, not writes. The
  live attachment/result path appears not to re-establish after a reload.
  Filed with bug intake.
- Minor: editing a transparent cutout composites a background back in
  (edit-model behavior; the second-thoughts panel flagged it itself).
