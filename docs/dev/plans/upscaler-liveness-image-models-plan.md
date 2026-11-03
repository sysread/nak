# Upscaler liveness + image model compatibility - fix plan

Status: REVISED through refinement round 2 and the M2 verdict (Fork B
proven; see M2 findings). M3 shape call by the coordinator (chat ids
1938-1939): chunked conversion is the primary fix, no schema change, the
op-deadline column deferred as a documented standby design. Round-3 fresh
reviewer runs on this revision; M3+M4 code then goes through the gate with
a completion report to the coordinator.
Planned against **ce0926d9** (origin/main, "merge the image verbs into an
image combination tool") - NOT 07eca2c4; the image tool family was replaced
by the `image` combination tool after this session's base was cut, and every
tool-side citation below was re-derived from the new source (coordinator
instruction, chat id 1891).

Two verified defects:

1. **Upscale stalls kill the whole turn at ~60s** (partial mechanism
   verdict; diagnosis-first milestone below).
2. **The image tool's generate op can never work on picker-offered
   ratio-based models** (high; deterministic).

Terminology used throughout: the **server probe** is `resolveStreamContext`
in `supabase/functions/venice/stream-probe.ts`; its **dead-turn janitor** is
the burial branch inside it (`:164-207`); the **cron sweep** is
`nak_sweep_stale_streams` (`supabase/schema.sql:5468`), scheduled every
minute (`:16354-16376`). The **wall deadline** is `WALL_DEADLINE_MS = 380s`
(`getStreamingResponse.ts:150`), the orchestrator's own abort before the
runtime's 400s kill. **Ratio-based model** = a Venice image model whose
catalog entry carries `constraints.aspectRatios[]`; **pixel model** = one
that carries only `widthHeightDivisor`.

## Verified mechanism (all citations on ce0926d9)

### Defect 1: 180s op budget inside a 60s liveness ceiling

- A chat turn's liveness is a heartbeat column, `threads.stream_heartbeat_at`.
  The orchestrator stamps it at turn entry
  (`supabase/functions/venice/getStreamingResponse.ts:558-577`), refreshes it
  every 15s via `setInterval`
  (`getStreamingResponse.ts:160`, interval body `:401-423`), and clears it at
  terminal (`:1516-1531`). The beat write is GUARDED:
  `.not('stream_heartbeat_at', 'is', null)` (`:407-409`) - once the column
  is nulled mid-turn, every later beat silently no-ops.
- Staleness readers at a 60s ceiling: the server probe
  (`stream-probe.ts:75`, check `:83-90`), the browser twin
  (`src/lib/ui/stream-inflight.ts:27`), the cron sweep
  (`schema.sql:5468`; its predicates hardcode the 60s at `:5480-5481` and
  `:5518`).
- Burial paths: the probe's janitor (streaming row + stale heartbeat ->
  row to `error`, `threads.last_error` written, heartbeat cleared,
  `stream-probe.ts:164-207`); the probe's pre-row residue clear
  (`:209-235`); and the cron sweep, which has TWO state-changing
  statements - the streaming-row CTE (`schema.sql:5474-5507`) and a
  residue-clear that nulls the heartbeat on any thread with a >60s-old
  heartbeat with NO streaming-row check (`:5516-5518`).
- Client side, the live drain's silence watchdog probes the server after 30s
  of quiet (`src/lib/chat/stream-transport.ts:204`); the probe's answer comes
  from the same heartbeat. The observed signature - death at ~62s, i.e. the
  SECOND probe - means the probe read the heartbeat as >60s old.
- Image ops are budgeted 180s per attempt (`IMAGE_OP_TIMEOUT_MS`,
  `supabase/functions/_shared/venice.ts:648`; composed signal `:657-672`).
  The upscale endpoint is the fixed `upscaler` model, no `model` field
  (`_shared/venice.ts:815-851`). A legitimate provider stall can therefore
  outlive the turn's liveness ceiling by 3x.
- The stall is provider-side and day-variable: 2026-11-02 findings
  (docs/qa/use-cases/image-editing.md:104-115): 4x died twice at ~60s while
  2x took 5.7s; the 2026-11-03 results row records 2x dying twice at ~60s
  while the session's other image ops (generate, edit x2, remove_bg;
  analyze also ran that session) succeeded in 2-8s in the same thread and
  minute. Client machinery,
  reconnect poll, and the 30MP pre-flight are exonerated.
