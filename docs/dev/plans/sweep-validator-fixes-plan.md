# Sweep Validator Fixes Plan

Status: IMPLEMENTED 2026-11-03 (branch sweep-validator-fixes, head
d48212da + the review-revision commits; base origin/main 5eee96fa;
M4 live-QA row in docs/qa/use-cases/wiki-records.md; review revision
round folded - see the git log for the must/polish commits).

## SYNOPSIS

Three changes, two defects and one rider:

1. **Wiki-record extraction runs can claim false success silently.**
   The extraction sweep stores the agent's self-report verbatim as the
   durable audit row with zero post-run verification. A run that skips
   the record write and then claims "Logged one record" is invisible.
   Fix: verify the self-report against a row-count delta in the sweep's
   done branch, and annotate the stored reasoning when it lies. The
   pointer-advance contract does not change.
2. **Validator/handler error-split on combination tools.** The central
   schema validator and the per-op handler each refuse a malformed call,
   but they do not combine. A compound fumble (invalid `op` + missing
   per-op required fields) reports only the enum problem, costing the
   model one extra round trip before the real error surfaces. Fix: the
   validator accumulates per-op required-field rules declared in the
   schema, so one throw carries the whole set. Rollout limited to combos
   whose per-op required fields are unconditional (see the Rollout
   scope section).
3. **RIDER R1 - retired tool names are back in the extraction agent's
   model-facing prompt.** The upscaler squash `5eee96fa` (this plan's
   base) reverted the M9 retired-name prose sweep inside
   `venice/agents/wiki_records.ts`: the prompt tells the model to "Call
   record_create" / "Call wiki_search" / "call record_list"
   (`wiki_records.ts:282-288`), and the wire-schema descriptions
   reference record_create/record_list (`:194-195`, `:201`, `:205`,
   `:231`, `:244-245`) - but the toolbox registers `wiki` and `records`
   (`:304-316`). A model following its instructions calls tools that do
   not exist in its toolbox and gets "not in toolbox" rejections. This
   is the exact agent-prompt-drift failure class the combo conversion's
   RISKS section warned about, and a plausible repeat-cause of the
   false-success failure class defect 1 watches for. Fix: restore the
   correct combo names in the prompt + wire descriptions + header
   comments of the file, and pin the invariant with a test so the next
   squash-rebase artifact is caught by the gate.

Both fixes change edge-side behavior; the defect-2 diff also touches
browser-side schema files (`src/lib/tools/*.schema.ts`) because the
edge validator reads those schemas off the wire. Neither changes any
user-facing flow; the annotation reaches the in-app log drawer through
the edge-log relay (the audit row's annotated reasoning is read by SQL
health queries, not by the browser - nothing in `src/` reads
`wiki_agent_log`).

## DECISIONS (resolved scope, do not re-litigate)

- **D1 - the pointer-advance contract is not touched.** `markRecordProcessed`
  runs after every non-throwing run, including zero-record runs
  (`supabase/schema.sql:13239-13241`: "even a no-op run that found no
  event advances the pointer so the thread is not re-scanned every
  tick"). Archaeology: the feature and pointer/claim/failure RPCs all
  ship in `15730e70`; the no-op-advance rationale lives in the schema
  comment just cited, and the sibling article-agent pointer
  (`schema.sql:12104`) encodes the same contract. The fix makes false
  self-reports visible; it does not retry, re-run, or hold the queue.
- **D2 - verification is warn-and-annotate, never fail.** A failed
  verification does not change the run's outcome, the summary counters,
  or the pointer. It adds a warn log line and appends a short
  annotation to the reasoning text stored in `wiki_agent_log`. On a
  count-query error (before OR after count), verification is skipped
  for that thread with a debug log - the degrade-on-error precedent is
  `tripwireArmed` (`venice/agents/samskara.ts:1219-1228`).
- **D3 - the claim matcher errs toward the miss direction.** It can
  miss a false claim (mixed sentences, reference-style past tense), and
  some honest no-op phrasings may still be annotated (contracted
  negations, passive voice without a negation token) - but the
  annotation is warn-only and carries both counts, so the audit row
  stays truthful either way. Documented, with the miss cases pinned in
  tests.
- **D4 - per-op rules ride the schema, not a new parameter.**
  `validateToolArgs` reads the rules from an `x-per-op-required` key in
  the schema's `parameters` object (JSON Schema `x-` extension
  convention; no schema in this repo carries an `x-` key today -
  verified by grep; the full-history sweep was not run). Both dispatch
  sites already
  hold that exact object, so chat dispatch and agent dispatch get
  identical behavior with zero plumbing changes. The key rides the wire
  to Venice; the edge validator reads the schema from the wire
  (`getStreamingResponse.ts:231-248`), so stripping the key at
  projection would break the seam - it is not stripped. Venice-side
  tolerance of the unknown key is a VERIFIED-BEFORE-MERGE premise
  (R3 below).
