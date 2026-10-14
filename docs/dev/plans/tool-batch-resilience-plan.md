# Tool-Batch Resilience Plan

Status: SHIPPED 2026-10-14 (all four asks + the catch guard, the
recovery-row display fix, and the orchestrator test harness; QA
results in `docs/qa/use-cases/chat-streaming-turn.md`; harness
conventions in `docs/dev/testing.md`). The plan text below is the
as-proposed record; where implementation taught more (the byte-cap
analysis, the statusFor gap), the follow-on sections carry it.

Read [`../tools.md`](../tools.md) first; this plan assumes its
dispatch vocabulary (`performToolCall`, `runOneToolCall`, the
round structure) and its "budgetMs" background on the hosted edge
runtime's isolate kill.

## SYNOPSIS

Make large parallel tool-call batches fail informatively instead of
silently. Four changes: (1) a soft cap of 10 dispatched calls per
round with the excess deferred to the next round, (2) per-call
persistence of tool results as each call completes instead of one
batch insert after all calls finish, (3) a `reason` field on every
delete tool's `{deleted: false}` result, and (4) an analysis of the
byte-cap alternative (answered: count is the right dispatch trigger;
documented, not implemented as a trigger).

## PURPOSE

A prod session on 2026-10-13 (thread `8b14894d-c9be-4cde-8a31-
cce73bcaff72`) lost a 19-call `record_delete` batch mid-dispatch:
the round's assistant row persisted with 19 tool_calls, zero
tool-result rows landed, 9 of the 19 deletes executed against the
DB, and the model had no way to tell which. The recovery synthesizer
filled all 19 ids with "(tool execution was interrupted - no result
available)" on the next read. The user then over-deleted 11 records
re-issuing deletes from memory, because `deleted: false` (and its
absence) could not distinguish "already deleted" from "never
existed".

Current code has three gaps that produced this:

1. **All-or-nothing persistence.** Result rows insert in one
   sequential pass after every call completes
   (`getStreamingResponse.ts:1029`, `:1698-1765`). A death during
   dispatch loses every row, including calls that fully succeeded.