- The known death class for the isolate itself: Supabase edge runtime kills
  a worker over its CPU-time budget with `CPU Time exceeded` and NO finally
  (docs/dev/chat.md:847-853). Relevant because the upscale result path does
  a per-character base64 expansion of the (tens-of-MB) response plus `btoa`
  (`_shared/venice.ts:714-726`, `imageOpResponseToBase64`) - the one
  CPU-heavy stage in the op path. The same per-character pattern has a
  second copy in `_image_ops.ts:145-148` (attachment download).
- Intent record (archaeology lens): the 60s ceiling landed 2026-09-04
  (d6f341e9) as a deliberate CPU-kill-recovery tradeoff for the TURN, and
  the 180s op budget landed later (a12e08b1, 2026-10-12) with its comment
  citing only the 380s wall deadline (`_shared/venice.ts:642-647`) - the
  180s-vs-60s mismatch was an oversight, not an accepted tradeoff, and the
  repo's own QA log already calls it "a real product gap".

**Open fork (what M2 settles).** The client death proves the heartbeat read
stale at ~62s; it does NOT prove the isolate died. Candidates:

- **Fork A - isolate death / heartbeat stop.** The isolate was killed (CPU
  soft limit) or its event loop blocked, so the 15s interval stopped firing.
  The turn is genuinely dead (or undead-then-zombie); the probe's verdict
  was factually right about the heartbeat.
- **Fork B - false-positive burial.** The isolate kept running and finished
  the op, but the heartbeat went stale or was nulled anyway. Two concrete
  sub-mechanisms: (i) event-loop starvation - the base64 conversion blocks
  the loop >60s so the interval cannot fire while the turn lives on; (ii)
  the cron sweep's residue-clear (`schema.sql:5516-5518`) nulls the
  heartbeat mid-op, after which the guarded beat write (`:407-409`) never
  re-lands. Either way the janitor buried a live turn.

The M2 psql poll watches for the smoking gun of either burial sub-case: a
heartbeat that goes stale/null while the op later completes, and a late
`upscaled-` attachment row proving the isolate survived.

### Defect 2: unconditional dimension injection

- The `image` combination tool's generate op computes width/height from a
  hardcoded aspect-ratio table tuned to venice-sd35's 1280px cap
  (`supabase/functions/venice/tools/image.ts:159-175`, called at `:204`).
- The wire helper forwards width/height whenever numeric
  (`_shared/venice.ts:572-573`) and generateOp passes them unconditionally
  (`image.ts:231-232`). No branch on model constraints exists anywhere in
  the chain.
- Ratio-based models (qwen-image) reject width/height outright and want
  `aspect_ratio` instead. The QA row (settings-image-model-picker.md,
  2026-11-03) records steps 5-6 FAIL on qwen-image and PASS on venice-sd35.
  The coordinator's intake desk reported Venice's 400 wording ("width and
  height are no longer supported for this model. Use aspect_ratio
  instead.") from a live QA session; that exact sentence is NOT captured in
  any repo artifact (evidence audit), so M6's live qwen-image call captures
  the primary 400 body BEFORE the reactive matcher below is trusted.
- The tool's own comment documents this as the v1 risk and names the
  per-model constraint lookup as the follow-up (`image.ts:150-157`);
  archaeology: the deferral is deliberate (d1c9dd9c, 2026-06-26) and the
  combo commit message itself records the bug (ce0926d9). Note the 2026
  comment predicted the WRONG failure mode (a tighter cap, not outright
  rejection) - the fix must not build on the comment's framing.
- The Settings picker filters by price cap only
  (`src/screens/Settings.svelte:882`), and the browser catalog coercion
  drops `model_spec.constraints` entirely
  (`src/lib/models/image-catalog.ts:74-106`) - so incompatible models are
  offered with no signal.
- The constraint data Venice publishes (vendored
  `.claude/skills/venice-models/SKILL.md:85`): image models carry
  `constraints.widthHeightDivisor` and, ONLY on ratio/resolution-based
  models, `aspectRatios[]` + `defaultAspectRatio`. Presence of
  `aspectRatios` is the discriminator between the two sizing modes.
- The chat model compounds the failure by improvising "retrying later would
  likely succeed" advice; the error is deterministic. (No code string says
  this - the model invents it from a generic Venice 400. The fix is an
  honest tool-error message; nothing else to delete.)