- **D5 - handlers shed nothing.** Every per-op
  required check in the combo handlers is falsy/trim/non-empty -
  strictly stronger than the validator's `undefined`-presence check
  (`records.ts:83,167,270,314-317,377,446`; `recipe_records.ts:97,141,162,260-262,352,400`;
  `image.ts:231,360-361,422,484` - `scale` is optional with default 2,
  `image.ts:421`; `docs.ts:149,207,271,554-559`;
  `followups.ts:247-248`; `recipes.ts:188,192`). The validator's
  per-op accumulation is therefore purely ADDITIVE; handler code
  and handler tests do not move for this fix.
- **D6 - verification reads the database, not the runner.** Alternative
  considered (round 1): verify via the agent's own per-call tool
  outcomes instead of a row count. Rejected: it changes the
  `RunHeadlessAgent` result contract shared by every agent
  (`_run.ts:307-313`), while the count is a two-line read available
  exactly where a per-thread counting column exists. Not foreclosed
  for other sweeps: if reflection or the librarian ever needs
  self-report verification, the runner carrying per-call outcomes is
  the durable shape to revisit.

## DEFECT 1 - wiki-records false-success verification

### Verified mechanism

- `runWikiRecordsSweepTick` claims threads and runs the extraction
  agent (`supabase/functions/venice/agents/wiki_records.ts:513`, run
  dispatched at `:552`).
- The done branch (`wiki_records.ts:565-584`) marks the pointer
  (`markRecordProcessed`, `:445-460`) and writes the agent's reasoning
  verbatim into `wiki_agent_log` via `appendWikiAgentLog`
  (`:573-580`; the writer is best-effort and stores `reasoning`
  unmodified, `agents/_wiki_agent_log.ts:30-53`).
- The prompt instructs the model to end with a one-or-two-sentence
  summary "naming the records you logged ... or the reason you logged
  none" (`wiki_records.ts:298`). Nothing verifies that the summary
  matches the database. Archaeology: `wiki_agent_log` was created
  (`d2d69031`) explicitly for durable traceability, NOT verification -
  no commit in the file's history states any prior intent to verify
  self-reports. Verification is new ground; D2 is a fresh contract.
- The extraction toolbox's write tool is the `records` combo (op=create)
  (`wiki_records.ts:304-316`), which stamps
  `source_conversation_id: ctx.threadId ?? null` on every created row
  (`supabase/functions/venice/tools/records.ts:344`). The sweep's tool
  context carries the claimed `threadId` (`wiki_records.ts:371-375`).
- Concurrent-count caveats (all documented, none fixed - the error
  direction is suppression, i.e. toward NOT annotating): a user's
  chat-driven record on the same thread mid-run inflates the
  after-count; a second sweep tick can re-claim the thread after the
  600s claim TTL expires (`schema.sql:13205-13206`, hourly cron at
  `schema.sql:15615`); a user deleting exactly one thread-tagged record
  mid-run could offset one honest creation. There is no index on
  `source_conversation_id` (`schema.sql:12971-12978` covers other
  columns) - two unindexed head-counts per claimed thread, 3 threads
  per hourly tick; negligible at this app's scale, noted for
  future-self.

### Fix shape

In `runWikiRecordsSweepTick`, per claimed thread:

1. **Before** dispatching the run: `recordsBefore` = count of
   `wiki_records` rows where `source_conversation_id = threadId`
   (head-count select with `count: 'exact'`, the house inline idiom -
   `record_file_attach.ts:113-116`, `samskara.ts:1219-1228`; local
   helper or inline twice, both idiomatic). On a count error: skip
   verification for this thread (debug log), the run proceeds
   unchanged.
2. In the **done branch**, after the existing `markRecordProcessed`:
   `recordsAfter` = same count, same skip-on-error policy as the
   before-count. If the reasoning claims record creation (matcher
   below) and `recordsAfter === recordsBefore`:
   - a warn log naming the thread and both counts, and
   - the annotation appended to the reasoning handed to
     `appendWikiAgentLog` (the `log.info` line carries the same
     annotated text, so the drawer and the audit row agree).

   Annotation text (tests pin the `unverified self-report` substring):

   `[unverified self-report: claimed record creation, but wiki_records
   rows for this thread went from N to N]`

