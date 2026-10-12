# Image Editing Implementation Plan

Status: LANDED - kept for the design rationale. The living references
are [`../image-editing.md`](../image-editing.md) (dev internals),
[`../../../user/image-editing.md`](../../../user/image-editing.md)
(the user-facing page), and the QA use-case
[`../../../qa/use-cases/image-editing.md`](../../../qa/use-cases/image-editing.md);
where the implementation diverged from this plan, those docs win.
Divergences worth knowing: the edit card's tool-name filter needed an
actual edit (the plan assumed one line; it is the IMAGE_TOOL_NAMES set
in src/lib/ui/generated-image.ts), and `output_format: 'webp'` rides on
the edit wire body (the plan described the intent; the helper implements
it).

Read [`../architecture.md`](../architecture.md) for the edge-function
route map and [`../settings.md`](../settings.md) for the settings
model; this plan assumes both. Research baseline: the local
`venice-api-overview` skill's endpoint map plus live probes of
`GET /models` against Venice (2026-10-12, nak dev key) - type slices
probed: `inpaint` (30 models), `image`, `upscale`, `all`.

## SYNOPSIS

Let the LLM edit pictures the user already has - photos uploaded into
chat, or images the LLM generated earlier in the thread - instead of
only being able to create new ones. Three new tools (`edit_image`,
`upscale_image`, `remove_background`) call Venice's image-edit
endpoints; results attach to the assistant reply exactly like
generated images do today. A new Settings picker chooses the edit
model, next to the existing image-generation picker.

## PURPOSE

Today the LLM can look at an image (`analyze_image`) and create new
ones (`generate_image`), but when the user asks "remove the background
from this photo" or "make the sky a sunset", the model can only
describe what to change. Venice ships four image-edit endpoints that
do exactly this, on models the shared key can already reach. This plan
wires three of them into the existing tool harness so the LLM acts on
the user's pictures directly.

## DESCRIPTION

### How the relevant code behaves today

- **generate_image (edge impl)** -
  `supabase/functions/venice/tools/generate_image.ts`. Resolves the
  user's model (`profiles.settings.imageModel`, else the mirrored
  default, lines 27, 38-52), enforces the per-image price cap (127),
  calls `veniceGenerateImage`, and returns a compact descriptor plus a
  heavy payload stashed under `GENERATED_IMAGE_RESULT_KEY` (156-175).
- **The payload contract** -
  `supabase/functions/venice/tools/_generated_image.ts`. The tool
  result carries `__generated_image` (line 18) with `{filename,
  mime_type, data_base64, size_bytes}`; `extractGeneratedImage` (33)
  is a structural check, not a name-based one, and `stripGeneratedImage`
  (62) removes the payload from the model-visible row. The model never
  sees the ~700KB base64 blob.
- **The orchestrator harvest** -
  `supabase/functions/venice/getStreamingResponse.ts` 949-962. After
  each round's tool calls, it pulls the payload off every successful
  outcome structurally and calls `attachGeneratedImages`, which uploads
  bytes to the private `attachments` bucket and inserts
  `message_attachments` rows (`tools/_attachment_io.ts:21`). Because
  the harvest is structural, any tool returning the same payload shape
  gets the same attach behaviour with zero orchestrator changes to the
  harvest itself. One adjacent line DOES need changing: the
  tool_call_response broadcast summary (996-1005) stringifies the
  unstripped result before slicing to 200 chars - wasted ~700KB of
  stringify per image call today, and tens of MB for an upscale. The
  summary stringify must run `stripGeneratedImage` first.
- **Vision-tier attachment lookup** -
  `supabase/functions/venice/tools/analyze_image.ts` 95-111 finds the
  most recent `image/%` attachment by filename in the thread scope
  (ownership validated upstream at /stream entry), with miss
  diagnostics that distinguish "not an image" from "no such file"
  (47-77). Line 112-114 throws a distinct "has expired" error when
  `storage_path` is null - the state is produced by manual deletion
  (the Artifacts-tab delete path, `src/lib/supabase/messages.ts:341-367`;
  the old timer sweep is retired, `supabase/schema.sql:15525-15554`),
  so the expired branch is a real production path.
  `tools/_vision.ts:68` (`attachmentObjectAsDataUrl`) downloads the
  bytes as a data URL - deliberately inlined rather than handing
  Venice a signed URL the service cannot reach.
