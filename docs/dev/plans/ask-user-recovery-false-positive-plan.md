# Ask-User Recovery False-Positive Plan

Status: SHIPPED 2026-10-15 (rev 3, consensus after fresh-context
review round 2; as-built matches the plan). Bug report: the
interrupted-exchange recovery machinery "always triggers" on
`ask_user` turns.

Read [`../dev/chat.md`](../dev/chat.md) for the ask_user suspend/resume
contract and [`conversation-recovery.ts`](../../../src/lib/conversation-recovery.ts)
for the recovery vocabulary used here.

## SYNOPSIS

`synthesizeRecoveryMessages` treats every tool block that runs into
EOF as an interrupted exchange and appends the synthetic assistant
note "*(The previous response was interrupted before I finished.
Picking up from here.)*". A thread suspended on an `ask_user` question
ALSO ends in a tool block at EOF - the persisted pending sentinel -
and that is not an interruption; it is the designed stop point of the
turn. The synthesizer cannot tell the two apart, so every ask_user
exchange that passes through a `listMessages` read while its tail is
an ask_user row gets a fake "interrupted" assistant minted after it.

Reproduce (2026-10-15, driving the real function against both tail
shapes): pending sentinel tail and answered sentinel tail both come
back with a `[SYNTHETIC]` recovery assistant appended. Verified the
renderer hides these rows (`message-blocks.ts`) and `classifyTail`
compensates for the pending case, but the rows still reach two
surfaces nobody filters: the provider wire and the DB heal path.

## PROBLEM

Three concrete leaks, all from the one false synthesis:

1. **Abandon-by-typing poisons the thread permanently.** Daily flow:
   model asks a question; the user reloads or switches threads
   (selectThread's abandon-on-refresh rewrites the sentinel to
   `abandoned`); the user comes back and types their answer as a
   normal message. `send()` runs `persistSyntheticRecovery` BEFORE
   `cancelPendingAskUser`; the fresh read synthesizes the recovery
   assistant for the ask_user tail and persists it as a REAL row. The
   thread now carries "the previous response was interrupted" between
   the abandoned question and the user's answer, forever, on the wire
   of every future turn.

2. **Reconnect-settle then answer puts the lie on the resume wire.**
   Reload or background the tab mid-turn; `reconnectInflightTurn`
   polls the turn to its `suspended_for_ask_user` settle and refetches
   through `listMessages` (`Chat.svelte` reconnect path). The
   synthetic enters `messages` while the sentinel is still pending.
   The user answers the card; `answerAskUser` resumes the loop and
   `buildHistoryOnWire` maps every row - the provider receives
   `[..., tool(answered), assistant("interrupted... picking up")]`.
   The model continues from the fake note right after its own
   question was answered. (The resumed request actually ends
   `tool -> metadata system row`; that shape is proven valid by the
   in-session happy path, which never passes through `listMessages`
   between suspend and answer and already sends exactly that wire.)

3. **Status card flashes.** With the synthetic tail in memory after
   abandon-on-refresh, `classifyTail` sees recovery-assistant-at-tail
   with a non-pending prev row and returns `interrupted-round`: the
   "previous response was interrupted, retry?" card appears for a
   thread whose only sin was an open question.

## ROOT CAUSE

The synthesizer's EOF rule: any `asst_with_tool_calls` whose
immediately-following tool block reaches EOF gets a recovery
assistant. Correct for real interruptions (a completed tool turn
always ends with the assistant follow-up, so a tool tail at EOF means
the turn died). The ask_user suspend is the ONE designed shape where
a tool block legitimately ends the transcript: the sentinel row is a
complete fan-in, and the follow-up arrives via the resumed turn, not
a recovery note.

`tests/conversation-recovery.test.ts` has zero ask_user coverage -
the shape was never taught.

## PROPOSED APPROACH

**`synthesizeRecoveryMessages` - sentinel-aware EOF rule.** The
sentinel's answer state decides what the EOF tail means:

- **pending** -> suspension; the resumed round continues from the
  tool block. Nothing to heal.
- **answered (via option / free_form)** -> the user just answered; a
  resumed round may continue from the tool block. Nothing to heal on
  the wire; injecting anything would lie to the resumed model.
- **abandoned (via abandoned_on_refresh / abandoned_on_new_send)** ->
  the exchange is terminally closed; the next event is a NEW user
  turn, and `tool -> user` is the provider 400 this module exists to
  prevent. Needs a closing assistant - with an honest body, not the
  interruption lie.

