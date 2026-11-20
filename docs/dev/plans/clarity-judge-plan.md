# Clarity Judge + Auto-Rewrite (B8)

Status: PLAN (round-1 lens fan-out folded; round-2 reviewer pending).

## SYNOPSIS

Three layers, all riding the existing chat machinery:

1. **The baseline**: a positive-phrased clarity block in the chat's
   system prompt (and the wiki-family prompts) - the model writes
   clean from the start, so the judge rarely fires.
2. **The judge**: after the terminal round's response commits, ONE
   batched `clef-api` decision call asks TWO questions about the
   response: `primarily-text` (noul - is this response prose rather
   than code or structured output?) and `clarity` (score, 1-4
   rubric: riddled -> clean). A deterministic mechanical scan (the
   dash/quote/filler checks) runs alongside, model-free.
3. **The rewrite**: a low score on a text response triggers ONE
   streamed rewrite - a NEW assistant message after the original
   (nothing is hidden or edited), introduced by a notice the user
   sees in the turn. END publishes after the rewrite; the existing
   second-thoughts tail then judges the FINAL turn state (the
   rewrite when it exists) - which falls out of the machinery
   rather than needing new sequencing.

Gated by a settings checkbox (`clearWritingEnabled`, AI pane, OFF by
default). OFF = byte-for-byte today's behavior. The brainstorm entry
is NEW (B8): unlike B1-B6 this adds a stage that does not exist
today; its justification is Jeff's standing standard (the
clear-writing skill) plus the observation that the fleet's prose
surfaces (chat replies, wiki articles) have no clarity feedback loop
anywhere.

## BACKGROUND

The streaming machinery (mapped line-by-line this session, then
verified by two lenses):

- **Round loop** (`getStreamingResponse.ts:605`, MAX_ROUNDS 24 at
  `:115`): one completion per round; the terminal round (no tool
  calls) breaks at `:892-895` BEFORE the history push (the terminal
  round's text is never pushed to `history` - `:1097-1121` is the
  tool-round tail). The `finally` (`:1289+`) sequence: wallTimer
  cleared `:1290` -> flush `:1293` -> aborted-regen rollback
  `:1327-1374` (deletes `runRowIds` + the streaming row) ->
  splitLeakedThink `:1380` -> terminal commit `:1402-1491` (the
  `commit_assistant_message` RPC `:1409-1427`) -> empty-row sweep
  `:1501-1514` (keepId = assistantRowId) -> heartbeat clear
  `:1523-1532` -> last_error `:1544` -> END publish `:1570-1585` ->
  dispose `:1587` -> tails (second-thoughts `:1613-1635`, curation,
  samskara).
- **One-row-per-turn invariant**: the streaming row
  (`ensureAssistantRow :486-507`, INSERT without position -> the
  trigger assigns tail, `schema.sql:798-816`) IS the terminal row;
  `commit_assistant_message` (`schema.sql:13897-14093`) flips it
  `status='complete'`, with a `status='streaming'` lookup that
  doubles as an idempotency guard (`:13919-13936` - a re-commit of
  a complete row returns `conflict: row_not_streaming`, which the
  orchestrator maps to `terminalKind='error'` at `:1440-1455`), a
  newer-user-message conflict check (`:13992-14001`), and - on edit
  turns only - the anchor-delete + replacement-user-row insert
  (`:14026-14037`, `:14059-14064`). Every second assistant row in a
  turn today carries tool_calls; a second non-tool assistant row is
  a shape no existing path produces.
- **Events**: `OrchestratorEvent` in the SHARED
  `_shared/venice-stream.ts` (`:207-286`; both toolchains import
  the same file - the edge relative, the browser via the `$shared`
  Vite alias). The browser resets its live bubble on
  `assistant_round_committed` / guard_retry / stream_retry
  (`stream-events.ts:236-292`) and accumulates `response_text` into
  one live bubble otherwise (`:139-152`). Realtime: message INSERT
  echoes are skipped for `status='streaming'` rows
  (`Chat.svelte:2054`); UPDATE echoes merge through
  `Chat.svelte:1810-1825` (only known fields - attachments,
  second_thoughts - survive the merge; unknown jsonb fields are
  DISCARDED) with a 20s backfill fallback (`:1849-1871`).