2. **No dispatch cap.** `Promise.all` over the round's full
   tool-call list (`getStreamingResponse.ts:910-912`) runs every
   call at once. A 50-call round opens 50 concurrent dispatches.
   Whatever killed the isolate (unconfirmed - see "Root-cause
   status"), the blast radius scales with the concurrent set.
3. **Ambiguous delete results.** Three delete tools return
   `{deleted: true}` even when the DELETE matched zero rows
   (`memory_delete.ts:69`, `wiki_delete.ts:82`,
   `recipe_delete.ts:27`); three return a bare `{deleted: false}`
   with no reason (`record_delete.ts:55`,
   `recipe_record_delete.ts:30`, `record_link_delete.ts:53`). Only
   `doc_delete.ts:29` returns a reason.

## DESCRIPTION

### How the round loop behaves today

The orchestrator's round loop, per round that emitted tool calls
(`supabase/functions/venice/getStreamingResponse.ts`):

1. **Stream consumption** (lines 616-768) collects
   `tool_call_request` events into `roundToolCalls`. Abort checks
   fire at three sites before any dispatch: top-of-round (580),
   stream error event (656-680), post-stream (778-791).
2. **The round's assistant row persists BEFORE dispatch**
   (`persistRoundAssistantRow`, 871-877) so the browser paints
   live tool cards during execution.
3. **Dispatch**: `Promise.all(roundToolCalls.map((tc) =>
   runOneToolCall(tc, ctx, schemaMap)))` (910-912).
   `runOneToolCall` never throws - it catches everything into an
   `ok: false` outcome (1593-1629). So `Promise.all` resolves even
   when every call fails, and the throws that reach the
   orchestrator's catch (1171) in practice come from row
   persistence.
4. **Batch-end passes**: image harvest (949-962), ask_user
   suspend detection (972-974), citation harvest (982-991),
   `tool_call_response` publishes (1000-1020), then
   `persistRoundToolResults` (1029-1033) inserts one row per
   outcome in a sequential loop, throwing on the first insert
   failure (1750-1756) so the next round never proceeds with a
   wire-invalid fan-in hole.
5. The history push (1037-1056) replays the full result contents
   to the model next round.

Concurrent insert safety: the `assign_message_position` trigger
takes a `FOR UPDATE` lock on the thread row before reading max
(position), which serializes concurrent appends on one thread
(`supabase/schema.sql:767-796`). Per-call concurrent inserts
cannot collide on `messages_thread_position_idx`
(`schema.sql:807-808`).

Recovery: when a round row's tool_call ids have no matching result
rows, the browser's `synthesizeRecoveryMessages`
(`src/lib/conversation-recovery.ts:231-311`) fills each unanswered
id with a synthetic row whose body is
"(tool execution was interrupted - no result available)"
(`conversation-recovery.ts:90-91`) and inserts a recovery assistant
after the block. The edge's agent-side mirror
(`agents/_curation_helpers.ts:123-152`) builds the same shape
in memory. The browser renders missing results as the literal
`_In progress…_` placeholder (`src/lib/ui/tool-calls.ts:182`) and
unanswered replayed calls as
status `error` (`tool-calls.ts:71,89`).

### Root-cause status (honest)

The prod evidence pins the failure SHAPE (death during dispatch:
round row persisted, zero result rows, 9 of 19 effects landed) but
not the killer. The graceful paths cannot produce it: the wall
deadline (380s, `getStreamingResponse.ts:128,339-345`) aborts
through three inline check sites that all set the terminal before
breaking, and tool DB calls do not take the abort signal at all -
only 4 tools wire `ctx.signal` into HTTP fetches (web scrape and
the image ops). `docs/dev/tools.md:442-446` documents that the
hosted edge runtime hard-kills isolates around 400s, and turn C
died ~135s in. Edge function logs were not retrievable through the
Management API. So: killer unconfirmed, most plausibly a runtime
isolate recycle. Every change below is a mitigation that holds
regardless of which killer fired.

The report's payload-size suspicion ("both my failed batches had
very large expected payloads") does not survive contact with the
prod data: the same turn that died on a 19-call delete batch had
already completed a 50-call batch and a 22-call batch minutes
earlier, and a single-call `memory_save` turn also died with zero
results. Neither call count nor payload bytes predicts the kill.
What payload size DOES drive is round duration (the turn before
streamed one round for ~5 minutes against a history carrying an
82KB `record_list` result) - that is a separate lever, recorded
under Follow-ups, not this change.

## PROPOSED CHANGE

### 1. Soft cap: dispatch at most 10 calls per round

In the dispatch block: split `roundToolCalls` into the first
`MAX_PARALLEL_TOOL_CALLS` (10, new constant next to `MAX_ROUNDS`
at `getStreamingResponse.ts:115`) and the tail. The tail gets
synthesized deferred outcomes in model order, using the house
failed-outcome shape (`runOneToolCall:1625` - a string error body)
with the full teaching text as the SINGLE source carried in
`errorMessage` (for failed outcomes the persisted row content is
built from `errorMessage` alone - `persistRoundToolResults`
encodes `{ ok: false, error: new Error(o.errorMessage) }` at
`getStreamingResponse.ts:1730-1734`, and `encodeToolContent` emits
`{"error": "<message>"}` - so anything put only in `result` never
reaches the model):

```ts
{
  request: tc,
  ok: false,
  result: { error: DEFERRED_MESSAGE },
  errorMessage: DEFERRED_MESSAGE,
}
```

`DEFERRED_MESSAGE` tells the model exactly what to do, and must
read as "not executed this round because the parallel-call cap was
reached; re-issue this call" - actionable re-issue wording, never
"ask failed" phrasing that could make the model apologize instead
of retry. Keep it under 200 chars so the transient
`tool_call_response` summary (sliced at `TOOL_RESULT_SUMMARY_CHARS`,
`getStreamingResponse.ts:143,1004-1009`) carries it intact; the
persisted row content is unaffected by the slice. Deferred outcomes
flow through the same persistence and publish passes as real ones,
so every tool_call id is answered and the wire fan-in stays valid.

Log observability: deferred outcomes must not read as failures.
The round summary line prints `ok`/`err` per outcome
(`getStreamingResponse.ts:913-915`) and the failure loop logs an
error per not-ok outcome (918-922) - a 30-call batch would log 20
spurious "failed" errors. The summary line tags deferred outcomes
`deferred` (distinct from `ok`/`err`) and the failure loop skips
them.

Accepted interaction: an ask_user deferred past the cap yields an
error-shaped outcome, so `suspendIdx` stays -1 - the round does not
suspend, and the model re-issues the ask next round (the browser's
pendingAskUser only surfaces on the `suspended_for_ask_user`
terminal, `src/lib/chat/stream-events.ts:398-399`). Cost: one
extra inference round before the question card appears, and the
ask_user card shows the deferral text as an error row until
re-issued. Accepted for v1; ask_user is a single-call tool and
deferral only bites in an oversized mixed batch.

Model-visible effect on an oversized batch: the first 10 run, the
rest come back deferred, the model re-issues, next round runs the
next 10. A 50-call batch becomes 5 rounds. With `MAX_ROUNDS = 24`
(`getStreamingResponse.ts:115`) a turn can still move ~230 calls
per turn; the round-limit terminal and its banner
(1152-1170) already handle exhaustion visibly.

### 2. Per-call persistence and per-call response events

Restructure the dispatch block so each call handles its own
persistence as it completes:

```ts
const outcomes: Array<ToolOutcome | undefined> = new Array(roundToolCalls.length);
await Promise.all(roundToolCalls.map(async (tc, i) => {
  const o = i < capped ? await runOneToolCall(tc, ctx, schemaMap) : deferredOutcome(tc);
  outcomes[i] = o;
  if (!isAskUserPending(o.result)) {
    await persistOneToolResult(opts, o);   // insert the role='tool' row now
    await publishToolResponse(publisher, o); // summary event now
  }
}));
```

`persistRoundToolResults` splits into `persistOneToolResult` (the
single-row insert, same content encoding including the
`__ask_user_answered__` sibling-cancel shape) and a thin batch-end
pass that persists and publishes ONLY ask_user outcomes after all
calls settle - the sibling-cancel rule needs the round-level
picture of which ask_user is first-pending
(`getStreamingResponse.ts:1717-1728`), which no single call knows
mid-flight. The batch-end pass publishes those outcomes'
`tool_call_response` events too, keeping the ask_user card's
resolution path identical to today's (response event, not just the
realtime row INSERT).