- **Price caps** - `supabase/functions/_shared/price-cap.ts`.
  `maxImageUsd` (line 38) is a flat USD-per-image ceiling;
  `assertImageModelWithinCap` (261) prices the model from the
  `?type=image` catalog slice (`pricing.generation.usd`, 220-237),
  fails open on catalog hiccups and unpriced models, and is inert when
  no cap is set. `app_config.max_image_usd` defaults to 0.10
  (`supabase/schema.sql:219-225`).
- **Model picker (image generation)** - the Settings AI pane renders an
  image-model dropdown fed by `src/lib/models/image-catalog.ts`
  (coercion of `?type=image`, drops unpriced models, 72-100) and
  `src/lib/ui/image-model-picker.ts` (option list + price pills);
  `src/screens/Settings.svelte` persists the pick to
  `profiles.settings.imageModel` (103, 298, 1318). The picker hides
  over-cap models via `filterImageCatalogByCap`
  (`src/lib/models/price-caps.ts:125`, used at `Settings.svelte:862`)
  and shows an over-cap note for a stale current pick
  (`priceCapHiddenNote`, `Settings.svelte:99`). The text pickers carry
  privacy chips from `src/lib/ui/model-picker.ts:96` (lock icon =
  private, theater icon = anonymized) - the image picker got no chip
  in that rollout. The settings write path is a key whitelist:
  `updateSettings` scrubs unknown keys
  (`src/lib/supabase/settings.ts:116-157`, imageModel branch at
  149-157) and `coerceSettings` drops unknown keys
  (`src/lib/supabase/types/settings.ts`, imageModel cases pinned by
  `tests/user-settings.test.ts:79-107`) - a new settings key must be
  added to BOTH or persistence is a silent no-op. The catalog load
  path is a twin pair: `src/lib/image-models-catalog.svelte.ts` (store + `resetImageCatalog`) + `SupabaseService.fetchImageModels`
  (`src/lib/supabase.ts:351`) + `fetchImageModels` in
  `src/lib/supabase/venice-proxy.ts:211`; `src/lib/app-state/lifecycle.ts:146`
  resets the catalog on lock().
- **The dedicated image card** - `src/lib/ui/generated-image.ts` +
  `src/components/GeneratedImageCard.svelte`. A `generate_image` tool
  call renders its own card below the tool-call row, resolving the
  image by filename from `message_attachments` (the attachment insert
  fires no `messages` realtime event, so the generic slot misses it).
  Emission filters tool calls by the single constant
  `GENERATE_IMAGE_TOOL_NAME` (`generated-image.ts:95`); the result
  parser needs `filename`, with width/height optional (square
  placeholder fallback, 49-78). Tools reach the wire only via toolbox
  composition: `TOOLBOXES` at `src/lib/tools/index.ts:473-481`,
  `imagesToolbox` at 435-442, whose `description` string is rendered
  verbatim into the model's tool catalog.
- **The `<thread_attachments>` block** - built browser-side by
  `src/lib/chat/prompt-assembly.ts` (summaries from
  `listAttachmentSummariesForThread`, `src/lib/supabase/messages.ts:438-444`,
  which joins assistant rows with no role filter). Two wrinkles the
  plan must address: (1) the block tells the model images are "inlined
  in the conversation and directly visible to you"
  (`prompt-assembly.ts:124-126`), which is FALSE for assistant-minted
  images - `toVeniceMessage` inlines attachments only for `role === 'user'`
  rows (`prompt-assembly.ts:599-607`); (2) the agent-side variant
  labels them "Live images the user posted"
  (`agents/_agent_tools.ts:344`). Both are pre-existing for
  `generated-*` images, but this plan makes assistant-minted images
  central: `edit_image` picks its input filename from this block.
- **Chat uploads** are compressed client-side to <=1MB target and
  <=2048px long edge (`src/lib/attachments.ts:50,60` - the byte target
  is a goal, not a hard cap), so chat images fit Venice's edit input
  bounds. The `attachments` Storage bucket enforces a file size limit
  (`supabase/config.toml:108`, 50MiB default).

### Venice capability (verified live, 2026-10-12)

| Endpoint | Model | Privacy | Price | Input notes |
|---|---|---|---|---|
| `POST /image/edit` | 30 ids via `?type=inpaint`; default `firered-image-edit` | 5 private (incl. default), rest anonymized | `pricing.inpaint.usd` flat, $0.02-0.34 | `model` + `prompt` + `image` (raw base64, data URI, or URL); optional `aspect_ratio` (omit = infer from input), `resolution` (only models listing `constraints.resolutions` - sending it to a model without them is a 400), `output_format`, `enhance_prompt` (+$0.04 when it rewrites), `safe_mode` |
| `POST /image/upscale` | fixed `upscaler` | private | `pricing.upscale`: 2x $0.02, 4x $0.08 | raw base64 only (no data URI); `scale` 2-4; response PNG |
| `POST /image/background-remove` | fixed `bria-bg-remover` | not catalog-listed | $0.03 (docs only) | base64/data URI/URL; response PNG with alpha |