3. The `empty-slice` branch logs nothing and needs no verification
   (there is no reasoning to contradict).

### Claim matcher (D3, documented)

The reasoning is one or two plain sentences per the prompt contract.
The matcher treats the reasoning as claiming a record when BOTH:

- an affirmative logging verb appears BEFORE a record noun within a
  short window in the same sentence:
  `/\b(logged|created|recorded|added)\b\s+(?:\w+\s+){0,3}?\b(records?|events?)\b/i`
  ("Logged one record on Sourdough.", "added a record"), and
- the reasoning contains no negation word anywhere
  (`/\b(no|none|zero|not|never|n't)\b/i`).

The verb-before-noun window excludes reference-style past-tense
sentences ("One record on Sourdough was logged last week") that an
honest no-op run can legitimately produce when summarizing existing
state (round-1 finding S3). The negation guard is deliberately blunt:
it suppresses the annotation on mixed sentences like "Logged one
record; no links added" (a missed detection), and it makes punishing
an honest no-op ("No record-worthy events found", "Logged none")
impossible. "(none)" (the empty-reasoning fallback,
`wiki_records.ts:318-320`) never matches. One-directional failure is
the correct trade for a warning-only annotation.

### RIDER R1 - restore correct tool names in the extraction prompt

Scope: `venice/agents/wiki_records.ts` only. Replace retired names with
the combo forms the toolbox actually registers:

- Prompt steps 2-6 (`:282-290`): "Call wiki_search" -> "Call the wiki
  tool (op=search)", "call wiki_list" -> "the wiki tool (op=list)",
  "call record_list" -> "the records tool (op=list)", "Call
  record_create" -> "Call the records tool (op=create)", "see in
  record_list" -> "see in a records list result", "from record_create"
  -> "from records (op=create)". Keep `record_link_create`,
  `record_file_attach`, `analyze_image`, `memory_search` (real names).
- Wire-schema descriptions (`:194-195`, `:201`, `:205`, `:231`,
  `:244-245`) and section/file-header comments (`:5`, `:9`, `:92-94`,
  `:635-641`): same substitution.
- Pin the invariant: extend `tests/wiki_records.test.ts` with a test
  asserting the prompt and every wire-schema description string name
  only registered tool names (fail on `record_create`, `record_list`,
  `wiki_search`, `wiki_list` as tool references). This is the guard
  the 5eee96fa squash-rebase artifact silently reverted.

## DEFECT 2 - validator/handler error-split on combination tools

### Verified mechanism

- `validateToolArgs` (`supabase/functions/venice/tools/_validate.ts:137-249`)
  runs the flat JSON Schema checks and throws once via `ArgErrors`
  (`:74-99`). The flat combo schema can only mark the discriminator
  required - per-op required fields are not expressible (see the
  schema header comment, `src/lib/tools/records.schema.ts:6-9`) - so
  `missing required parameter` never fires for them from the validator.
- Both dispatch sites validate then execute with no shared per-op
  knowledge: agent dispatch `agents/_run.ts:186-204`
  (`executeToolboxCall`), chat dispatch
  `performToolCall.ts:189-220` (activity stripped, schema from
  `schemaMapFromBodyTools`, `getStreamingResponse.ts:231-248` +
  `:343`, passed through `runOneToolCall` `:1737-1741`).
- The handlers dispatch on `op` and accumulate their own per-op
  required-field errors (`records.ts:497-523` envelope; createOp
  accumulation `:314-323`; updateOp `:375-400`). The image combo throws
  per-op without accumulating (`image.ts:231`, `:360-361`,
  `:422-424`, `:484`).
- The split (verified live on `recipe_records` during the tool-combos
  M4 probes): a call with BOTH an invalid `op` enum value AND a missing
  per-op required field reports ONLY the enum problem. The handler's
  accumulation never runs (the switch cannot route). The model fixes
  the op, resubmits, and then learns about the missing fields - the
  exact one-problem-per-round-trip failure mode `ArgErrors` exists to
  prevent (`docs/dev/tools.md:668-677`, origin `bf9576b3`).
- `validate.test.ts` pins the current flat behavior including the
  null-renders-as-`null` enum message (the 855eb947 fix,
  `validate.test.ts:173` / `_validate.ts:237-245`).