- **Second thoughts** (`:1613-1635`): fires on `persistedId`
  (`:1385`) when `terminalKind === 'completed'`. Its input contract
  is the TURN SLICE (`loadTurnContext`, `second_thoughts.ts:182+`):
  every row from the user message to the terminal row.
- **The deferred sibling** (archaeology): second-thoughts' own doc
  (`second-thoughts.md:495-503`) designed and DEFERRED automatic
  correction - "a strong-enough verdict triggers the refinement
  WITHOUT a click... would move the reviewer onto the critical path
  and hook the round loop's terminal-round break - a big, delicate
  change. Gated on data: whether the user routinely clicks... this
  is never built."
- **Settings**: the AI-pane checkbox pattern
  (`Settings.svelte:1925-1994`, the optimistic handler `:1422-1429`);
  the round-trip: the scrub whitelist
  (`src/lib/supabase/settings.ts:122-317`, booleans `:235-241`) AND
  `coerceSettings` (`types/settings.ts:286-404`, booleans
  `:345-365`); app-state setters/hydrate
  (`app-state/settings.ts:85-89, 298-315, 507-515`). The write-side
  scrub has NO test coverage today (only the coercer leg is pinned).
  Function-side per-user reads: `applyIntentPriming`
  (`priming.ts:179-196`) is the precedent.
- **System prompt**: the chat baseline = static module-level blocks
  joined in `buildSystemPrompt` (`system-prompt.ts:499-522`); the
  edge function builds NO system prompt (the browser shapes it,
  `getStreamingResponse.ts:276-279`). `buildSystemPrompt`'s doc
  pins cache doctrine: the baseline is unvarying per turn; rare
  user-driven changes are the accepted cache-bust class
  (`:489-497`). A settings-gated STATIC block changes the prompt
  only on toggle - the pre-approved class. The metadata-tail slot
  (`prompt-assembly.ts:427-458, 450-457`) exists for per-turn-VOLATILE
  content (the tail is where non-cacheable content lives - a
  settings-gated posture block is not that). The wiki-family agents
  assemble function-side, each independently
  (`agents/wiki.ts:456-503`, `wiki_manual.ts:260-272`,
  `wiki_records.ts:327`, `wiki_recall.ts:64`, the librarian inline).
- **Cross-toolchain sharing**: pure modules SINGLE-SOURCE through
  the `$shared` alias (`vite.config.ts:51-59` puts
  `supabase/functions/_shared` on the browser's import path;
  `venice-stream.ts` is the living precedent - one file, both
  toolchains). The "deliberate duplicate" pattern is specific to
  the VENICE wire module (its barrel comment scopes it there).
- **Decision API**: the `score` type (ordered rubric,
  probability-weighted between levels + confidence) and batching
  (state counted once) from the parent plan's calibration; the
  shared coercers/timeout/cap from `_decision_state.ts`; the thin
  relay. `veniceDecision` is fetch-injectable
  (`_shared/venice/decisions.ts:31,45`); `toolComplete` is NOT (the
  test seam for a full-flow harness is the globalThis.fetch
  URL-routing stub, `tests/image-op-tools.test.ts:151-176`).

The writing standard: the thatch-clear-writing skill - hard rules
plus per-sentence tests, written in trigger-naming form. Two
load-bearing memory lessons shape the encoding: (1) the priming
hazard - never name the anti-behavior in instructions, even to
forbid it (positive phrasing only, guard by omission); (2) abstract
category distinctions fail at trigger time - rules must name the
trigger the model sees in the moment. The skill's rules are already
trigger-shaped, which makes the distillation mechanical. (The
existing VOICE_BLOCK names anti-behaviors in negative imperatives -
it predates the priming-hazard rule and is grandfathered; the NEW
block does not copy that shape.)

## DECISIONS (proposed - refinement may amend)

