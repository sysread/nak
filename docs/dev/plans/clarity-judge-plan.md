# Clarity Judge + Auto-Rewrite (B8)

Status: PLAN (refinement in progress - not yet built).

## SYNOPSIS

Three layers, all riding the existing chat machinery:

1. **The baseline**: a positive-phrased clarity block in the chat's
   system prompt (and the wiki-family prompts) - the model writes
   clean from the start, so the verifier rarely fires.
2. **The judge**: after the terminal round's response completes, ONE
   batched `clef-api` decision call asks TWO questions about the
   response: `primarily-text` (noul - is this response prose rather
   than code or structured output?) and `clarity` (score, 1-4
   rubric: riddled -> clean). A deterministic mechanical scan (the
   dash/quote/filler checks) runs alongside, model-free.
3. **The reframe**: a low score on a text response triggers ONE
   streamed rewrite - a NEW assistant message after the original
   (nothing is hidden or edited), introduced by a notice the user
   sees in the turn. The turn's END waits for the rewrite; the
   existing second-thoughts tail then judges the FINAL message (the
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

The streaming machinery (mapped line-by-line this session):

- **Round loop** (`getStreamingResponse.ts:605`, MAX_ROUNDS 24 at
  `:115`): one completion per round; the terminal round (no tool
  calls) breaks at `:892-895` BEFORE the history push. The
  terminal write lives in the `finally` (`:1289+`): wallTimer
  cleared `:1290` -> flush `:1293` -> aborted-regen rollback
  `:1327-1374` -> splitLeakedThink `:1380` -> terminal commit
  `:1402-1491` -> empty-row sweep `:1501-1514` -> heartbeat clear
  `:1523-1532` -> last_error `:1544` -> END publish `:1570-1585` ->
  dispose `:1587` -> tails (second-thoughts `:1613-1635`, curation,
  samskara). Structurally nothing prevents one more completion
  between the loop exit and the terminal write: `history` (`:539`),
  `body` (`:538`), `accum` (`:431-436`), `publisher` (`:380`,
  disposed only `:1587`), the heartbeat (cleared `:1523`, i.e.
  ALIVE during any pre-terminal-write stage), the control channel
  (live until `:1594`), and `runRowIds` (`:391`) are all still in
  scope.
- **One-row-per-turn invariant**: the streaming row
  (`ensureAssistantRow :486-507`, INSERT without position -> the
  trigger assigns tail, `schema.sql:798-816`) IS the terminal row;
  the terminal commit (`commit_assistant_message :1409-1427`,
  `schema.sql:13897-14093`) flips that row `status='complete'`.
  Every second assistant row in a turn today carries tool_calls.
  The rewrite = a shape no existing path produces: a second
  NON-tool assistant row.
- **Events**: `OrchestratorEvent` in the SHARED
  `_shared/venice-stream.ts` (`:207-286`; both sides import the
  same file - edge relative, browser via the Vite alias). Adding an
  event type touches: the wire union, a broadcast handler in
  `stream-transport.ts:404-583`, the browser union
  `src/lib/venice.ts:386-493`, a case in `stream-events.ts:148-347`,
  and optionally `ChatLoopHandlers`. Stream-only events have NO
  reconnect replay (the accepted gap the priming events already
  carry).
- **Second thoughts** (`:1613-1635`): fires on `persistedId`
  (`:1385`, initialized from `assistantRowId`) when
  `terminalKind === 'completed'` - so if the stage reassigns
  `persistedId` to the rewrite row, the tail judges the rewrite
  with ZERO sequencing code.
- **Settings**: the AI-pane checkbox pattern
  (`Settings.svelte:1925-1994`), the optimistic-toggle handler
  (`:1422-1429`), and the round-trip: a new boolean key must land
  in the scrub whitelist (`src/lib/supabase/settings.ts:122-317`,
  the boolean pattern `:235-241`) AND `coerceSettings`
  (`src/lib/supabase/types/settings.ts:286-404`, booleans
  `:345-365`) - the server-side merge RPC whitelists nothing.
  Function-side per-user reads: `applyIntentPriming`
  (`priming.ts:179-196`) is the precedent (read
  `profiles.settings.intentsEnabled` via adminClient, hard no-op
  when off).
- **System prompt**: the chat baseline = static module-level blocks
  joined in `buildSystemPrompt` (`system-prompt.ts:499-522`); the
  edge function builds NO system prompt (the browser shapes it;
  `getStreamingResponse.ts:276-279`). A settings-gated per-turn
  instruction has a tail-pinned precedent:
  `emphasisMarkdown` (`prompt-assembly.ts:514-532`). The wiki-family
  agents assemble function-side, each independently
  (`agents/wiki.ts:456-503`, `wiki_manual.ts:260-272`,
  `wiki_records.ts:327`, `wiki_recall.ts:64`, the librarian inline).
- **Decision API**: the `score` question type (ordered rubric,
  probability-weighted score between levels + confidence) and the
  batching economics (state counted once) from the parent plan's
  calibration; the shared coercers/timeout/cap from
  `_decision_state.ts`; the thin-relay discipline.

The writing standard: the thatch-clear-writing skill - 19 hard rules
plus per-sentence tests, written in trigger-naming form. Two
load-bearing memory lessons shape the encoding: (1) the priming
hazard - never name the anti-behavior in instructions, even to
forbid it (positive phrasing only, guard by omission); (2) abstract
category distinctions fail at trigger time - rules must name the
trigger the model sees in the moment. The skill's rules are already
trigger-shaped, which makes the distillation mechanical.

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
  teaches the positive behavior, the verifier detects the negative
  one; the model never sees the anti-behaviors phrased as
  instructions it could absorb.
- **D3 - The rewrite trigger**: `primarily-text` p >= 0.5 AND
  clarity score < 2.5 (between "multiple violations" and "minor" -
  named constant `REWRITE_SCORE_THRESHOLD`). The mechanical scan
  cannot trigger a rewrite by itself; its findings ride the rewrite
  prompt as evidence. The decision call runs on every
  clarity-enabled turn with a non-empty response; the deterministic
  scan runs first and its result rides along.
- **D4 - The rewrite: ONE streamed completion, a new assistant row,
  the original untouched.** Sequence in the `finally`, before the
  terminal write: (1) the ORIGINAL streaming row is committed
  exactly as today (its content verbatim - the user keeps reading
  it); (2) the notice publishes (D5); (3) the rewrite completion
  streams (a NEW assistant row inserted on first delta - same
  ensureRow pattern, tail position via the trigger, registered in
  `runRowIds` for the aborted-regen rollback), prompted with: the
  same system prompt it inherits + a "switch modes" user turn
  carrying the original response + the standard's positive block +
  the mechanical findings + the score, asking for the same content
  rewritten for clarity - same facts, same language, code blocks
  untouched; (4) the rewrite row commits via the same
  `commit_assistant_message` RPC; (5) `assistantRowId`/`persistedId`
  reassign to the rewrite's id - the terminal write's remaining
  machinery (empty-row sweep keepId, END's persistedId,
  second-thoughts target) follows automatically; (6) the ORIGINAL
  row is already `status='complete'` from step 1, so the janitor
  never sees it as crashed. ONE rewrite max, no re-check of the
  rewrite.
- **D5 - The notice**: a new `clarity_notice` event type (the
  5-file fan-out; NO reconnect replay - accepted, same gap as the
  priming events) AND a persisted marker on the ORIGINAL row: a
  `clarity` jsonb `{v:1, score, rewrite_id}` (the second-thoughts
  pattern - a reload-stable chip on the original message: "rewritten
  for clarity below"). The live notice's copy is assistant-voiced,
  first person: "that was wordier than it needed to be - let me try
  that again" class; exact copy at build time.
- **D6 - The mechanical scan** (model-free, runs first): the
  added-line slop-grep technique turned inward - typographic
  dashes/quotes, sycophancy openers, hedge softeners, filler
  markers - over the response text (code blocks excluded). Findings
  ride the rewrite prompt; the scan alone never triggers anything.
- **D7 - The baseline block**: a positive-phrased clarity block
  (module const) in the chat's `buildSystemPrompt` (adjacent to
  VOICE) and in the wiki-family prompts. Cross-toolchain home: the
  browser and edge toolchains deliberately do not share source (the
  barrel precedent), so the block is DUPLICATED with a sync-by-intent
  cross-reference. The phrasing names the trigger in the moment
  ("when you answer, your first sentence is the answer; one idea per
  sentence; say what the thing does before naming it") and NEVER
  names the anti-behaviors (the priming-hazard rule).
- **D8 - The setting**: `clearWritingEnabled` (boolean, default
  FALSE) - the scrub whitelist, `coerceSettings`, the AI-pane
  checkbox row, and the edge read (the `applyIntentPriming`
  precedent: one adminClient read at turn start, hard no-op when
  off). OFF = the stage never runs and the baseline block still
  ships? NO - the baseline block is part of the feature: the
  setting gates BOTH layers (the block is appended only when the
  toggle is on; the profile's own toggle controls its prompt).
- **D9 - Failure paths**: the rewrite completion is guarded by
  `REWRITE_TIMEOUT_MS = 30_000` (AbortSignal.timeout - a stalled
  rewrite would otherwise hang the turn silently; the heartbeat is
  alive during the stage, so a hang reads as live-but-silent). On
  timeout/abort-by-cancel/error: the rewrite row is deleted (it is
  in `runRowIds` - the rollback path handles it), the original
  stands as the committed terminal row, `terminalKind` maps a user
  cancel to `'aborted'` + `withInterruptedMarker`, and a timeout
  keeps `'completed'` (fail-open: the original was already fine
  enough to publish). The decision call carries the shared 10s
  timeout; its failure = no rewrite (the turn ends on the
  original).
- **D10 - Second thoughts**: ZERO code changes - the tail's
  `persistedId` targeting (D4 step 5) delivers the ordering (the
  verdict lands on the rewrite when a rewrite exists, on the
  original otherwise, never on both). With the setting off, today's
  behavior. The interaction the user asked about resolves by
  construction.

## PLAN

1. **Shared clarity module** (browser + edge duplicates): the
   positive block (D7) + the fault catalog (D2's criteria source) +
   the mechanical scan (D6) + the rubric definitions. Home:
   `src/lib/chat/clarity.ts` (browser) + the edge twin in
   `supabase/functions/venice/agents/_clarity.ts`, cross-referenced.
2. **`getStreamingResponse.ts`**: the stage in the `finally` before
   the terminal write (D4's sequence; D9's guards); the settings
   read at turn start (D8); the notice event publish (D5). `roundsRun`
   untouched.
3. **The event fan-out**: `clarity_notice` through the shared union,
   the browser transport handler, the browser union, the events
   switch, and a Chat.svelte notice rendering between the two
   messages.
4. **The original-row chip**: the `clarity` jsonb write (D5) + the
   renderer (a small chip/label on the rewritten-over message).
5. **Settings**: the key through the whitelist + coercer + the
   AI-pane checkbox + the app-state round-trip (the emphasisMarkdown
   precedent shape).
6. **The wiki-family baseline**: the block into the wiki agents'
   prompt assemblies (the edge duplicate; no verifier for wiki - a
   wiki-article clarity judge is a future question, not this plan).
7. **Tests**: the mechanical scan (the fault catalog + code-block
   exemption); the two-question body (model alias, state shape, the
   rubric criteria); the coercion + trigger table (both questions'
   fail tiers); the trim case; the rewrite sequencing (the two
   commits, the reassign, the runRowIds registration) via the
   `OrchestratorOpts.complete` harness seam (`tests/orchestrator.test.ts`
   precedent); the failure paths (timeout -> original stands;
   cancel -> aborted marker); the settings round-trip; the prompt
   block's presence + positive-phrasing scan (no anti-behavior
   wording - a lint-style pin: the block must not contain the
   banned phrasings).
8. **Docs + QA**: the QA use case (new file: the clarity arms);
   `docs/dev/` feature doc for the stage; the settings doc's AI-tab
   row; the parent plan gains B8 (implemented + pointer).
9. **Gate, self-review, QA, land.** The standard loop.

## RISKS

- **The rewrite changes meaning** (a clarity rewrite that drops a
  fact or flips a hedge is a correctness regression wearing a
  style fix). Mitigations: the rewrite prompt's contract (same
  facts, same language, nothing added); ONE rewrite, no cascade;
  the original stays on the record (the user can read both); the
  score threshold keeps most turns un-rewritten.
- **The extra tail latency on every clarity-enabled turn** (the
  decision call ~sub-second + the rewrite when triggered). The
  notice copy softens the seam; the setting is the user's
  off-switch; OFF default while it proves itself.
- **The notice event's replay gap** (a reconnecting client misses
  the live notice) - the persisted chip on the original row covers
  the reload case.
- **The rubric's calibration** (the 2.5 threshold is a guess until
  the scores accumulate) - the score + trigger decisions log (the
  B4/B5 pattern), making the threshold's tuning data visible.
