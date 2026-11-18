# Venice Decision Models Plan

Status: PLANNED 2026-11-18 (branch venice-decisions, worktree off
3293f55b). Research + live calibration done; infra milestones below
not started.

## SYNOPSIS

Two things in one plan, because one motivated the other:

1. **Infra (build now):** wire support for Venice's decision models -
   a `veniceDecision` helper, a `/decisions` route on the venice
   function, tests, and the split of the 1,378-line
   `_shared/venice.ts` into per-concern submodules so the new helper
   has a clean home.
2. **Brainstorm (capture, do not build):** the candidate nak features
   that typed decisions could improve, recorded here so future plans
   start from this page instead of re-researching.

## BACKGROUND: what decision models are

Venice added a `decision` model type (`GET /models?type=decision`)
with a dedicated endpoint, `POST /api/v1/decisions` (beta). Instead of
generating text, the model answers **typed questions about a state**
and returns machine-ready judgments. One call carries one `state`
(string, JSON object, or array; 32k tokens) and a map of questions;
each question is evaluated independently against the same state.

Three question types:

- `noul` - yes/no, returns a probability 0..1. No separate confidence
  field; the probability is the confidence.
- `choice` - closed-set pick; returns the pick, every option's
  probability (sum 1), and a 0..1 `confidence`.
- `score` - ordered rubric (array of level descriptions, >= 2
  levels); returns a probability-weighted `score` that can land
  between levels, the level `legend`, the distribution, and
  `confidence`.

Answers come back under caller-chosen question ids. No prose is
returned anywhere. Optional `images` (up to 4 PNG/JPEG, inline base64)
and a Jev-only `assets` map for named image references. The endpoint
is also aliased at `/systemone` for TypeSafe SDK compatibility.

Models (both beta; ids from the live catalog 2026-11-18):

| Model | Privacy | Pricing (per Mtok) | Limits |
| --- | --- | --- | --- |
| `jev-latest` (TypeSafe) | Anonymized | $0.042 in / $0 out | 32k state, 64k total |
| `clef-api` (Cloudflare) | Private (zero retention) | $0.05 / $0.05 | 32k / 32k |

Nak's whole agent fleet runs on Venice-private serving
(`supabase/functions/_shared/agent-models.ts:19-28`). Jev's anonymized
tier sends the state to a third-party provider (identity stripped);
Clef keeps the zero-retention posture nak already guarantees.

### Live calibration (2026-11-18, nak's key, probe traffic only)

- **Batching is sublinear.** One question on a small state: 392
  input tokens. Four questions on the SAME state: 546. The state's
  tokens are counted once, not per question; the marginal cost of a
  question is its own text. Per-bias, per-intent, per-item question
  fan-outs are cheap.
- **Latency ~360ms** wall for a small single-question call,
  sub-second for a four-question call. No thinking pass exists to
  pin or pay for.
- **Answer shapes match the docs exactly** (noul float; choice with
  full distribution + confidence; score with legend + distribution +
  confidence).

Provenance: the API contract above (endpoint, question types,
limits, model ids) rests on docs.venice.ai and the 2026-11-18 live
probes. Nothing vendored in-repo documents it - the vendored
`venice-*` skills predate the feature - so these facts are not
repo-checkable; RISKS covers the beta-drift consequence.

## BRAINSTORM: candidate applications

Ranked by fit. The dividing line in every case: decision models
answer bounded questions and return NO prose, so any step that emits
prose (a note, a rationale, a summary) still needs a chat completion.
The pattern to aim for: the decision call runs always (cheap, fast,
typed), the chat call runs only when the verdict says it is needed.