- **D1 - Model: `clef-api` via `DECISION_MODEL`** (the tier
  constant); alias `CLARITY_JUDGE_MODEL = DECISION_MODEL` in
  `agent-models.ts` (the greppable-log precedent).
- **D2 - ONE batched call, TWO questions.** `primarily-text` (noul):
  is the response prose rather than code/structured output? The
  criteria name the exemptions (code blocks, tables, lists, ASCII
  art, structured data) and the judgment (prose AROUND code still
  counts as prose). `clarity` (score): the 4-level rubric - 1 =
  riddled with faults; 2 = multiple clear violations; 3 = minor
  violations, reads fine; 4 = clean per the standard. The criteria
  carry the standard's fault catalog in NEGATIVE form (the fault
  classes to detect) - the priming-hazard split: the system prompt
  teaches the positive behavior, the judge detects the negative
  one; the model never sees the anti-behaviors phrased as
  instructions it could absorb.
- **D3 - The rewrite trigger**: `primarily-text` p >= 0.5 AND
  clarity score < 2.5 (between "multiple violations" and "minor" -
  named constant `REWRITE_SCORE_THRESHOLD`). The mechanical scan
  cannot trigger a rewrite by itself; its findings ride the rewrite
  prompt as evidence. The decision call runs on every
  clarity-enabled turn with a non-empty response; the deterministic
  scan runs first and its result rides along.
- **D4 - The seam: between the existing commit block and the
  empty-row sweep; the stage owns ONLY the rewrite.** The existing
  terminal commit block (`:1402-1491`) runs FIRST and commits the
  ORIGINAL exactly as today (its content from `accum`, all its
  guards intact - unchanged code). THEN the clarity stage runs at
  the pinned slot (after the commit block, before the empty-row
  sweep): gate -> mechanical scan -> the two-question call ->
  chip -> rewrite -> commit -> reassign. This ordering is forced:
  the stage's rewrite commit must land BETWEEN the original's
  commit and the sweep/END, and the existing commit block must be
  the ONLY writer of the original (running the stage before it
  would double-commit the reassigned rewrite row into the
  idempotency guard and error-terminal a successful turn). The
  empty-row sweep's keepId reads `assistantRowId`; END's
  `persistedAssistantId` and the second-thoughts target read
  `persistedId` - a SNAPSHOT taken before the commit block
  (`:1385`, `let persistedId = assistantRowId ?? ''`), not a live
  read - so the stage reassigns BOTH variables ONLY after the
  rewrite's commit succeeds, and reverts both to the original's id
  on
  any failure (a failed reassign-then-commit would otherwise leave
  END naming a dead row: the browser's END hydration 404s and the
  samskara substrate stub pairs to nothing).
- **D5 - The rewrite: ONE streamed completion, a new assistant row,
  the original untouched.** The rewrite row INSERTs (status
  'streaming', no position -> the tail trigger) and streams via a
  PARAMETERIZED twin of the row-update machinery
  (`ensureAssistantRow`/`scheduleRowUpdate`/`flushRowUpdate` are
  closures hard-wired to the single `assistantRowId`/`accum` - a
  second row cannot reuse them; the twin takes an explicit row-id
  and buffer target, keeping the debounce + the reconnecting-client
  visibility the heartbeat comment documents). The rewrite
  completion is a "switch modes" completion: the same system prompt
  it inherits + a final user turn carrying the original response
  (fenced, the second-thoughts serializer pattern - data, not
  directives), the standard's positive block, the mechanical
  findings, the score. Contract: the same facts, the same language,
  code blocks untouched; nothing added. Thinking off (a focused
  rewrite, not a re-think). Its OWN usage event feeds its commit's
  `p_usage` (the original's tokens must not land on the rewrite
  row). The rewrite commits via `commit_assistant_message` with
  `p_replace_user_message_content = null` and
  `p_superseded_ids = null` (a destructive-edit turn's anchor row
  was already replaced by the original's commit - re-passing them
  would insert a second replacement or fail the anchor lookup); on
  edit turns the stage is SKIPPED entirely (the replace machinery
  makes the two-commit shape ambiguous). ONE rewrite max, no
  re-check of the rewrite.