- Archaeology: the combo conversion plan explicitly assigned per-op
  required-field validation to the handlers ("Per-op required-field
  validation moves into ArgErrors; ... every existing error substring
  survives verbatim", `docs/dev/plans/tool-combo-conversion-plan.md`
  TESTING section) - today's error-split is the residue of that
  explicit assignment, not an oversight. This plan moves it back
  behind the validator for the unconditional-field combos.

### Rollout scope (refinement rounds 1-2)

`x-per-op-required` maps an op name to an UNCONDITIONAL list of
required fields. Two scope rules follow:

- **Conditional combos are excluded.** Ops whose requirements are
  conditional (a field required only when another is absent -
  create-or-update shapes) CANNOT take a flat rule; a flat rule for
  them would either reject every legitimate update or green-light
  creates.
- **The map may be partial.** An op ABSENT from the map gets no
  validator per-op checks (the handler keeps its own) - so a combo with
  some unconditional and some conditional ops can include only its
  unconditional ops.

Combos verified per handler (round 2):

- IN, full map: `records` (all six ops unconditional),
  `recipe_records` (all six ops unconditional), `image`
  (generate: prompt; edit: filename + prompt; upscale: filename -
  `scale` is optional with default 2, `image.ts:421`; remove_bg:
  filename).
- IN, partial map: `followups` - `close: ['id', 'resolution']`
  (`followups.ts:247-248`), `dismiss: ['id']` (`:287`); `save` is
  conditional (question required only when id absent, `:195-236`) and
  `list` requires nothing, so both stay OUT of the map.
- EXCLUDED (conditional save/create shapes): `wiki` (save:
  title/content required only when id absent, `wiki.ts:455-464`),
  `recipes` (save path, `recipes.ts:172-192`), `skills` ("required
  when creating", `skills.ts:416-418`), `docs` (save is a
  create/update merge: create requires filename + description,
  update requires title-or-description, `docs.ts:533,554-559`).

Agent-side mirrored wire schemas in scope (each gets the key and a
pin): `RECORDS_WIRE_SCHEMA` in `agents/wiki_records.ts` and
`FOLLOWUPS_WIRE_SCHEMA` in `agents/reflection.ts` (reflection is a
cron sweep - `/reflection-sweep` route, `index.ts:880,1280` - and
drives followups through that mirror; the mirror's omission from
round 1's inventory was a round-2 blocker finding, now corrected).
`image` and `recipe_records` have no agent mirrors (verified by grep
over the agent toolbox compositions). The per-surface pin tests below
catch a future mirror that misses the key.

### Fix shape (D4)

1. **Rules declaration.** Each in-scope combo tool's schema gains an
   `x-per-op-required` key in `parameters`:

   ```js
   parameters: {
     type: 'object',
     properties: { ... },
     required: ['op'],
     additionalProperties: false,
     // Per-op required fields - flat JSON Schema cannot express them;
     // validateToolArgs consumes this; handler checks stay (they are
     // stricter than presence).
     'x-per-op-required': {
       create: ['article_id', 'date', 'content'],
       get: ['id'], update: ['id'], delete: ['id'],
       list: ['article_id'], search: ['query'],
     },
   }
   ```

   Added to the browser-side schema (`src/lib/tools/<tool>.schema.ts`)
   for every in-scope combo, and to the two agent mirrors:
   `RECORDS_WIRE_SCHEMA` in `agents/wiki_records.ts` and
   `FOLLOWUPS_WIRE_SCHEMA` in `agents/reflection.ts` (followups partial
   map per the rollout scope).

2. **Validator accumulation.** `validateToolArgs` gains one block,
   active only when `x-per-op-required` exists (non-combo schemas
   behave byte-identically - no regression to the centralized
   contract; the existing `validate.test.ts` suite is the regression
   net):

   - op present and legal: each rule field with `args[field] ===
     undefined` adds `missing required parameter: <field> (required by
     op=<op>)` to the same `ArgErrors`, so one throw carries flat
     errors + per-op errors.
   - op missing or illegal (cannot attribute fields to an unknown op):
     after the op error, append one clause per op with rules:
     `op=<name> requires: <f1>, <f2>`. Deterministic, no intent
     guessing, and the model gets the full argument map in one round
     trip.

3. **Error precedence.** The op-related violation (enum or
   missing-required) is moved to the FRONT of the combined message,
   then the remaining flat errors, then the per-op errors / menu
   ("collect ALL violations, report the op error first, then arg
   errors"). Implementation notes (round-1 correction + round-2
   gating): the early op check AND the per-property loop's `op` skip
   are both GATED on the key's presence (non-combo schemas keep
   today's exact check order); the op check runs EARLY (before the
   per-property loop) and the loop SKIPS `op` (the way the required
   loop skips `activity`, `_validate.ts:174-175`), so the op error is
   never reported twice; `ArgErrors` has no reorder API and stays
   insertion-ordered.