- Whole-family check: edit (model/prompt/image only, `_shared/venice.ts:766-774`),
  upscale (image/scale/creativity only, `:825-829`), remove_bg (image only)
  send no dimensions - the gap is generate-only. Fixed-model endpoints
  (upscaler, bria-bg-remover) take no model field, so no per-model lookup
  applies there.
- Second caller flag (hidden-problems lens): `handleImageGenerate`
  (`supabase/functions/venice/index.ts:561-606`, the POST `/image/generate`
  browser proxy, second `veniceGenerateImage` caller) has no `src/` caller
  found. The fix lands in generateOp (the tool); the proxy keeps raw
  passthrough and is flagged to the coordinator as possible dead code, not
  fixed speculatively here.

## Decisions (resolved scope)

- **D1 - No picker dimension filter.** The tool-side per-model lookup fixes
  every model including stale stored ids; filtering the picker would hide
  models that work fine after the fix (and would require re-plumbing the
  browser catalog to carry constraints - more work, worse outcome). The
  picker's price-cap filter and hidden-models behavior get documented
  instead (the intake's doc-drift rider).
- **D2 - Catalog lookup is proactive + reactive backstop.** Proactive: read
  the model's constraints from the live `?type=image` catalog and send
  `aspect_ratio` for ratio-based models, divisor-rounded pixel dimensions
  for pixel models. Reactive: on a generate 400 whose body indicates the
  model rejected fixed dimensions (status 400 AND the body names
  `width`/`height` - deliberately NOT the remembered verbatim sentence,
  which has no primary source in the repo), retry ONCE with width/height
  stripped and `aspect_ratio` added, following the house strip-and-retry
  discipline (`_shared/venice.ts:423-435`: retry immediately, outside any
  schedule, guarded against re-looping). M6 captures the real 400 body to
  confirm the matcher before this ships.
- **D3 - One shared raw-catalog cache, not a second one.** `price-cap.ts`
  already TTL-caches the SAME `?type=image` slice
  (`price-cap.ts:149-160,239-252`). The constraints extraction shares that
  single fetch (extract one raw-catalog fetch+TTL helper keyed on
  `VeniceModelType`, consumed by both `loadImagePrices` and the constraints
  loader) rather than adding a ninth copy of the module-scope cache
  boilerplate or a second wire fetch. On catalog-fetch failure the lookup
  fails open to today's pixel-table behavior rather than failing the op.
- **D4 - Honest descriptor in ratio mode.** generateOp's result descriptor
  reports width/height today from the request dims (`image.ts:248-251`);
  in ratio mode the request has none, so decode the OUTPUT bytes with the
  existing `decodeImageDimensions` (`_image_ops.ts:185-246`) and report
  those (null-tolerant: omit rather than guess; omitting has precedent -
  the edit-family results already omit dims and the card has a
  square-placeholder fallback, `_image_ops.ts:327-329`).
- **D5 - Diagnosis scaffolding is env-gated AND magic-filename-gated, and
  is temporary.** The M2 stall hook fires only when BOTH an env var
  (`NAK_UPSCALE_TEST_STALL_MS`) is set on the serve process AND the call's
  `filename` argument equals the exact magic name `zzqa-stall.png` - the
  hook sits above the attachment lookup, so no file needs to exist. A
  thread-id-prefix gate was rejected: `threads.id` is `uuid`
  (`supabase/schema.sql:293`), not text. The shared edge runtime serves
  both sessions; the filename gate keeps garrick's in-flight QA from
  stalling. The hook ships in a clearly-labeled commit and is reverted
  before the branch is declared done (M6 owns the revert).
- **D6 - The op-pairing rider is already satisfied on ce0926d9.** The combo
  schema leads with "Every call MUST carry `op` ... REQUIRED on every call,
  including the very first image call"
  (`src/lib/tools/image.schema.ts:53-54,80-86`). No further sharpening;
  M4 does not touch the schema (D7).
- **D7 - The ratio-mode `aspect_ratio` value is the EXISTING tool argument.**
  The LLM already supplies `aspect_ratio` (`image.schema.ts:114-119`), and
  generateOp already reads it (`image.ts:202-203`, defaulting to `1:1`).
  Ratio mode validates that argument against the model's `aspectRatios`:
  in the list -> send as-is; not in the list (including the implicit
  default) -> send `defaultAspectRatio`; no default advertised -> omit the
  field. No schema change.
- **D8 - The op budget reaches the dispatch site via a ToolDef field.**
  `IMAGE_OP_TIMEOUT_MS` is module-private and invisible to the dispatch
  loop (`performToolCall.ts` carries no budget surface). M3 exports the
  constant and adds an optional `quietBudgetMs` field to `ToolDef`; the
  image tool declares it; the orchestrator writes the deadline from the
  dispatched tool's declaration (no name-based map to drift). The
  dispatch-site knowledge is a FOURTH coupled site (with probe, browser
  twin, cron) and gets a coupling comment.
- **D9 - Deadline writes fail open.** If the deadline UPDATE fails
  (transient error, mixed-version window), the op proceeds with today's
  60s behavior; an unguarded throw would fail the turn at the exact moment
  the fix protects it.
- **D10 - Fork A's conversion fix covers both copies** of the per-character
  pattern (`_shared/venice.ts:721-724` and `_image_ops.ts:145-148`).

## Milestones

### M1 - This plan, committed

Committed (b746e014) on branch `upscaler-liveness-image-models` before any
code; revised per the round-1 lenses. Consensus rounds continue before
M3/M4 code; the coordinator's approval gates all code.

### M2 - Instrumented repro: settle the fork (ZERO Venice calls)

Requires a serve-ownership window (proposed to guard-5 + garrick when M2 is
ready: window 1 = this repro, ~45min; window 2 = M6 QA, ~1h): the served
functions must run THIS worktree's code. Stack-dependent; waits for garrick's
restore confirmation and the scheduled window. At window start and end,
re-apply THIS worktree's schema to the LOCAL stack ONLY:
`mise run dev-sql < supabase/schema.sql` (dev-sql is loopback-guarded psql
against the local stack; schema.sql is idempotent start-to-finish by house
rule). NEVER `mise run sync` for this - that task re-applies schema to the
LINKED PROD PROJECT outside the deploy pipeline (coordinator correction,
chat id 1899); prod schema lands only via the deploy pipeline's
sync-supabase job after merge.

Instrumentation (env- AND magic-filename-gated, D5):

1. A hook at the top of `upscaleOp` (`image.ts:336`), before key/cap/lookup,
   that fires only on `filename === 'zzqa-stall.png'`: sleeps `stallMs`
   (reuse `sleepCancellable`, `_shared/venice.ts:375-388`, exported for the
   hook) and then returns a fake `buildImageOpResult` envelope. No Venice
   call, no attachment needed. The turn goes silent for exactly the chosen
   duration - the same shape as a provider stall.
2. V2's conversion block must be REAL: after the sleep, the hook
   synchronously runs the same per-character base64 expansion the real
   response path uses (`String.fromCharCode` per byte + `btoa` over a
   ~40MB buffer) - a pre-built fake base64 string would NOT block the
   event loop, and V2 exists to test exactly that starvation.
3. Heartbeat beat logging: one debug line per successful beat in the
   interval body (`getStreamingResponse.ts:404-423` logs failures already).
4. Window-start probe: one log line confirming `Deno.env` sees
   `NAK_UPSCALE_TEST_STALL_MS` inside the served function (env plumbing
   into the edge runtime is otherwise unverifiable from the repo), and one
   dev-sql assertion that the LIVE `nak_sweep_stale_streams` body contains
   the deadline gate (`pg_get_functiondef`) - catching mid-window schema
   skew cheaply.

Procedure, per variant (drive one chat turn per variant in a `ZZQA-UP-`-
titled thread: "upscale the image zzqa-stall.png"; the hook fires on the
magic filename above the attachment lookup so no source image is needed):

- Poll psql (read-only, shared stack) every 5s during and 3min after:
  `threads.stream_heartbeat_at` age (watch specifically for null-then-
  never-resume, the residue-clear + beat-guard signature), the streaming
  row's status, and `message_attachments` for a late `upscaled-` row.
- Capture the edge-runtime console for the window: the serve log is
  redirected with `>>` APPEND into a bounded, purged location (the opencode
  tmp dir) - NEVER `>` into /private/tmp, the 140GB disk-fill failure class
  in project memory - plus the in-app Logs drawer's `stream`-source probe
  verdicts (`stream-probe.ts:246-251`). garrick's terminal is not required.

Variants and verdict table:

| Variant | Observation | Verdict |
|---|---|---|
| V1: small fake result, stall 100s | Beats continue past 60s; client stays live; turn completes | Quiet awaits exonerated LOCALLY; fork unresolved - the real conversion path (and any CPU kill) never ran in V1 |
| V1 | Beats stop while the hook's `await` pends; edge console shows kill | Fork A, repro'd: isolate death on pending op (note as local-runtime caveat) |
| V2: hook performs the real per-char conversion burn (~40MB) after the stall | Beats stop during the burn; client buries at ~62s; LATER the attachment still lands (isolate survived) | Fork B (i) proven: burial by event-loop starvation; fix = M3 Fork B design (all readers + beat guard) |
| V2 | Beats stop during the burn; edge console shows `CPU Time exceeded`; nothing lands after | Fork A by CPU soft limit; fix = M3 Fork A design (cut conversion burn) |
| Either | Heartbeat nulled mid-op (not just stale) and never resumes while the turn lives | Fork B (ii) via cron residue-clear + guarded beat write; M3 Fork B must gate BOTH |

Record the verdict + evidence in this plan (a new "M2 findings" section)
and in the image-editing.md results log.

### M3 - Defect 1 fix: chunked, yielding base64 conversion (both copies)

Coordinator shape call (chat ids 1938-1939, after the M2 verdict): the
conversion fix is THE fix and goes primary; the op-deadline column is
DEFERRED as a documented standby design (kept below, not built). No schema
change. Rationale: with the loop never blocking more than a frame, beats
survive real outputs (V1 proved quiet awaits are safe when the loop is
free); the residue-clear race becomes unreachable (it only touches >60s-
stale heartbeats, which no longer occur mid-op); provider stalls are
already covered by the heartbeat itself; and the chunked form cuts CPU
burn, shrinking the prod CPU-kill odds for free.

Test prerequisite BEFORE the change (safe-to-modify lens - the existing
tests assert shape only and would pass subtly-wrong bytes): add a
round-trip assertion to `supabase/functions/tests/image-op-tools.test.ts`
(decoding the produced base64 and comparing against the stubbed response
bytes, covering both conversion call sites).

The fix:

- One shared helper in `_shared/venice.ts`
  (`base64FromBytesChunked(bytes, opts?)`): walks the `Uint8Array` in
  24 576-byte slices (a multiple of 3, so no inter-chunk padding), builds
  each slice's base64 with a chunked `String.fromCharCode.apply` + `btoa`
  pair, and AWAITS a macrotask (`setTimeout` 0) between slices. The yield
  is the load-bearing part - it is what lets the 15s heartbeat interval
  fire during a multi-second conversion. Returns the joined string.
  Padding only in the final slice (standard incremental base64 rule).
- Call site 1: `imageOpResponseToBase64` (`_shared/venice.ts:714-726`)
  drops its per-character loop + giant `btoa` and calls the helper.
- Call site 2: `attachmentObjectAsBase64`
  (`supabase/functions/venice/tools/_image_ops.ts:132-150`) - same swap
  for the attachment-download copy (edit / remove_bg data URIs).
- Both sites' return contracts are unchanged (raw base64 string in,
  mimeType handled by the caller).