`persistOneToolResult` returns the inserted row (id,
tool_call_id, name, content - the shape the history push needs),
and every caller (the per-call map callback and the ask_user
batch-end pass) pushes the id onto `runRowIds` so the
aborted-regenerate rollback (`getStreamingResponse.ts:1268-1291`)
deletes the round's rows exactly as it does today. Unregistered
rows would survive a stopped regenerate as orphans - the failure
the rollback exists to prevent.

The history push (1037-1056) keeps MODEL order: `outcomes` stays
an index-aligned array over `roundToolCalls`, the batch-end pass
collects `toolResultRows` by walking `outcomes` in index order, and
history replays that list. (Completion order would also be
wire-valid - the fan-in contract constrains ids, not order,
`_curation_helpers.ts:170-180` - but model order avoids a silent
transcript-ordering change.)

Image attach (949-962) and citation harvest (982-991) stay
batch-end passes over the settled `outcomes` array. The
`outcomes` array is fully populated when `Promise.all` resolves
(the deferred branch is synchronous and the map callback assigns
before resolving), so batch-end passes read it without undefined
holes; typing stays `ToolOutcome[]` via a final fill check.

Effect on the failure mode: a death during dispatch leaves
completed calls' rows persisted; the recovery synthesizer then
fills only the calls that produced no result row, and the model
(and user) can see exactly which calls have real results and which
do not. A call in flight at death may still have executed against
the DB (the prod 9-of-19 shape) - its recovery row honestly says
"no result available", not "not executed"; only the deferred and
abort-caught paths produce definite not-executed rows. This is the
report's ask 2. The round's row-insert order changes from model
order to completion order; both are wire-valid (the fan-in
contract constrains ids, not order - see
`_curation_helpers.ts:170-180`), and the transcript positions
serialize through the thread lock.