- Input bounds (edit + upscale): min 64px per side and 65,536 total px,
  max ~33MP and 25MB. Chat uploads fit comfortably.
- Output size is unbounded by the request: a 4x upscale of a 2048px
  upload is an 8192px PNG - plausibly 30-80MB photographic - which can
  exceed the 50MiB bucket limit. The tool must size-check the returned
  bytes before returning the envelope (see M3).
- Response is **binary image bytes** on all three (Content-Type header
  carries the format) - different from `/image/generate`, which returns
  JSON with base64 inside.
- Errors: 422 content policy, 400 bad params (invalid model, prompt
  over the model's char limit, unsupported aspect_ratio/resolution),
  403 private-only key vs anonymized model, 429 rate limit, 503
  capacity. nak's key has no `modelPrivacy` restriction, so all models
  are reachable. The generate helper also checks a
  `x-venice-is-content-violation` header on 200s
  (`_shared/venice.ts:404-414`); whether the edit endpoints can ever
  set it on a 200 is undocumented - the new helpers check it
  defensively (cheap, mirrors the existing pattern).
- Generation prices (`?type=image`, `pricing.generation.usd`) span
  $0.01-0.29 (default venice-sd35 $0.01); edit prices span $0.02-0.34
  (default $0.04). The bands overlap; the private edit tier sits at
  $0.03-0.07, under the seeded $0.10 cap.
- Chaining hazard: an 8192px upscale output busts the ~33MP edit input
  cap, so upscale-then-edit 400s. Model-facing copy must teach "edit
  before upscaling"; QA covers the chain.

### What this plan adds

**Three new tools**, mirroring the generate_image split (browser
schema-only ToolDef in `src/lib/tools/`, edge impl with `registerTool`
in `supabase/functions/venice/tools/`):

- `edit_image(filename, prompt)` - prompt-driven edit of an image in
  the thread. Output requested as `webp`.
- `upscale_image(filename, scale?: 2|4, default 2)` - output PNG.
- `remove_background(filename)` - output PNG with alpha.

Shared machinery lands in a new `supabase/functions/venice/tools/_image_ops.ts`:

- `findImageAttachmentByFilename(ctx, filename, toolName)` - extracted
  from `analyze_image`: thread-scoped lookup, miss diagnostics, AND the
  expired-`storage_path` branch. The diagnostics text embeds the
  calling tool's name (today it says "so analyze_image cannot read
  it", `analyze_image.ts:63`) - parameterized by `toolName`, with
  `analyze_image`'s rendering preserved byte-identical (the pinned
  strings are asserted by
  `supabase/functions/tests/attachment-vision-tools.test.ts`, a Deno
  test, and carry load-bearing model-behaviour history documented in
  that file's header).
- Attachment download returning raw base64 (upscale forbids data URIs;
  edit and background-remove accept them - one download, two encodings).
- The result-envelope builder: compact model-visible descriptor plus
  the `__generated_image` payload under the existing key, with per-tool
  `note` wording ("edited and attached", "upscaled and attached",
  "background removed and attached") rather than generate_image's
  "Image generated..." text. Filenames
  carry a random suffix (`edited-<ts>-<4 random chars>.webp` etc.) so
  two parallel same-tool calls cannot mint the same millisecond
  collision (`generate_image.ts:153` uses bare `Date.now()`).

Each tool then reduces to: resolve args, enforce the per-image price
cap (mirroring `generate_image.ts:127-131` - the backstop journey (c)
depends on), look up the attachment, pre-flight the output size, call
the wire helper, size-check the
output bytes against the 50MiB bucket limit (throwing a tool error
before the envelope exists, so the model knows the attempt failed),
return the envelope. The upscale pre-flight avoids paying Venice for
a doomed call: the tool decodes source pixel dimensions from the
image header (PNG IHDR / JPEG SOF / WebP VP8X, ~30 lines, no deps -
the formats chat uploads actually produce) and refuses a scale whose
output must exceed the safe margin BEFORE spending the API call;
undecodable formats (HEIC/AVIF) skip the pre-flight and rely on the
post-hoc check. The margin math is stated for determinism: a
conservative 1.5 bytes/px floor for photographic PNG puts the ~45MiB
safe margin (50MiB minus headroom) at a ~30MP output budget, so 2x of
a 2048px upload (~16.7MP) passes and 4x refuses. Guidance text varies
by case - 4x failure suggests 2x; a 2x failure on a large source says
the source is too big to upscale further, never advice that cannot
succeed.

**Registration.** New tool modules are added as side-effect imports to
`supabase/functions/venice/tools/index.ts:19-73` - the registry only
sees tools through that barrel (`venice/index.ts:94-97` imports it).
Missing this is the silent-production-failure trap: modules compile,
offline tests import symbols directly, `deno check` stays green, and
every production call dies as "unknown tool" at dispatch.

**Wire helpers** in `supabase/functions/_shared/venice.ts`:
`veniceEditImage`, `veniceUpscaleImage`, `veniceRemoveBackground`,
mirroring `veniceGenerateImage`'s option-translation and VeniceError
mapping, with the binary-response delta: read `arrayBuffer()`, encode
base64, derive the MIME type from the `Content-Type` header, and check
the content-violation header on 200. Each takes an optional `signal`
threaded from `ctx.signal` with a per-attempt wall bound (~180s,
covering slow 4x upscales while staying under the turn's 380s
deadline, `getStreamingResponse.ts:128`) so a hung upstream degrades
instead of eating the whole turn - the house pattern from
`_vision.ts:47,104-105`. 422 maps to a content-policy message the
model can relay; 429 to `rate_limit`.

**Orchestrator (one line).** The broadcast summary at
`getStreamingResponse.ts:996-1005` runs `stripGeneratedImage` over the
result before stringifying. getStreamingResponse has no unit test
today (repo convention - handler glue is live-tested); this line is
verified by review plus the M6 card-rendering check.

**Model selection.** New `DEFAULT_EDIT_IMAGE_MODEL = 'firered-image-edit'`
created ATOMICALLY in both places - `src/lib/models/index.ts` (next to
`VENICE_DEFAULT_IMAGE_MODEL` at :671) and the edge tool's own copy -
because the mirror pattern's one historical failure was a comment
pointing at a constant that did not exist (fixed in `d1c9dd9c`). The
tool resolves `profiles.settings.editImageModel`, else the default -
same shape as `resolveImageModel`. The upscale and background-remove
models are fixed by the endpoint; no settings.

**Edit-model picker** (Settings AI pane, same tab as the image picker,
no composer control - matching image-model conventions):

- `src/lib/models/edit-image-catalog.ts` - coercion of `?type=inpaint`,
  sibling of `image-catalog.ts`. Price from `pricing.inpaint.usd`
  (flat on all 30 live models, so no resolution-tier drop wrinkle).
  Reuses the text pickers' privacy-chip semantics
  (`src/lib/ui/model-picker.ts:96`: lock = private, theater =
  anonymized) rather than inventing a badge; display-only, off-catalog
  picks show no chip.
- `/models` edge route (`supabase/functions/venice/index.ts:420`):
  extend the body clamp at :429 with `inpaint` and `upscale`, plus the
  `VeniceModelType` union at `_shared/venice.ts:778` (consumed by
  `veniceFetchModels` and both M2 price readers) - two edits, not one.
- Catalog load path twin: `src/lib/supabase/venice-proxy.ts`
  `fetchEditModels` (`body: { type: 'inpaint' }`),
  `SupabaseService.fetchEditModels` (`src/lib/supabase.ts`),
  `src/lib/edit-image-models-catalog.svelte.ts` store + reset,
  `lifecycle.ts` lock() reset hook, `root.svelte.ts` mirror seed.
- `src/lib/ui/edit-image-picker.ts` primitives + a second picker row
  in `src/screens/Settings.svelte`; `profiles.settings.editImageModel`
  field end-to-end: `coerceSettings` allowlist
  (`src/lib/supabase/types/settings.ts`), the `updateSettings` scrub
  branch (`src/lib/supabase/settings.ts:149`), `app-state/settings.ts`
  setter + reload hydration, `root.svelte.ts` seed. Missing either
  allowlist makes the picker a silent no-op that reverts on reload.

**Price caps.** `maxImageUsd` is reused as the ceiling for all four
image ops - "max USD per image op". `price-cap.ts` gains per-op flat
price readers: the inpaint slice (`pricing.inpaint.usd`) for edit
models, and a scale-aware check for the upscaler whose price source is
the `?type=upscale` slice's `pricing.upscale` tiers (2x $0.02, 4x
$0.08; the requested scale picks the tier, scale > 2 bills at the 4x
rate) - so the `VeniceModelType` union gains BOTH `'inpaint'` and
`'upscale'`, and the upscale check takes (model, scale), not the flat
per-model signature. `bria-bg-remover` is not catalog-listed, so the
cap check fails open for background removal, same as every unpriced
model today. A separate `maxEditUsd` knob was considered and rejected:
the price bands overlap and one cap discriminates exactly as the owner
wants (prunes the expensive anonymized tier).