- Tests: the round-trip prerequisite above, plus an asymmetric-length case
  (chunk size not dividing the byte length: 1, 2, 3, chunk+1 bytes) to pin
  the final-slice padding rule, and a test that the helper yields
  (await-between-chunks observable via a fake timer ordering or by
  asserting `setTimeout` was scheduled between chunks).

**Deferred standby design (documented, audited round 1-2, NOT built):**
the op-aware liveness extension - `threads.stream_op_deadline_at` column
written from a ToolDef `quietBudgetMs` declaration (D8), read by FOUR
coupled sites (server probe incl. janitor + residue clear; the browser
twin's three data paths; the cron sweep's CTE; the cron sweep's
residue-clear, whose unguarded null + the guarded beat write made burial
permanent in V2). State matrix and precedence rules as recorded in the
round-1/2 plan text (git history). If burial ever recurs after the
conversion fix, this design is already written and audited. The
findings-and-stop authority for a prod CPU-kill remains confirmed
(coordinator, chat id 1900).

Gate: `mise run check` green before every commit (the Deno island covers
the edge code).

### M4 - Defect 2 fix: per-model constraint lookup

1. Constraints extraction sharing the price-cap raw-catalog cache (D3):
   one raw `?type=image` fetch per TTL per isolate feeds both
   `loadImagePrices` and a new per-model `{ mode: 'pixel' | 'ratio',
   divisor?, aspectRatios?, defaultAspectRatio? }` extraction. Fail-open to
   `null` on fetch/parse trouble.