Block state (over the ask_user rows in a COMPLETE fan-in block; the
orchestrator guarantees completion before the suspend, and a mixed
plain-tool + ask_user round is producible so the rule keys on "the
block contains an ask_user row"):

- hasPending: any row parses as a pending sentinel.
- hasUserAnswered: any row parses answered via `option`/`free_form`.
- otherwise the block is terminal (all abandoned /
  `cancelled_by_sibling_ask_user`).

Injection decision for a complete fan-in block containing at least one
ask_user row:

- Next row is an assistant: nothing (complete turn).
- hasPending, or hasUserAnswered with the block at EOF: nothing.
  Pending is a legitimate suspension; an answered sentinel at EOF is
  a resume about to continue from the tool block. Injecting either
  shape would lie to the model that comes next.
- Everything else (terminal block at EOF; ANY sentinel-bearing block
  followed by a non-assistant row - the mid-history shapes are
  pre-fix corruption or a resume that died before committing):
  inject the closing assistant with HONEST content chosen by state:
  answered -> "*(The question above was answered.)*"; otherwise ->
  "*(The question above was left unanswered; the user moved on.)*".
  Every closing body carries the `RECOVERY_MARKER`.

Incomplete fan-ins and plain-tool blocks keep byte-for-byte today's
behavior: those are genuine interruptions.

Known owned wrinkle: an answered sentinel at EOF whose resumed turn
dies before committing anything leaves `tool(answered) -> EOF`; the
skip heals nothing and the next send inserts the user row for a
one-time `tool -> user` 400, after which the mid-history rule heals
with the honest answered body. Self-recovering, rare trigger, kept
for wire-rule simplicity; a regression test documents it.

Detection lives in `lib/ask-user.ts` (one small classifier over
`parseAskUserContent` output) so the module boundary stays clean;
`conversation-recovery.ts` imports it (no cycle: ask-user.ts
imports only a type from './supabase').

**`cancelPendingAskUser` - append the real closing row.** After
   rewriting the sentinel to abandoned, insert a REAL assistant row
   with the honest "moved on" body + `RECOVERY_MARKER` (renderer
   keeps hiding meta-rows) - gated on the sentinel row still being
   the transcript tail (if later rows already landed past it, the
   synthesizer's mid-history rule owns the wire instead). This makes
   the abandon-by-typing wire valid immediately (the new user row
   follows a real assistant) and makes the thread self-healing at
   abandon time. If the insert fails, the synthesizer's
   abandoned-tail rule still heals on the next read and
   `persistSyntheticRecovery` persists it on the next send - the
   best-effort insert has a real fallback, closing the "no heal path"
   hole. The refresh-cancel and new-send cancel paths can race;
   a duplicate hidden row is harmless and accepted. Idempotent in the
   normal case: the helper runs only when a pending row exists.

**`classifyTail` - sentinel-aware look-back.** Extend the existing
   recovery-tail exception: recovery assistant at tail with an
   ask_user sentinel prev row classifies by the sentinel's state -
   pending -> 'suspended' (today's rule), anything else (answered,
   abandoned, sibling-cancel) -> 'settled'. An answered question and
   an abandoned question are both deliberate endpoints, not cut-off
   turns; offering a turn retry over them is noise. Pre-fix threads
   carrying persisted fake interrupted notes over an abandoned
   sentinel flip from 'interrupted-round' to 'settled', which is the
   honest verdict.

**Function-side twin (same PR).**
   `repairToolCallFanIn` (`supabase/functions/venice/agents/_curation_helpers.ts`)
   has the same EOF rule and the same false positive: the
   summary/wiki/reflection workers read a suspended thread and the
   fake note rides the worker wire. There the assistant row is
   LOAD-BEARING (the worker appends a user instruction after the
   tail; `tool -> user` 400s), so every sentinel state keeps an
   assistant, with a per-state honest body: pending -> "waiting for
   the user's answer"; answered -> "the question above was answered"
   ("waiting" would contradict the answered row before it);
   abandoned/sibling-cancel -> "left unanswered; the user moved on".
   Non-ask_user blocks keep today's note. The functions bundle cannot
   import from `src/lib`, so the small classifier is duplicated there
   with a pointer comment at both sites.

**Tests.** `tests/conversation-recovery.test.ts`: pending tail,
   answered tail (no synthesis each); abandoned tail (honest closing
   assistant synthesized, marker present); mixed plain-tool + pending
   block (no synthesis); mixed + abandoned block (honest closing);
   mid-history sentinel block and incomplete fan-in (still
   synthesize); non-ask_user tail unchanged. ask-user.ts classifier
   unit tests. classifyTail cases for the three sentinel prevs.
   Function-side: port-equivalent cases in the functions test setup.

## ACCEPTANCE CRITERIA

- Driving `synthesizeRecoveryMessages` against pending and answered
  sentinel tails returns the input array by reference; the abandoned
  tail gains only the honest closing assistant.
- Answering a question in a reconnect-settled tab sends a wire that
  ends `tool(answered) -> metadata system row` (the in-session-proven
  shape), with no interruption note.
- Typing over an open question produces the real honest closing row
  before the new user row; a failed insert still heals on the next
  read/send.
- No "interrupted" status card after abandon-on-refresh.
- `mise run test` green; existing recovery tests untouched and
  passing.

## VALIDATION

Local stack QA per `docs/qa/use-cases/chat-streaming-turn.md`: ask a
question, answer it in the same tab (clean reply, no recovery text);
reload mid-question, type over the card, check the DB tail
(`mise run dev-sql`) for the honest closing row and the absence of
the interrupted note; reload mid-turn before the question lands,
reconnect, answer, confirm the resumed wire via the Logs drawer;
trigger a summary-worker pass over a suspended thread and check the
worker wire for the honest waiting note.

## NOTES

- Threads already poisoned by the pre-fix persist carry a real
  recovery row mid-history. The renderer hides it and the model reads
  a harmless lie; not worth DB surgery unless Jeff wants a cleanup
  pass.
- Review round 1 findings incorporated: mixed-block escape hatch
  (closed by the contains-a-sentinel rule), the abandoned-tail
  classification hole (closed by APPROACH 3), the missing heal
  fallback for a failed closing insert (closed by the synthesizer's
  abandoned-tail rule as the fallback layer), the function-side twin
  (APPROACH 4), and the wire-validity rationale correction (PROBLEM
  2 parenthetical).