**Image card generalization.** `generated-image.ts:95` filters by the
single `generate_image` name; broaden to a name set
`{generate_image, edit_image, upscale_image, remove_background}` so
edited/upscaled/cut-out images render the same dedicated card. No
historical constraint on the filter being single-name (created in
`96f6af83`/PR #304, untouched since). The result descriptors carry
`filename` plus dimensions where known (generate echoes its requested
px). Edit-family tools do not know source pixel dimensions server-side,
so their descriptors omit width/height and the card falls back to the
square placeholder - cosmetic-only, existing code path, already pinned
by `tests/generated-image.test.ts:36,60`.

**`<thread_attachments>` provenance fix (M4).** The block's "directly
visible to you" claim is false for assistant-minted images, and a
vision-tier model told it can see pixels will fabricate edits from the
filename instead of calling `analyze_image`. Split the block by ROLE
provenance - not filename prefixes (a user upload literally named
`edited-sunset.png` must not be misclassified): add `messages.role` to
the select in `listAttachmentSummariesForThread`
(`src/lib/supabase/messages.ts:440`) and a field on
`ThreadAttachmentSummary` (`src/lib/supabase/types/chat.ts:272`).
User-posted images keep the current "directly visible" wording;
assistant-minted images get their own sentence - "attached to an
earlier reply, not visible inline - call analyze_image to look at
it". The agent-side variant gets the one-word fix ("posted or
produced in this thread", `agents/_agent_tools.ts:344`, edge-side -
ships in M3 with the function deploy).