4. **Handlers unchanged (D5).** No handler branches move. The
   validator's per-op errors are additive; the handler's stricter
   checks remain as the semantic layer behind it.

5. **Both call sites, same behavior.** Automatic under D4: chat
   dispatch validates with the browser schema (rides the wire),
   agent dispatch validates with the mirrored wire schema. A mirror
   that misses the key degrades to today's behavior for that surface -
   the per-surface pin tests make that visible to the gate.

6. **RIDER R3 - verify Venice tolerates the key BEFORE merge.**
   No `x-` schema key has ever ridden the wire, and the repo has
   Venice-strictness precedents (400 on unknown fields,
   `streaming-completion-strip.test.ts:141`). Failure mode if Venice
   rejects it: every chat turn declaring a combo tool 400s at deploy -
   a full chat outage. Mitigation, in order: (i) a one-shot probe -
   POST /chat/completions with a minimal tool schema carrying
   `x-per-op-required` (API key sourced from `.envrc` per house rules;
   value never printed) and confirm the completion succeeds; (ii) the
   M4 live window includes a real chat turn declaring a combo tool.
   If Venice 400s the key: FALLBACK (pre-agreed, not built unless
   needed) - keep the key OUT of the wire by stripping it in the
   browser's wire projection and in `injectActivityParam`'s mirror,
   and read the rules edge-side from a hand-mirrored map adjacent to
   `validateToolArgs`, with the per-surface pins enforcing mirror
   fidelity. The plan does not build the fallback unless R3(i) fails.

### Tests

- `validate.test.ts` (extend): legal op + missing per-op fields ->
  combined message contains both the flat error and each per-op error;
  illegal op + missing fields -> op error FIRST, then the per-op menu
  clauses; op missing -> required error + menu; schema WITHOUT the key
  -> byte-identical behavior (existing tests already pin this);
  per-op field present -> no error; the `activity` exemption still
  applies; op error appears exactly once (no duplicate enum clause).
- Per-surface pins: the browser schema and both agent mirrors
  (`RECORDS_WIRE_SCHEMA`, `FOLLOWUPS_WIRE_SCHEMA`) each pin
  `x-per-op-required` presence + shape (loop-test style, house
  pattern of the toolbox pins in `wiki_records.test.ts`; the
  browser-schema import into the Deno island has precedent -
  `recipe_record_tools.test.ts:20,641-676` imports
  `src/lib/tools/recipe_records.schema.ts`). Written BEFORE the key
  lands so the pin's failure first proves the harness works
  (safe-to-modify round-1 finding: the agent mirrors have zero
  coverage today).
- No handler-test changes (D5 - nothing sheds).
- Test sequencing (safe-to-modify round-1 finding): the defect-1
  characterization cases land green against the UNFIXED tick first
  (harness proves what exists), then the done-branch edit flips case
  (b) on. Same for defect 2: pins first, then the key.

### Defect-1 tests

New file `supabase/functions/tests/wiki_records_sweep.test.ts` (the
existing `wiki_records.test.ts` pins toolbox/prompt composition only;
zero tick coverage today - the characterization harness IS the new
coverage). Stub-admin pattern per `orchestrator.test.ts:97-252`:
scripted RPC responses keyed by name (`claim_next_thread_for_wiki_records`
-> one claim row; `mark_thread_wiki_record_processed_if_claimed` ->
`true`), FIFO `from()` table responses for the transcript slice,
Venice key, and the two `wiki_records` count selects, and an injected
`complete` (`WikiRecordsSweepOptions.complete`) scripting one terminal
text round. The two count selects share the `wiki_records` table key -
use the stub's `onConsume` hook to assert which queue entry is which,
so the before/after ordering can never silently swap.

- (a) record created + affirmative claim -> stored reasoning unchanged,
  no warn.
- (b) zero records + affirmative claim -> warn fired, stored reasoning
  carries the annotation with both counts.