2. `veniceGenerateImage` gains an optional `aspectRatio` field, forwarded
   as `aspect_ratio` only when supplied (`_shared/venice.ts:564-579`
   forwarding discipline; strict-body endpoint).
3. `generateOp`: resolve constraints for the picked model.
   - Ratio mode: validate the existing tool argument (D7) against
     `aspectRatios`; send NO width/height.
   - Pixel mode: keep the table but round both edges to
     `widthHeightDivisor` (and keep the existing <=1280 cap).
   - Unknown/no constraints (fetch failed, unlisted model): today's
     behavior exactly (D3 fail-open). Note: no live sample exists of a
     pixel model whose table dims violate its divisor - the rounding is
     defensive, verified by unit test only.
4. Reactive backstop (D2): in generateOp, a 400 indicating fixed-dimension
   rejection is retried ONCE with width/height stripped and
   `aspect_ratio` added (the same value the proactive ratio path would
   send: the validated tool argument, else the model's
   `defaultAspectRatio`); matcher confirmed against the captured primary
   400 body (M6's first qwen-image call doubles as this capture; if the
   captured body contradicts the matcher, adjust the matcher and re-run
   the affected picker step). One warn log line naming the model. The
   `/image/generate` proxy caller keeps raw passthrough (flagged, not
   fixed).