**Schema descriptions** carry the model-facing boundary: change an
existing picture with `edit_image` / `upscale_image` /
`remove_background` (filename from `<thread_attachments>`), create a
new one with `generate_image`. Keep edit prompts short and specific
(firered-image-edit enforces 1500 chars). Teach the chaining order:
edit before upscaling (an upscaled output can exceed the edit input
caps - pixel and byte). No system-prompt changes beyond the
`imagesToolbox` description
text (rendered verbatim into the model's catalog,
`src/lib/chat/system-prompt.ts:350`) gaining the three new verbs -
and dropping that description's stale "30-day retention" claim
(`src/lib/tools/index.ts:432,439`; the retention sweep is retired).
Do not carry the stale claim into the new copy; the same stale
sentence sits on `record_file_attach.ts:8` and may be swept in the
same pass.

## Milestones

1. **M1 - Wire helpers.** `veniceEditImage` / `veniceUpscaleImage` /
   `veniceRemoveBackground` in `_shared/venice.ts`: binary parsing,
   content-violation header on 200, 422/429 mapping, optional signal + 180s
   bound. Deno tests mirroring
   `supabase/functions/tests/venice-generate-image.test.ts`, covering
   the binary path and the upscale raw-base64 discipline.
2. **M2 - Price caps.** `VeniceModelType` union + inpaint-slice reader
   plus a scale-aware upscale check (both against `maxImageUsd`,
   fail-open posture). Tests mirroring
   `supabase/functions/tests/price-cap.test.ts`.
3. **M3 - Edge tools.** `_image_ops.ts` (shared lookup with expired
   branch + parameterized diagnostics, download, envelope builder,
   random-suffix filenames) + the three tools + barrel registration in
   `tools/index.ts` + tests; `analyze_image` refactored onto the
   shared lookup with its pinned strings byte-identical;
   `getStreamingResponse.ts` summary strip; the agent-side
   `<thread_attachments>` wording fix
   (`agents/_agent_tools.ts:344` - edge file, ships with the function
   deploy); stale "Mirror of src/lib/..." header comments on the
   generate_image files swept so the new tools do not copy the lie.