- **D6 - The notice: NO new event type - the chip rides the
  second-thoughts UPDATE-echo pattern.** The stage inserts the
  rewrite row FIRST (minting its id), then writes a `clarity` jsonb
  onto the ORIGINAL row:
  `{v:1, score, notice: <assistant-voiced copy>, rewrite_id}` -
  then the rewrite streams. The messages UPDATE echo delivers the
  chip live (the same path the second-thoughts verdict rides,
  `getStreamingResponse.ts:1616-1618`);
  Chat.svelte's realtime merge learns the field (`:1810-1825`) and
  the 20s backfill covers a dropped echo (`:1849-1871`; its
  early-return guard becomes either-field-missing so one delivered
  field cannot suppress the other's fetch). The browser renders the
  notice between the original and the live rewrite bubble from the
  chip. The buffer reset: the terminal path NEVER publishes
  `assistant_round_committed` today (the sole publish, :927, is
  tool-round-only; venice-stream.ts:221-222 - "the terminal round
  is signaled by END instead"), so the stage publishes it for the
  ORIGINAL's row before streaming the rewrite - the existing
  browser handler then settles the original's card, resets the
  live buffer, and schedules the chip backfill (`:4977-4981`), and
  the rewrite's deltas start a fresh bubble. No new event type, no
  fan-out, no replay gap; the chip is reload-stable by
  construction (`thread_transcript` returns `m.*`). Chip-write
  failure: PROCEED with the rewrite (the chip is cosmetic; the
  rewrite is the feature) + a log line - the connective's absence
  is the recorded consecutive-answers hazard, accepted at this
  rarity.
- **D7 - The mechanical scan** (model-free, runs first): the
  added-line slop-grep technique turned inward - typographic
  dashes/quotes, sycophancy openers, hedge softeners, filler
  markers - over the response text (code blocks excluded). Findings
  ride the rewrite prompt; the scan alone never triggers anything.
- **D8 - The baseline block: static, adjacent to VOICE,
  settings-gated via a `buildSystemPrompt` parameter.** A toggled
  static block busts the prompt cache only on toggle - the rare,
  user-driven class `buildSystemPrompt`'s docstring pre-approves
  (`:489-497`) - and a posture block reads better BEFORE the
  conversation than from the weak-read tail. The docstring's
  "the one per-user variable is mcpToolboxes" comment gains the
  block as the second. The block's phrasing: positive only (the
  priming-hazard rule), trigger-naming ("when you answer, your
  first sentence is the answer; one idea per sentence; say what
  the thing does before naming it"), and its comment states the
  evidence basis honestly (the standard + no recorded
  observed-failure incident - the block family's convention is a
  dated failure; this one ships on standard-plus-absence). The
  wiki-family prompts embed the same block (the edge-side import
  of the shared module).
- **D9 - The shared clarity module: single-sourced via `$shared`.**
  `supabase/functions/_shared/clarity.ts` holds: the positive block,
  the fault catalog (D2's criteria source), the mechanical scan
  (D7), the rubric definitions. The browser imports it through the
  existing alias (the `venice-stream.ts` precedent); the edge
  imports it by relative path. NO duplicate twin - the
  "deliberate duplicate" pattern is scoped to the Venice wire
  module, not pure shared logic.
- **D10 - The setting**: `clearWritingEnabled` (boolean, default
  FALSE) - the scrub whitelist, `coerceSettings`, the AI-pane
  checkbox row, the app-state round-trip, and the edge read (the
  `applyIntentPriming` precedent: one adminClient read at turn
  start, hard no-op when off). The setting gates BOTH layers (the
  block and the stage); OFF = byte-for-byte today's behavior.
- **D11 - Failure paths, each owned by the stage.** The stage's own
  try/catch owns its row: a rewrite failure (timeout, cancel,
  error, conflict) DELETES the rewrite row (a direct delete - the
  aborted-regen rollback runs EARLIER in the finally and cannot
  cover a later-created row; if the delete itself fails, the row
  gets `transitionRowTo('error')` so the janitor's story stays
  legible), CLEARS the chip (a reload-stable notice promising a
  rewrite whose id is dead is worse than no notice - a second
  UPDATE re-marks the original chip-less), reverts
  `assistantRowId`/`persistedId`
  to the original's id, and the turn stands `'completed'` on the
  original. Guards: `REWRITE_TIMEOUT_MS = 30_000`
  (AbortSignal.timeout - a stalled rewrite would otherwise hang the
  turn while the heartbeat reads it live); a cancel mid-rewrite
  fail-opens to `'completed'` (the reply the user saw already
  landed; the cancel stopped only the cleanup - the aborted-marker
  mapping is unimplementable here and dropped: the original is
  already committed, there is nothing to mark); a rewrite-commit
  conflict (a competing send) = delete + `'completed'`; an EMPTY
  rewrite (the GLM stall case) = delete + `'completed'` (the
  round-loop's empty guard does not cover the stage). The stage
  runs only when `terminalKind === 'completed'` (the sweep's guard
  at `:1502` is the precedent). The wall
  budget: the stage SKIPS when the turn's elapsed time leaves less
  than ~45s before the hosted wall clock (the 380s timer cleared at
  `:1290` does not cover the stage; the runtime kill is absolute) -
  one elapsed-time check, fail-open. The decision call carries the
  shared 10s timeout; its failure = no rewrite. (The OBSERVER call
  itself remains untimed - pre-existing, unchanged by this plan.)
- **D12 - Second thoughts + the two-answer slice.** ZERO code
  changes to the tail: `persistedId` targeting (D4) delivers the
  ordering. The reviewer's input contract is the TURN SLICE - with
  a rewrite it contains BOTH answers as bare rows (the reviewer's
  slice carries no chip and no connective); the serializer handles
  multi-row slices, and "the most recent response" (its framing)
  reads the rewrite. The slice-shape change is stated here and in
  second-thoughts.md's input contract. With the setting off,
  today's behavior.
- **D13 - The history connective: assembled at replay time, not
  written to rows.** Two consecutive assistant messages with no
  connective is a recorded hazard (`prompt-assembly.ts:728-730`:
  "the model sees two consecutive answers with no 'why' and can
  waffle over which is authoritative"). The history assembly
  (buildHistoryOnWire / toVeniceMessage) gains the
  `buildRefinementThink` precedent's move (`:734-737`): when a row
  carries the clarity chip, the NEXT turn's model sees a think-line
  connective ("that reply was reworded below for clarity") between
  the two. The rows stay honest; every future turn understands the
  shape; both rows' tokens stay in context (accepted - the
  alternative, hiding the original, contradicts the feature's
  intent).

## PLAN

1. **`supabase/functions/_shared/clarity.ts`** (D9): the positive
   block, the fault catalog, the mechanical scan (D7, code-block
   exempt), the rubric definitions, the trigger constants.
2. **`getStreamingResponse.ts`**: the pinned seam (D4) - the stage
   between the commit block and the empty-row sweep; the
   parameterized row-update twin (D5); the chip write (D6); the
   failure paths (D11); the settings read at turn start (D10); the
   elapsed-time wall check (D11). `roundsRun` untouched.
3. **The schema + types**: the `clarity jsonb` column migration
   (`alter table messages add column if not exists clarity jsonb`,
   the `second_thoughts` precedent at `schema.sql:1130`); the
   browser `Message` type field (`types/chat.ts`); the
   realtime-merge clause + backfill coverage (`Chat.svelte:1810-1871`).
4. **The rendering**: the notice between the messages + the chip on
   the original (extracted modules: a `coerceClarity` coercer +
   the notice copy in the shared clarity module - tested, never
   inline in Chat.svelte).
5. **The prompt block**: `buildSystemPrompt`'s new parameter + the
   docstring update; the wiki-family prompt assemblies embed the
   shared block.
6. **Settings**: the key through the scrub whitelist + the coercer +
   the AI-pane checkbox + the app-state round-trip.
7. **Tests**: the mechanical scan (the fault catalog + the
   code-block exemption); the two-question body (model alias, state
   shape, the rubric criteria); the coercion + trigger table (both
   fail tiers); the trim case; the rewrite sequencing through the
   `OrchestratorOpts.complete` harness (the two commits, the
   reassign + revert, `END.persistedAssistantId` asserted - zero
   coverage of that field exists today); the failure paths
   (timeout/cancel/conflict/empty -> original stands, 'completed',
   the chip cleared); the edit-turn skip; the wall-budget skip; the
   settings round-trip legs (the scrub whitelist test - the write
   side has none today - + the coercer + the hydrate); the
   positive-phrasing lint pin on the NEW block only (VOICE_BLOCK's
   grandfathered imperatives are not the template); the
   realtime-merge test for the clarity field; the backfill's
   either-field guard; the transport-translation test for any
   published `assistant_round_committed` on the terminal path (the
   existing shapes: venice.test.ts's broadcast-translation tests).
8. **Docs + QA**: the QA use case (new file: the clarity arms);
   `docs/dev/` feature doc; the settings doc's AI-tab row; the
   parent plan gains B8 (implemented + pointer);
   `docs/dev/second-thoughts.md`'s input contract gains the
   two-answer slice note (D12).
9. **Gate, self-review, QA, land.** The standard loop.

## RISKS

- **The rewrite changes meaning** (a clarity rewrite that drops a
  fact or flips a hedge is a correctness regression wearing a
  style fix). Mitigations: the rewrite prompt's contract (same
  facts, same language, nothing added); ONE rewrite, no cascade;
  the original stays on the record; the score threshold keeps most
  turns un-rewritten.
- **The deferred-sibling tension** (second-thoughts.md:495-503
  deferred verdict-triggered auto-correction as "big, delicate"
  and gated it on click-through data): B8 ships the sibling shape
  with the deferral's own answer - OFF by default IS the demand
  probe; the original commits before any rewrite (append-only, the
  bounded version of the feared critical-path move); the judge is
  a written standard, not an open doubt. If the rewrite proves
  worse than the original in practice, the toggle dies and the
  deferral's caution is vindicated - the rollback is the setting.
- **The extra tail latency on every clarity-enabled turn** (the
  decision call ~sub-second + the rewrite when triggered). The
  chip-notice copy softens the seam; OFF default while it proves
  itself.
- **The rubric's calibration** (the 2.5 threshold is a guess until
  the scores accumulate) - the score + trigger decisions log (the
  B4/B5 pattern), making the threshold's tuning data visible.
- **The two-answer context cost** (both rows' tokens ride every
  future turn) - accepted in D13; the alternative contradicts the
  feature's intent.
- **Prompt-bloat on the chat baseline** - bounded to a short
  positive block; the toggle-gated cache bust is the docstring's
  pre-approved class.

## VERIFICATION

- Unit: the extended suites (`mise run check`).
- **Live QA (shared-stack protocol, fixtures prefixed `ZZQA-B8`;**
  stack serves functions only from `~/dev/nak` - the branch dance;
  the toggle ON for the dev profile):
  1. **Clean-response arm**: a turn whose response is clean prose.
     Assert: the decision call logged (both questions); NO notice,
     NO rewrite; the turn ends on the original; second-thoughts
     fires on it as today.
  2. **Sloppy-response arm**: bait a sloppy response (a prompt
     eliciting a hedge-heavy answer; if the judge passes it, the
     arm logs the score and documents the miss - the score data is
     the calibration). Assert when it fires: the chip lands on the
     original (UPDATE echo), the notice renders between the
     messages, the rewrite streams as a second assistant message,
     the original stays, END after the rewrite, second-thoughts
     fires on the rewrite's row id, the next turn's history shows
     the connective.
  3. **Code-response arm**: a turn whose response is a code block.
     Assert: `primarily-text` reads false; no rewrite regardless of
     the prose score.
  4. **Off arm**: the toggle off. Assert: no decision call; today's
     behavior byte-for-byte; second-thoughts unchanged.
  5. **Failure arm**: the judge unreachable (no Venice key or a
     forced failure). Assert: the turn ends on the original, the
     fail-open info line in the drawer.
  The executed row lands in the QA doc's Results log.