Insert-failure semantics stay as today: a failed row insert throws
(`getStreamingResponse.ts:1750-1756` rationale unchanged - the
next round must not proceed with a hole), which rejects the
`Promise.all`, lands in the orchestrator catch, and fails the turn.

### 3. Honest delete results with a reason

Follow `doc_delete.ts:29,46` as the shape. Two classes of fix:

- **The three silent no-op tools** (`memory_delete`, `wiki_delete`,
  `recipe_delete`): switch the DELETE to `.select('id')` (the
  pattern `record_delete.ts:28-35` already uses) so zero-row
  deletes are detectable, and return
  `{deleted: false, reason: '...no <thing> with that id (it may
  have already been deleted)...'}` when nothing matched. This
  changes `deleted: true` to `deleted: false` on the
  already-gone path - that delta is the point: the model can
  currently re-delete blindly and read success.
- **The three bare-false tools** (`record_delete`,
  `recipe_record_delete`, `record_link_delete`): add the reason
  string alongside the existing `deleted` flag. The existing
  "can't distinguish miss from not-owned" property
  (`record_delete.ts:6-8`) stays - the reason names both
  possibilities. `wiki_delete` keeps returning its `id` field
  (`wiki_delete.ts:82`) in both the true and false shapes.

Accepted edge case from the per-call split: an in-flight per-call
row insert can race the aborted-regen rollback's bulk delete when
`Promise.all` rejects mid-batch (sibling callbacks are not
cancelled). Today's sequential batch cannot race. A row that
inserts after the rollback is an orphan the user can delete by
hand; accepted.

Wire schema descriptions in `src/lib/tools/*.schema.ts` update to
document the `reason` field per tool
(`memory_delete.schema.ts:12`, `record_delete.schema.ts:11-12`,
`recipe_delete.schema.ts:8` carry the affected wording). The
changelog guards stay untouched: `memory_delete.ts:53-67` and
`wiki_delete.ts:62-80` gate the changelog append on the row having
existed, so a zero-row delete still writes no changelog - same as
today, now with an honest return shape.

### 4. Byte cap as trigger: considered, declined (documented)

The report's ask 4 suggested triggering the cap on total result
bytes instead of call count. Analysis, recorded here so it is not
re-litigated: the cap's job is bounding the concurrent dispatch
window (the exposure window for a mid-dispatch death) and the
per-round blast radius. Call count bounds both directly. Payload
bytes predict neither window duration nor kill probability in the
prod evidence (50 tiny deletes succeeded; 19 tiny deletes and 1
save died). A byte trigger would also be unpredictable to the
model - which calls get deferred would depend on argument sizes in
a way the model cannot anticipate or learn around. Declined as a
dispatch trigger. The related real concern (large tool RESULTS
riding the history into every subsequent round's request -
`getStreamingResponse.ts:1037-1056` pushes full contents) is a
history-shaping lever, listed under Follow-ups.

### Small correctness guard in the same region (cheap, in scope)

The orchestrator catch (1171-1200) skips setting the terminal when
`ctl.signal.aborted` is already true, on the assumption that an
inline check site set it. An abort co-timed with a genuine throw
mid-dispatch (e.g. a DB error on a row insert while the wall timer
fired) reaches the catch with `terminalKind` still `'completed'`,
and the finally would commit the partial turn as `complete`. Five
lines: when the catch sees aborted-but-completed, set the same
wall-timeout-vs-cancel terminal the inline sites set. Near-
unreachable today (row inserts do not take the signal), but it is
the same failure class this change exists for and the fix is
trivial. Knock-on to note: with the terminal now correctly
`'aborted'`, `rollbackAbortedRegen`
(`getStreamingResponse.ts:1244-1247`) engages in this co-timing
for a regenerate - the run's rows roll back instead of committing
partial. That is the designed abort semantics (a stopped regen
must leave the thread as it was), applied to a timing that today
commits a partial row; stated here so the delta is deliberate.

## Files touched