- (c) zero records + honest no-op reasoning ("No record-worthy events
  found.") -> no annotation, no warn.
- (d) count query fails (before or after) -> run completes normally,
  no annotation.
- (e) matcher unit cases: "Logged one record..." claims; "Logged
  none." / "No record-worthy events found." / "(none)" do not;
  reference-style past sentence ("One record on Sourdough was logged
  last week.") does not; mixed sentence ("Logged one record; no links
  added.") does not (miss direction, per D3).
- (f) R1 guard: prompt + wire descriptions name no retired tool.

### QA (live)

One live extraction run on the local stack (ZZQA-SF fixtures): seed a
thread with a record-worthy dated event, force a sweep tick via the
cron shim or a direct POST (the sweep route is service-role - no
turn-driving needed), and confirm the audit row either (i) carries an
unannotated reasoning with the record actually created (positive path),
or (ii) carries the annotation when the agent fumbles. QA BAR
(coordinator-approved): hybrid, offline-primary - the matcher matrix
and the count-move/no-move cases are proven offline by the tests
above; the in-situ demo is REQUIRED ONLY IF it can run without
turn-driving (it can, via the shim/POST) AND the annotation actually
fires (a fumble is not forceable deterministically - if the run is
clean, log the offline evidence in the use case and note the in-situ
check as an accepted gap for the next natural sweep). The same live
window also carries R3(ii) (a real chat turn declaring a combo tool).
STACK NOTE (coordinator handoff): the shared local stack's host session
is closing; for the live window, re-host it from THIS worktree (copy
`nak-local-config.json` from /Users/jeff.ober/dev/nak first, then
`mise run dev-start`) and announce the hosting in chat - first session
to need it hosts; never two dev-starts against one Docker project.

## MILESTONES

- **M0** - this plan: commit, refinement rounds (fresh-context
  reviewers), coordinator approval.
- **M1** - defect 1 implementation + R1 + characterization-then-flip
  tests (green `mise run check`).
- **M2** - defect 2 implementation: pins first, then schema keys +
  validator block; R3(i) Venice probe (coordinator-approved) before
  any commit that lets the key ride (green `mise run check`).
- **M3** - docs: `docs/dev/wiki.md` record-extraction bullet gains the
  verification note; `docs/dev/tools.md` gains the `x-per-op-required`
  validator contract (and the error-split gotcha it closes);
  `docs/qa/use-cases/wiki-records.md` gains the >= 2-user-messages
  precondition (doc rider from the intake investigation, documented
  gap in the QA row at `:130`). `docs/user/`: no observable
  user-behavior change; the annotation text surfaces only in the agent
  log drawer - re-check the drawer's user-doc mention at M3 and add
  one sentence if it promises unverified reasoning.
- **M4** - QA live run (ZZQA-SF, coordinated window; hybrid bar per the
  open question above) + the QA results row in
  `docs/qa/use-cases/wiki-records.md` (owned by M4 only).
- **M5** - close-out: diff summary + test results + QA rows to the
  coordinator. Never declare done before the coordinator's review.

## OPEN QUESTIONS for the coordinator

1. RESOLVED (coordinator, 23:03Z): QA bar for defect 1 is hybrid,
   offline-primary - folded into the QA section above.
2. R3(i) approval: may I run the one-shot Venice probe (single
   /chat/completions call with the key from `.envrc`, value never
   printed) during M2, before any commit carries the key?
3. R1 scope confirmation: the retired-name drift was introduced by the
   base commit itself (5eee96fa squash artifact); restoring the M9
   naming is one file + one pin test. Confirm it rides this branch.
4. Defect 2 scope - the coordinator's default (23:03Z) is all 8 combo
   schemas; the fan-out evidence contradicts a wholesale pass:
   `wiki` (`wiki.ts:455-464`), `recipes` (`recipes.ts:172-192`),
   `skills` (`skills.ts:416-418`), and `docs`
   (`docs.ts:533,554-559`) have CONDITIONAL create-or-update
   requireds, and `followups.save` is conditional
   (`followups.ts:195-236`). A flat rule for any of them rejects every
   legitimate update - the exact failure the exclusion rule exists to
   prevent, verified independently in both review rounds. PROPOSED:
   this branch ships the mechanism to the four combos where it is
   correct (`records`, `recipe_records`, `image` full maps;
   `followups` partial map), and a conditional-rule shape (needed to
   admit the other four) is follow-up work. This is the "propose the
   fallback with evidence" path the coordinator named.