5. Honest error (D2): when the generation still fails on a
   dimensions/constraints 400, the tool error says the picked model cannot
   take fixed pixel dimensions and names the remedy ("switch image models
   in Settings -> AI -> Image generation"). No "retry later" implication.
6. Descriptor dims from output bytes in ratio mode (D4).
7. Tests (`supabase/functions/tests/image-op-tools.test.ts` - the harness
   already stubs `/models?type=image` at `:165-168` and captures request
   bodies): ratio model -> aspect_ratio on the wire, no width/height;
   ratio model + off-list requested ratio -> defaultAspectRatio; pixel
   model -> divisor-rounded dims; constraints-fetch failure -> legacy
   behavior; 400 -> one retry then honest error; descriptor dims decoded.

### M5 - Docs and QA use-case updates (same change)

- `docs/dev/image-editing.md`: generate-op dimension constraints section;
  the firered-latency gotcha gains the M2/M3 liveness findings (what the
  mechanism actually was and what protects a slow op now).
- `docs/dev/chat.md`: the liveness gotcha (847-865) gains the M2/M3
  mechanism rewrite (the turn deaths were the per-char conversion blocking
  the event loop and starving the heartbeat, with the sweep's residue-clear
  making it permanent - not provider latency alone). No new column exists,
  so no contract text changes.
- `docs/qa/use-cases/settings-image-model-picker.md`: add the missing
  **Image editing picker** section and the **price-cap hidden-models**
  note (the intake's doc-drift rider; the 2026-11-03 results row already
  flags this drift).
- `docs/user/`: `docs/user/image-editing.md` gets one sentence if
  generate-now-works-everywhere is user-visible wording; the picker page
  (`docs/user/models.md`) only if picker copy changes (it should not, D1).

### M6 - QA execution and close-out

- Use cases (per CLAUDE.md's before/after discipline; the "before"
  baselines already exist in the results logs):
  - `image-editing.md` steps 2-7 AFTER (combo already covered the before).
  - `settings-image-model-picker.md` full re-run AFTER (includes the
    qwen-image steps 5-6 that failed - the money shot for defect 2; its
    first qwen-image call also captures the primary 400 body for D2's
    matcher).
  - `chat-generated-image-card.md` regression pass on the default model.
- SERVE-OWNERSHIP PRECONDITION: M4's tool changes live in the served edge
  code - all Venice-calling QA runs inside a claimed serve window from this
  worktree, never against garrick's served checkout (old tool code would
  false-FAIL the qwen-image steps).