- `supabase/functions/venice/getStreamingResponse.ts` - cap
  constant, dispatch restructure, `persistOneToolResult`,
  deferred-outcome synthesis, catch guard.
- Testability seam: the dispatch block is inline in the round loop
  and no test imports this file today, so the cap split, the
  deferred-outcome builder, and `persistOneToolResult` are
  extracted as exported helpers (same file, exported from it)
  that the round loop calls and the Deno tests import directly.
- `supabase/functions/venice/tools/memory_delete.ts`,
  `wiki_delete.ts`, `recipe_delete.ts` - honest deleted flag +
  reason.
- `supabase/functions/venice/tools/record_delete.ts`,
  `recipe_record_delete.ts`, `record_link_delete.ts` - reason
  field.
- `src/lib/tools/memory_delete.schema.ts`, `recipe_delete.schema.ts`,
  `record_delete.schema.ts`, `recipe_record_delete.schema.ts`,
  `record_link_delete.schema.ts`, `wiki_delete.schema.ts` -
  description wording for `reason`.
- `supabase/functions/tests/` - new unit tests for the cap split,
  deferred outcomes, per-call persistence, and the delete-tool
  results; plus a test pinning that every persisted row id lands
  in `runRowIds` (the rollback contract), and one for the
  catch-guard terminal assignment. (No existing edge tests pin
  the batch shapes - nothing to adjust.)
- `docs/dev/tools.md` - the dispatch cap + per-call persistence
  under Chat-loop entry points/Gotchas; the delete-result contract
  under Contracts.
- `docs/qa/use-cases/chat-streaming-turn.md` - new QA rows for
  batch-cap and interrupted-batch behavior (baseline pass before
  the change).

## Decisions

- **Cap is enforced edge-side, not prompted.** A system-prompt
  nudge ("prefer batches of 10") was rejected: wire-schema
  constraints are advisory text the model reads, not runtime
  checks (`../tools.md` Gotchas, "Wire-schema constraints are
  advisory"), and the deferred-result message teaches the cap on
  first encounter with zero prompt bytes.
- **Cap value 10.** The reporter's suggestion; the prod data does
  not argue for any other number.
- **Deferred calls surface as failed outcomes, not a new ToolOutcome
  state.** The UI's `statusFor` tree (`tool-calls.ts:57-90`) stays
  untouched; a deferred call renders as an error with the deferral
  text in the drawer and detail panel. Adding a `deferred` status
  would touch the UI state machine for a transient state the model
  resolves next round. Accepted consequence: every deferred call
  leaves a permanent error-shaped card in the transcript, so an
  oversized batch shows a cluster of error cards until the drain
  rounds complete - honest noise, preferred over a silent gap or a
  fake green check.
- **Log noise from deferral is tagged away, not accepted.** The
  round summary line distinguishes `deferred` from `ok`/`err` and
  the failure loop skips deferred outcomes (see section 1), so the
  drawer's error count stays meaningful.
- **agent loops (runHeadlessAgent) are out of scope.** The same
  kill can strand an agent mid-loop (the `budgetMs` machinery at
  `../tools.md:448-462` already bounds that separately), but the
  reported bug is chat-turn dispatch.

## Follow-ups (not this change)

- **History result-byte budget.** Cap or truncate oversized tool
  results replayed into subsequent rounds' history (the 82KB
  `record_list` result). Changes model-visible data; wants its own
  design pass on which tools truncate and how the model sees the
  truncation.
- **Per-call status on hard-kill tails.** The recovery body is
  accurate but static; a future change could have the recovery
  pass report which calls in a healed block are known-completed
  vs. synthesized, from the result rows that did land.

## Validation

- `mise run check` green (vitest + deno island + build).
- New unit tests: cap split (19 calls -> 10 dispatched + 9
  deferred, model order), deferred outcome text (under 200 chars,
  re-issue wording), per-call row persistence order under
  staggered completion, ask_user rows still batch-persisted with
  sibling-cancel, every persisted row id registered in
  `runRowIds`, the catch-guard terminal assignment, delete-tool
  zero-row results (shape + no changelog row).
- QA use-case executed pre-change (baseline) and post-change
  against the local dev stack per `docs/qa/README.md`.