- **B1 - Pre-flight gate (Jeff's idea): decide when to run the full
  priming chain.** The priming stage's refresh trigger today is
  deterministic: cold start, mood-band change, an 8-user-round fuse,
  or a 1-hour wall-clock fuse
  (`supabase/functions/_shared/priming-triggers.ts:32,41,78-107`).
  Those fuses cannot see a TOPIC PIVOT: a conversation can change
  subject completely while the band holds steady and the round count
  stays under 8, and the next turn rides a stale intuition/recall
  payload until a fuse trips. A decision call ("does this user
  message pivot the topic or raise something the cached payload
  cannot inform?" as a noul over the message + a payload digest)
  adds the semantic trigger the fuses lack, and could let the round
  fuse stretch (fewer full refreshes) because the semantic check
  guards drift. Cost shape: ~360ms + cents on the turn's critical
  path, against a full refresh fan-out that costs seconds. Open
  questions: where it runs (inside `runServerPriming` before the
  trigger evaluation), what state it sees (message only, or message
  plus a cached payload digest), and the false-negative cost of
  skipping a refresh. Privacy: the user's message would go to the
  decision model on every turn - the private-tier model is
  load-bearing here.
- **B2 - Second-thoughts verdict.** The reflex's disposition is a
  closed enum (`conviction | hedge | reframe | correct`,
  `supabase/functions/venice/agents/second_thoughts.ts:77-88`). A
  `choice` question returns the verdict plus a real confidence to
  gate the panel; the prose `note` is the only part needing a
  completion, and doubt is rare by design - run the decision call
  always, pay for the note only when doubt fires. History: a
  reasoning model leaked chain-of-thought around the JSON verdict
  and produced usable output on ~40% of turns
  (`second_thoughts.ts:58-71`); a decision model has no chain to
  leak. The 32k state cap covers the turn slice (6 background rows,
  tool results capped at 4k chars, `second_thoughts.ts:109-116`).
- **B3 - Grocery section classifier.** A closed-set `choice` per
  item, currently a browser-side chat completion with hand-rolled
  JSON parsing, `finish_reason` triage, and a pinned thinking pass
  (`src/lib/grocery-section-agent.ts:189-229`). A decision call
  replaces the parsing scaffolding, and the probability
  distribution answers "how confident was the filing" for real.
  Needs a browser proxy route (same shape as `/complete`'s).
- **B4 - Intent employment judge.** The prompt asks for
  `opening: true/false`, `acted: true/false`,
  `reaction: receptive|neutral|resistant` per intent
  (`supabase/functions/venice/agents/intent_employment.ts:43-54`) -
  two noul questions and one choice question per intent, minted
  dynamically from the active intent list. The `reasoning` sentence
  would be lost; it is telemetry, not product
  (`intent_employment.ts:37-42`).
- **B5 - Follow-up / intent resolution checks.** "Did this turn
  resolve the pending follow-up?" is a noul. Today that check is
  folded into the reflection agent's prose reasoning.
- **B6 - Bias observer (partial, do not lead with it).** The
  Beta-Binomial aggregate would happily eat noul probabilities per
  bias key, and batching makes per-bias questions cheap. But the
  observer's falsification discipline is generative judgment
  (`supabase/functions/venice/agents/bias.ts:102-123`) and the
  reactions half needs prose; bare noul calls risk exactly the
  false positives the prompt works to prevent.
- **B7 - Generated-image QA (speculative).** The `images` input
  (up to 4) would let a noul check "does this generated image match
  the request" before the attach step. Adds latency to image
  generation; park until a real complaint exists.

**Not fits:** auto-title, summary, digest, samskara formation
(generation); intuition perception (needs the 1M window; the 32k cap
disqualifies it); reflection and the wiki family (tool loops). Rule
of thumb: decision models own the EASY_TASK tier's classification
half (`agent-models.ts:43-47`), minus anything that emits prose.

## DECISIONS (resolved scope, do not re-litigate)

- **D1 - Private model first.** `clef-api` is the default decision
  model for any caller that evaluates user content; `jev-latest` may
  serve non-sensitive classification later. Rationale: the fleet's
  privacy posture is zero-retention Venice serving, and every strong
  candidate (B1, B2, B4) sends user words. The $0.008/Mtok gap is
  noise. The helper stays model-agnostic (the caller picks the id);
  the constant lands with the first real caller, not now - an
  unused constant is an orphan (dead-code hygiene).
- **D2 - The reorg is a mechanical split, not a redesign.**
  `_shared/venice.ts` becomes a re-export barrel over
  `_shared/venice/<concern>.ts` submodules. Every import site keeps
  its `_shared/venice.ts` specifier. Inventory (30 sites, review
  round 1): 15 non-test sites import `'../_shared/venice.ts'` or
  `'../../_shared/venice.ts'` (`venice/index.ts:50`,
  `venice/feature-rejections.ts:38`, `venice/getStreamingCompletion.ts:68`,
  `venice/tools/_venice_complete.ts:17`, `venice/tools/_image_ops.ts:20`,
  `venice/tools/web_search.ts:39`, `venice/tools/image.ts:57`,
  `venice/tools/_vision.ts:20`, `venice/priming/intuition.ts:39`,
  `venice/agents/_curation_helpers.ts:13`, `venice/agents/samskara.ts:49`,
  `venice/mcp/dispatch.ts:28`, `venice/mcp/handlers.ts:35`,
  `venice/mcp/oauth.ts:38`, `venice/getStreamingResponse.ts:86`);
  2 sibling sites inside `_shared/` import `'./venice.ts'`
  (`price-cap.ts:31`, `image-model-constraints.ts:25`); 13 test
  files import from `'../_shared/venice.ts'`. Code moves verbatim:
  no signature changes, no behavior edits, no comment rewrites
  beyond the moves' own headers - except relative-import
  specifiers, which rewrite when a move crosses the directory line
  (the `./venice-stream.ts` type import becomes
  `../venice-stream.ts` from inside `_shared/venice/`). The
  file-plus-directory layout is
  safe under Deno: every site uses an explicit `.ts` specifier and
  `supabase/functions/deno.json` has no bare-specifier mapping that
  could collide.
- **D3 - Infra only; no feature callers in this change.** The route
  and helper ship with tests but no production caller. B1-B7 stay
  unbuilt here; each gets its own plan when picked up. The route and
  helper are exercised by their Deno tests, so the dead-code gates
  that scan them (functions-check, functions-test) stay green.
- **D4 - The helper is a thin verbatim relay, single attempt.**
  Same contract as `veniceComplete`
  (`supabase/functions/_shared/venice.ts:390-404`): forward the body
  untouched, return the parsed JSON untouched, map errors like the
  siblings (429 -> `rate_limit` with `retryAfterMs`; other non-OK ->
  `http`; connection -> `network`; non-JSON success -> `parse`). No
  retry loop yet - both best-effort callers in the brainstorm (B2,
  B3) degrade cleanly, and the first caller that wants
  `veniceComplete`'s transient retry copies it. Request-shaping
  (typed question maps) lives with future callers, keeping beta
  schema drift a caller-side concern.
- **D5 - `/decisions` runs in the user-auth tier, mirroring
  `/complete`.** Gateway verify_jwt authenticates; the handler does
  the JSON-object check, the blocked-model check, and the
  `requireVeniceEnv` key handoff
  (`supabase/functions/venice/index.ts:456-478`). No userId needed -
  the handler is a pure relay and keeps no per-user state.
- **D6 - Error bodies get the 600-char slice, not 200.** Beta
  validation failures come back as `DetailedError` bodies with a
  details map that can run long, and decisions errors are
  debug-facing: the 502 path logs the message for `supabase logs`,
  where a truncated body would hide the field Venice rejected. The
  completions helper made the same 600 choice for a different
  reason (user-facing surfaces, `_shared/venice.ts:487-492`); here
  the rationale is beta debugging legibility, nothing more.

## PLAN

- **M1 - Split `_shared/venice.ts` (mechanical).** New directory
  `supabase/functions/_shared/venice/` with: `shared.ts` (the base
  URL constant, `VeniceError`, `parseVeniceRetryAfterMs` - the
  plumbing every helper shares), `complete.ts` (the completion
  proxy, its retry schedule, and the strict-validation wire-field
  machinery: `DROPPABLE_WIRE_FIELDS`, `hasWireField`,
  `deleteWireField`, `stripModelQuirkFields`, `rejectedWireField`),
  `image.ts` (the generate + edit/upscale/background-remove family
  plus `base64FromBytesChunked`), `text-parser.ts`, `scrape.ts`,
  `billing.ts` (usage analytics and key usage), `models.ts` (the
  fetch plus the raw-catalog TTL cache), and `decisions.ts` (M2).
  `venice.ts` becomes a barrel: the island-stance header comment
  plus one `export * from` per submodule. Two private helpers cross the new
  file lines and become exported with a comment naming why:
  `parseVeniceRetryAfterMs` (complete + decisions) and
  `DEFAULT_BASE_URL` (currently an unexported `const` used at 10
  sites across six future submodules). Every other private helper
  stays within its single submodule (verified by usage grep, review
  round 1). Nothing else changes.
- **M2 - `venice/decisions.ts` helper.** `veniceDecision(opts)`
  with `{ apiKey, body, baseUrl?, fetchImpl?, signal? }`, POST to
  `/decisions`, per D4. Header comment states the beta stance: wire
  shapes may move without notice, the relay stays thin on purpose.
- **M3 - `/decisions` route.** `handleDecisions` in
  `supabase/functions/venice/index.ts` per D5, registered in the
  serve block next to the `/complete` line (`index.ts:1292`) and
  added to the file-header route inventory (`index.ts:4-35`,
  `/complete` documented at `:29`), with the same 429/502/500 error
  mapping and the upstream-failure `console.error` that keeps the
  502 legible in `supabase logs` (`index.ts:500-515`).
- **M4 - `tests/venice-decisions.test.ts`.** Mirrors
  `tests/venice-complete.test.ts:9-43`: injected-fetch verbatim
  forward + parsed-response passthrough, 429 -> `rate_limit` with
  Retry-After, the reset-header fallback, non-OK -> `http`,
  network, and parse-error cases. Imports from the barrel like
  every sibling test.
- **M5 - Docs.** `docs/dev/architecture.md:298` route list gains
  `/decisions`. `supabase/functions/README.md` mentions
  `_shared/venice.ts` (`README.md:71-72`) - update the pointer to
  the barrel + submodule layout. Six living dev docs name
  `_shared/venice.ts` as the file holding symbols that will live in
  submodules; repoint each at the owning submodule:
  `docs/dev/chat.md:265`, `:275`, `:353`, `:914`;
  `docs/dev/image-editing.md:20`; `docs/dev/auto-title.md:186`;
  `docs/dev/tools.md:118`. Plus the one code comment that names the
  file in prose, `src/lib/venice.ts:685`. Historical plan docs
  (`docs/dev/plans/image-editing-plan.md` and siblings) are
  point-in-time records and stay as written. Four function-tree
  comments name `_shared/venice.ts` in prose
  (`_shared/backfill.ts:20`, `venice/inline-images.ts:46`,
  `venice/getStreamingCompletion.ts:95`, `venice/feature-rejections.ts:25`)
  and deliberately keep pointing at the barrel: the barrel stays
  the stable import surface and re-exports every symbol they name,
  so their claims remain true after the split. Repointing is a
  living-docs treatment only. This plan doc is the
  brainstorm record.

## VERIFICATION

- `mise run check` before each commit, exit code read directly (no
  pipes). Two of its tasks prove the barrel: `functions-check` runs
  `deno check` over the five entrypoint import graphs (every
  entrypoint-reachable export must resolve through the barrel), and
  `functions-test` type-checks the test import graph, which covers
  barrel-only symbols tests import directly (`buildAnalyticsQuery`,
  `selectKeyUsage` - `tests/usage.test.ts:11`,
  `tests/key-usage.test.ts:12`). Knip is NOT part of this proof: its
  globs (`knip.json` project: `src/**`, `scripts/**`) never scan
  `supabase/functions`, so it is silent about this entire surface.
- `deno test` over the new test file runs offline (injected fetch).
- No browser surface exists; nothing in `docs/user/` changes.

## RISKS

- **main is moving under this branch.** Another session is merging
  recipe-side work to main (heads-up exchanged over thatch chat).
  Rebase onto origin/main immediately before the final commit and
  re-run the gate; the split is file-local to `supabase/functions/`,
  so a textual collision is unlikely but a semantic one (a new
  `_shared/venice.ts` consumer on main) would show up in
  `functions-check`.
- **Beta drift.** Venice may change the `/decisions` wire shape
  without notice. The relay forwards verbatim both ways, so drift
  surfaces as upstream 400s (legible in the 502 body per D6), not
  as silent coercion bugs. The brainstorm's callers own typed
  coercion and will pin it with tests when they land.