- **Prompt-bloat on the chat baseline** (the block rides every
  turn) - bounded to a short positive block; the per-turn metadata
  slot (prompt-cache stable) is available if it must move.
- **The one-row-per-turn invariant bends** (a second non-tool
  assistant row) - the plan's step 1 sequence handles each hazard
  the map names (the first commit, the runRowIds registration, the
  janitor's view); the orchestrator tests pin the shape.

## VERIFICATION

- Unit: the extended suites (`mise run check`).
- **Live QA (shared-stack protocol, fixtures prefixed `ZZQA-B8`;**
  stack serves functions only from `~/dev/nak` - the branch dance;
  the toggle ON for the dev profile):
  1. **Clean-response arm**: a turn whose response is clean prose.
     Assert: the decision call logged (both questions); NO notice,
     NO rewrite; the turn ends on the original; second-thoughts
     fires on it as today.
  2. **Sloppy-response arm**: force a sloppy response (a user
     prompt baiting slop, or... the honest lever: the toggle +
     a prompt that elicits a hedge-heavy answer; if the observer
     passes it, the arm logs the score and the arm documents the
     miss). Assert when it fires: the notice renders between the
     messages; the rewrite streams as a second assistant message;
     the original stays; the chip renders on the original; the
     decision call logged (score < threshold); END after the
     rewrite; second-thoughts fires on the REWRITE's row id.
  3. **Code-response arm**: a turn whose response is a code block.
     Assert: `primarily-text` reads false; no rewrite regardless of
     the prose score.
  4. **Off arm**: the toggle off. Assert: no decision call; today's
     behavior byte-for-byte; second-thoughts unchanged.
  5. **Failure arm**: the verifier unreachable (no Venice key or a
     forced failure). Assert: the turn ends on the original, the
     fail-open info line in the drawer.
  The executed row lands in the QA doc's Results log.