- Shared-browser protocol per coordinator instructions (own Vite, own
  `http://[::1]` origin, `playwright_browser_run_code_unsafe` with explicit
  page selection, `ZZQA-UP-` threads, delete only own rows).
- Model-switch QA writes `profiles.settings` for the shared dev user
  (`persistImageModel`) - schedule each picker-drive window with the
  coordinator so garrick's QA is not stomped.
- Close-out owns the D5 revert: the stall-hook commit is reverted (or
  reduced to the final fix diff) before "done" is declared.
- Cron-leg verification: DROPPED as a check - M3 changes no SQL and no
  sweep logic, so the sweep is untouched by this fix (its 60s predicates
  stand exactly as before). The deferred op-deadline design's checks would
  only apply if that standby ever lands.
- Venice call budget (real API calls against `app_config`'s key; counted
  as IMAGE-OP calls - each M2 variant is a full chat turn whose priming and
  tool-round completions are ordinary paid chat traffic, not image calls):
  M2: **0** image-op calls (the hook short-circuits the Venice image call).
  M4 dev testing: **0** (unit tests stub fetch). M6: generate on qwen-image
  (1), generate on venice-sd35 (1), edit (1), upscale 2x (1), remove_bg
  (1), generated-card regression (1) = **6**, plus one optional real
  stalled upscale post-fix IF Venice is stalling that day, to confirm the
  M3 fix against the real failure (+1). Total planned: 6-7 image-op calls.

## Risks / blast radius

- DEFERRED (standby design, not built): the op-deadline column touched
  FOUR coupled sites that must move together (probe, browser twin on all
  its data paths including the raw mirror read, cron CTE, cron residue-
  clear) plus the ToolDef budget surface (D8). The design and its coupling
  analysis stay in git history for resurrection if burial recurs after M3.
  The schema-skew rule below applied to the M2 window and stands for any
  future serve window.
- CROSS-CHECKOUT SCHEMA SKEW (hidden-problems blocker): schema.sql is
  applied to the local stack by whoever saved last while functions serve
  from another checkout - the cron body and the serving orchestrator can
  oscillate for as long as the other session keeps applying its schema.
  Rule: re-apply this worktree's schema to the LOCAL stack ONLY
  (`mise run dev-sql < supabase/schema.sql`) at the start AND end of every
  claimed serve window, and schedule windows with garrick (his QA shares
  the tables). NEVER `mise run sync` - that targets the linked PROD
  project. A mixed-version window degrades via D9 fail-open, not a crash.
- The reactive 400 retry fires at most once (no loop); the matcher is
  deliberately broad (400 + width/height named) until the primary 400 body
  is captured; everything else propagates unchanged.
- Wire traffic does not grow: the constraints extraction shares the
  price-cap cache's single `?type=image` fetch (D3).
- Edge-serve ownership: all served-code work behind a claimed window; never
  restart the runtime unannounced (coordinator rule, chat id 1891).

## Coordinator review decisions (2026-11-03, chat ids 1899-1900)

Plan approved to proceed to round 2 with one blocking correction (the
`mise run sync` -> `dev-sql` fix above) and these confirmed answers:

- **Serve windows:** proposed concretely when M2 is ready (window 1 =
  M2 repro ~45min; window 2 = M6 QA ~1h) to guard-5 AND garrick; nothing
  stack-dependent until garrick's restore confirmation comes through the
  coordinator. Console capture via `>>` append into a bounded, purged
  location; garrick's terminal not required.
- **Venice budget:** 6-7 real calls approved as proportionate.
- **Pending-await kill:** findings-and-stop confirmed; no speculative
  restructure of the turn machinery.
- **Cron verification:** scripted dev-sql checks during the serve window,
  documented in the use case; no pgTAP.
- **Approved as-written:** D1 (no picker filter), D2
  (broad-matcher-then-confirm), D3 (shared TTL cache), D5 (env-gated +
  magic-filename-gated temporary hook, M6 revert), D8 (ToolDef
  quietBudgetMs - deferred with the standby design), D9 (fail-open
  deadline writes - deferred with the standby design), the cross-checkout
  schema-skew rule (with the dev-sql correction), and the /image/generate
  proxy dead-code flag (report, do not fix).

## Accepted risks (knowingly open)

- The verbatim Venice 400 wording for qwen-image is unverified in-repo;
  the reactive matcher is written broad and gets confirmed against the
  captured primary body at M6 before the branch is declared done.
- Pixel-model divisor rounding has no live sample (all known pixel models
  accept the existing table); it is defensive and unit-tested only.
- The POST `/image/generate` proxy (`index.ts:561-606`) may be dead code;
  flagged to the coordinator, not fixed in this branch.
- Residual burial path after M3: >60s of consecutive heartbeat WRITE
  FAILURES mid-op (a DB outage, not loop starvation) would still null the
  heartbeat via the residue-clear and permanently silence the guarded beat
  write. The conversion fix removes the loop-starvation trigger; a DB
  outage during an op remains a rare burial vector (accepted; the deferred
  standby design is the full answer if it ever shows up).

## M2 findings

Window executed 2026-11-03 ~18:03-18:15Z (serve ownership claimed and
released; scaffolding commits 359c9d1b + 0e02f7d0; zero image-op Venice
calls). Logs + polls saved in the session's bounded tmp dir.

**Verdict: Fork B - false-positive burial - PROVEN. The production
signature reproduced end to end.**

- **V1 (100s quiet await, small fake result): clean pass.** Heartbeat
  beats continued at 15s through the entire pending op; the client's ~62s
  silence probe read `verdict=in-flight(pregame)` with a fresh heartbeat;
  the turn completed at 100s with the attachment landing. A pending image
  op alone does not kill the turn - quiet awaits are exonerated.
- **V2 (30s stall + 90s event-loop block via the REAL per-char conversion):
  exact field signature.** Beats stopped when the burn began (event loop
  blocked, interval cannot fire). The client probe at +62s read the
  heartbeat stale -> `verdict=quiet` -> `StreamDisconnectedError` -> the
  production line "[chat] live stream disconnected mid-turn; handing off
  to reconnect poll" -> "Response interrupted mid-turn" recovery row.
  The isolate was ALIVE the whole time (no CPU kill).
- **Fork B(ii) confirmed live:** the residue-clear nulled the heartbeat
  mid-op (`heartbeat=null verdict=quiet` one probe after the burial) - the
  guarded beat write (`.not('stream_heartbeat_at','is',null)`) can never
  resume after that. One race = permanent silence.
- **Bonus finding (M3 shape):** the per-character conversion is
  catastrophically slow in the edge runtime - a single 64MB pass did not
  finish in 230s. A real 25-80MB upscale output starves beats 90s+ by
  itself, no provider stall required. The conversion is the burial
  TRIGGER for real outputs, not just a perf smell.
- The local runtime wall-clock terminated the burning isolate at ~277s
  ("early termination has been triggered", no finally) - env caveat: the
  local edge-runtime 1.74.3 wall limit is NOT the 400s prod figure.
- Env plumbing note: `supabase functions serve` does NOT pass host env to
  isolates; the hook env must ride `--env-file` (first V1 attempt was a
  no-op until fixed).

M3 shape: superseded by the M3 rewrite above (coordinator ruling, chat
ids 1938-1939): chunked conversion is the primary fix; the op-deadline
design is deferred to the standby section.