4. **M4 - Browser plumbing.** Three schemas; `imagesToolbox` membership + description update; `editImageModel` settings field end-to-end
   (coerceSettings allowlist, updateSettings scrub branch, app-state
   setter + hydration, root seed); `edit-image-catalog.ts` + catalog
   store twin + `fetchEditModels` proxy + SupabaseService + lifecycle
   reset; `/models` inpaint/upscale forwarding (clamp + union);
   `<thread_attachments>` role provenance split
   (`messages.ts` + `types/chat.ts` + `prompt-assembly.ts`).
5. **M5 - Settings UI.** Edit-model picker primitives (reusing the
   privacy-chip semantics) + Settings row; over-cap models hidden and
   an over-cap note for a stale current pick (mirroring
   `priceCapHiddenNote`).
6. **M6 - Docs + QA.** `docs/dev/tools.md` (the toolbox/tool catalog -
   `architecture.md` carries no tool list), QA use-case, live smoke
   test of all three ops against the local stack (~$0.10 Venice
   credit), card-rendering check in the producing tab, and the chains:
   edit-then-edit, generate-then-edit (cross-turn), and
   upscale-then-edit - where EITHER the pre-flight refusal or the
   edit endpoint's input-cap 400 counts as a pass (a photographic 4x
   output trips the size check first; a 2x output can pass the size
   check and trip the edit byte cap instead).

## Testing

- Edge: deno tests per milestone via `mise run functions-test`
  (offline, fake fetch) and `mise run functions-check` over every
  entrypoint; both ride `mise run check` (CI's gate).
- Browser: **vitest** (`mise run test`) - not optional. Mirror the
  named sibling files: `edit-image-catalog` coercion + store twin
  (mirror `image-model-picker.test.ts` / `image-models-catalog.test.ts`),
  `coerceSettings`/scrub cases for `editImageModel` (mirror
  `user-settings.test.ts:79-107`), generated-image name-set fixtures
  (extend `tests/generated-image.test.ts`), prompt-assembly block
  split (mirror its existing test), plus updates to
  `tests/message-blocks.test.ts:292,314` and `tests/tools.test.ts`
  TOOLS parity. A new DOM-mounting test file must be registered in
  `vite.config.ts` `environmentMatchGlobs` in the same change
  (missed registration dies only in CI).
- Refactor pins: `supabase/functions/tests/attachment-vision-tools.test.ts`
  (Deno suite) must stay green unmodified through the `analyze_image`
  extraction. The
  expired-`storage_path` branch and created_at-descending ordering are
  currently unpinned (fake client never sorts) - the `_image_ops.ts`
  tests add both cases.
- Live smoke (M6) per the QA use-case convention; deploy the edge
  function before the browser bundle - a browser-first deploy arms
  tools the function cannot dispatch (transient
  `ToolNotImplementedError` rows, `performToolCall.ts:158-170`).

## Scoped out (deliberately)

- `/image/multi-edit` (compose several images) - retired by decision
  (2026-10-12): not needed. Revisit only if a real use appears.
- `enhance_prompt` (+$0.04, ~30s) - leave off; latency- and
  cost-sensitive path.
- Pixel dimensions in edit-family result descriptors (square
  placeholder fallback instead) and a `width`/`height` column on
  `message_attachments`.
- Composer controls for any image model - Settings tab only.
- Aspect-ratio / resolution overrides in tool args - aspect infers
  from the input image; resolution rides the model default. Revisit if
  QA shows a real need.
- The orphaned `/image-generate` browser proxy
  (`supabase/functions/venice/index.ts:516-574`, zero callers in
  `src/`) - adjacent cleanup, not this plan's job.

## Decisions (resolved 2026-10-12)

- **v1 ships all three tools** (edit + upscale + background-remove),
  not edit alone - the two fixed-model tools are small follow-ons once
  the wire helper exists, so they ride along.
- **Full edit-model picker in v1**, on the same Settings tab as the
  image picker; no composer control.
- **One shared `maxImageUsd` cap** across all four image ops; no
  `maxEditUsd`.
- **Default edit model `firered-image-edit`** - private-served,
  $0.04/edit, matching the project's privacy posture for the agent
  fleet.
- **Upscale size guard, two layers** - a pre-flight header decode
  (PNG/JPEG/WebP) refuses scales that must exceed the ~45MiB safe
  margin under the 50MiB bucket limit BEFORE spending the Venice call;
  a post-hoc byte check backstops undecodable formats. Both throw a
  tool error with achievable guidance.
- **`<thread_attachments>` provenance split** ships with this feature -
  `edit_image` correctness depends on the model not believing it can
  see assistant-minted pixels.
