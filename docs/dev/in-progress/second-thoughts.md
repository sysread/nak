# Second thoughts (in progress)

> **Status: design only. Nothing is built yet.** This doc
> records the design decisions reached in the planning
> conversation so the first implementation milestone has a
> spec to build against and a shape to poke holes in. When
> v1 lands, graduate the durable parts (the reflex/deliberation
> model, the reviewer input contract, the data model) into a
> permanent `docs/dev/second-thoughts.md` and retire this file
> per the in-progress doc rules in `CLAUDE.md`. Until then,
> treat every "will" below as a proposal, not a description of
> running code.

## The idea

Give the chat model a self-doubt reflex. After it finishes a
response, a fast pass re-reads what it just said and reports a
*felt confidence* - stands behind it, or something feels off.
The doubt surfaces to the user per-message, and (in a later
phase) can trigger the model to reconsider and correct itself
in a follow-on round.

The framing is psychological, not mechanical. Nak models human
mental processes to see whether many small LLM passes can
*emerge* into something that reads as contextual and less
sycophantic (see [`architecture.md`](../architecture.md) and
the sibling subconscious features). An LLM is a plausibility
engine; humans are too, but self-doubt and the memory of having
been wrong in front of someone make us re-check before we
speak. Second thoughts is that re-check.

## The core model: reflex vs deliberation

The single most important design decision, because every other
choice falls out of it: **doubt and the resolution of doubt are
two different mental motions, and we model them as two separate
passes with opposite properties.**

- **The reflex (the reviewer).** Fast, cheap, low-context,
  pre-verbal. The 2am "wait - was it weird that I brought up
  asthma? did I overstep?" It does NOT replay the full
  reasoning that produced the answer. It is a gut twinge. Runs
  on a fast model over a deliberately narrow slice of the turn.
- **The deliberation (the correction round).** Slow, smart,
  full-context. The considered "no, it's fine - I know they
  have asthma, stand by it" (or "actually, no, that acreage
  was a guess - let me check"). Runs on the thread's own tier
  with everything it normally sees, and can call `web_search`.

The asymmetry is the point, not a limitation. **The doubt does
not need the context; the answer to the doubt does.** This is
what lets the reviewer stay pure and narrow (below) without
destroying the contextual inference nak exists to produce: the
reflex is *allowed* to twinge at a good contextual leap, because
the deliberation is where that twinge gets adjudicated and, most
often, overruled.

Worked example (the case this feature must not regress). User
has asthma; days later asks "do any Colorado fires threaten
Colorado Springs?" The model correctly weaves in an N95
precaution keyed to the asthma history. A pure reviewer, seeing
only this turn, *should* twinge: "the user didn't mention asthma
in this message - are you sure that wasn't projection?" That is
the reflex working, not failing. The deliberation, with the full
history and memory, answers: "warranted - stand by it." A design
that suppressed the twinge would also suppress the reflex's
ability to catch real projection; a design that let the reflex
*rewrite* unadjudicated would strip the best part of the answer.
Two passes, opposite context budgets, resolves both.

## Why not a pre-finalization gate

Recorded so the next reader does not re-litigate it. The
response streams token-by-token to the browser as Venice emits
it (`getStreamingResponse.ts` republishes every `response_text`
delta to the Broadcast channel immediately). There is no
"generated but not yet shown" holding pen for the main content -
by the time a response is complete the user has already read it.
A true gate would require buffering the whole reply server-side
and withholding it until review finished, which guts the
streaming UX the entire orchestrator is built to protect
(exchange slots, reconnect polling, round-boundary events).

So second thoughts is explicitly a *post-response* feature, not
a gate. v1 displays doubt after the fact; phase 2 appends a
correction as a follow-on turn. Neither blocks the original
reply from reaching the user live.

## Phasing

Built in strict risk order. Each phase is shippable and
observable on its own; do not start a phase before watching the
prior one behave.

### v1 - the reflex, detached, per-message, display-only

The safe foundation. **No round-loop changes, no history
mutation, no correction, nothing on the critical path.**

After a completed turn, a new turn-tail unit runs the reviewer
over the finished turn and writes its verdict onto the just-
committed assistant row. The message already streamed and
committed as today; a beat later the per-message slide-down
populates via the realtime UPDATE on the row. Rides the exact
`EdgeRuntime.waitUntil` tail where `curateOnTurnTail` /
`samskaraOnTurnTail` / `reflectOneThread` already run
(`getStreamingResponse.ts`, `terminalKind === 'completed'`
only), so it is detached and adds zero latency to the user-
visible turn.

**Fires on every completed turn**, not gated. Gating would mean
first deciding "is this turn worth doubting?" - but that decision
cannot be made cheaply without a completion that reads the turn,
which is the reflex pass itself. A gate is a false economy: the
gate *is* the reviewer. So every completed turn gets the pass;
`conviction` (the common verdict) is the cheap-and-quiet outcome
rather than a skipped one.

The point of v1 is to **watch the reflex's judgment quality
before it is ever allowed to change an answer.** Consequence to
go in with eyes open: with no correction round yet, a twinge
about a good contextual leap (the asthma paragraph) surfaces in
the slide-down and *sits there unresolved* - the thing that
would adjudicate it does not exist until phase 2. That is honest
(you are watching the reflex fire in isolation) but it means the
v1 surface shows doubt without resolution.

### phase 2 - the correction round (the deliberation)

Once the reflex is trusted, let a strong-enough verdict trigger
a follow-on round. This is the phase that touches the round loop
and the critical path (it runs *before* control returns to the
user, so the user sees the model reconsider before they act on
the answer). Details in "The correction round" below. This is
also where the reviewer's `web_search` grounding and the `defer`
disposition become meaningful.

### phase 3 - the emergent loop (deferred, maybe organic)

A `correct` / `reframe` is an *embarrassment event* - the same
class of signal samskara and the bias profile already consume. A
model that just discovered it over-reached should have that tune
its future baseline confidence. We deliberately are NOT building
a global "conviction" diagnostic pill: if the loop works, the
learned doubt disposition should show up *secondarily* in mood
(samskara) and bias calibration on its own. Building the pill now
would assert the emergence we want to observe. Left as a note,
not a plan.

## The reviewer (v1)

### Input contract - pure and narrow

The reviewer sees **only**:

1. the most recent user message, and
2. the LLM messages that follow it in the same turn - the
   assistant response (content **and** reasoning) plus any tool
   calls and their result rows.

It does **not** see the pregame priming chain (intuition /
samskara / context-recall `<think>` blocks) and does **not** see
prior conversation history. Two independent reasons:

- **Independence.** A reviewer that replays the author's inner
  monologue shares the frame that produced the answer, so it
  rationalizes instead of doubting. Excluding the priming chain
  forces a genuinely *second* look, and is the only way the
  reflex can catch the case where the priming itself steered the
  answer wrong.
- **Fidelity to the reflex.** The gut twinge is low-context by
  nature. Feeding it the whole conversation both breaks the
  metaphor and risks the failure the narrow slice is chosen to
  avoid (below).

Including the assistant's **reasoning** in the slice is
deliberate and makes the reviewer sharper, not blinder: it
reviews the model's own stated justification ("they have asthma,
so N95 advice is relevant") and can weigh whether that inference
was sound, rather than guessing intent from the prose alone.

### Guarding against conversational takeover

Risk: replay a conversation as role-tagged messages and the
model's trained reflex is to *continue* it - answering as a
fourth voice instead of reviewing. Three layered defenses, in
increasing hardness:

1. **Separate completion with a reviewer system prompt.** It is
   an agent whose whole job is the meta-task, a sibling to
   `summary` / `bias` / `topics` under `venice/agents/`, not the
   chat model handed extra history.
2. **Serialize the slice as a labeled transcript inside one user
   message**, not as replayed role-tagged messages. Role replay
   is precisely what triggers "continue the conversation";
   handed a fenced document ("Here is the exchange under review:
   ...") the model analyzes instead. Nak already uses exactly
   this `<user_message>` fence to stop scraped URLs being misread
   as user-authored - see the fence gotcha in
   [`chat.md`](../chat.md).
3. **Structured output makes fourth-voice continuation
   structurally impossible.** If the only valid output is
   `{ disposition, note }`, there is no schema slot for a
   conversational reply. This is the hard guard; 1 and 2 keep
   quality up.

### Model

Fast, cheap tier - the reflex is dumb and fast by design, which
is what makes it a reflex and not a second deliberation. The
planning conversation used `xiaomi-mimo-v2-5` as the candidate
(1M context, ~$0.17/M in). Wire it through the same agent-model
resolution the other fast agents use rather than hardcoding the
id; confirm it honors `response_format` structured output on
Venice at implementation time (see the venice-chat skill /
structured-output notes).

### Output - the disposition spectrum

Structured `{ disposition, note }`:

- `conviction` - stands behind it, framing and facts. The common
  case. Signal calmly (or not at all); change nothing.
- `hedge` - answer is fine but overconfident; a caveat is
  missing.
- `reframe` - may have misread the question or the person;
  approach doubt.
- `correct` - suspects a factual error.

`note` is the first-person voicing of the twinge, shown in the
slide-down. In v1 `correct` means "I suspect this is wrong," not
"verified wrong" - the reviewer has no `web_search` and no prior
context to check against; verification only exists in phase 2.
The `defer` disposition ("I cannot resolve this without asking
the user") is intentionally left out until phase 2, since
deferring is only meaningful once the feature can act.

## The correction round (phase 2)

When a verdict crosses the bar (initial proposal: `reframe` or
`correct`; `hedge` stays display-only), the turn does not end.
Instead the orchestrator, at the terminal-round break in
`getStreamingResponse.ts` (`!roundHadToolCalls`), converts what
would have been the terminal round into a non-terminal one:

1. persist the original response as a non-terminal assistant row
   (the same `persistRoundAssistantRow` path tool-rounds use);
2. persist the "second thoughts" card (the reviewer's `note` +
   any citations) as its own transcript element;
3. splice a synthetic `<think>` self-doubt message onto
   `history`;
4. continue the loop for one correction round, which streams
   live and commits terminal.

Transcript ends ordered and honest: `[user] -> [assistant:
original] -> [second-thoughts card] -> [assistant: correction]`.

### The injected doubt MUST permit rejection

Load-bearing, and the single most important prompt-engineering
constraint in the whole feature. The `<think>` block handed to
the strong chat model is **advisory misgiving, never an
instruction to comply.** It is phrased in the first person as
something to evaluate and potentially dismiss, e.g.:

```text
<think>
I'm feeling some internal doubt about how I answered. Let me
think through the misgivings and double-check that they are
legitimate before I change anything. If they don't hold up, I
should stand by what I said and say so plainly.
<the reviewer's note, with any citations>
</think>
```

Why this matters: the reviewer is a *cheap, low-context* model
second-guessing a *smart, full-context* one. If the doubt is
framed imperatively ("fix these errors"), the strong model
dutifully "fixes" things that were never broken - and since the
reviewer is the blinder of the two, it will disproportionately
flag exactly the contextual inferences (the asthma paragraph)
that make nak good. **The permission to reject is the safety
valve that lets the full-context deliberation overrule the
low-context reflex.** The correction round must be free to
conclude "my original was right" and restate it unchanged; the
prompt has to say so out loud. A correction round that cannot
say "no" is a regression-to-generic machine pointed at the
feature's best output.

### Recursion limit

The correction round produces a new response. Left unbounded, a
cheap reflex re-doubting a smart-tier correction could ping-pong
(doubt -> correct -> doubt the correction -> correct again),
which both burns rounds and erodes user trust in the signal.

Rule: **the reviewer fires at most once per user turn - the
correction response is terminal and is NOT itself reviewed.** One
twinge, one adjudication, done. This also sits inside the
existing `MAX_ROUNDS = 24` budget as a hard backstop, but the
one-pass rule is the semantic bound and should be enforced
explicitly (a per-turn "second thoughts already ran" flag),
not left to the round cap. If a future need for multi-pass doubt
appears, raise the cap deliberately with its own justification;
do not let it default open.

## Data model (v1)

One jsonb column on `messages`, sibling to `usage` / `reasoning`
/ `citations`:

```sql
alter table public.messages
  add column if not exists second_thoughts jsonb;
```

Shape (proposal):

```ts
{
  v: 1,
  disposition: 'conviction' | 'hedge' | 'reframe' | 'correct',
  note: string,            // first-person voicing of the twinge
  model: string,           // concrete reviewer model id, provenance
  computed_at: number,     // ms since epoch
}
```

1:1 with the assistant row it reviews. Cascades on
delete-from-here and regenerate for free (the read is anchored
to a real durable row), which sidesteps the round-id staleness
fragility intuition carries from caching on the thread row
instead of the message. Phase 2's correction card and citations
get their own shape when that phase is designed; do not
pre-build columns for it.

## UI (v1)

A per-message affordance, NOT a global diagnostic pill.
Convention: global diagnostics live in the bottom-right pill
column and reflect conversation-current state (intuition is the
exception, always "last generated," because its priors are not
persistent); per-message analytics live in slide-downs on the
message. Second thoughts is per-message and persistent, so it is
a slide-down, in the `AssistantBody` neighborhood alongside the
reasoning and tool-call panels.

- Collapsed: a small glyph / border tint keyed to disposition
  (the ambient signal - readable at a glance without opening).
- Expanded: the `note`.

Per the frontend split
([`frontend-organization.md`](../frontend-organization.md)) the
disposition-to-glyph / disposition-to-label maps and any
count/label transforms are pure primitives in
`src/lib/ui/second-thoughts.ts`; the `.svelte` file holds only
the composition and the slide-down wiring.

## Contracts

- **Reviewer input is the turn slice only** - most recent user
  message + subsequent assistant/tool rows (with reasoning),
  serialized as a fenced document. No priming chain, no prior
  history. Changing this contract changes what "doubt" means;
  do not widen it without revisiting the reflex/deliberation
  model above.
- **v1 never mutates the transcript.** The read is additive
  metadata on an already-committed row. The correction round
  (phase 2) is the first thing that writes new rows.
- **The injected doubt is advisory.** Phase 2's `<think>` block
  permits rejection by construction (see above). Any change to
  that prompt must preserve the explicit permission to stand by
  the original.
- **One reviewer pass per user turn.** The correction response
  is terminal and unreviewed.

## Interactions

- **Chat ([`chat.md`](../chat.md))** - v1 is a turn-tail unit
  next to curation/samskara/reflection; phase 2 hooks the
  terminal-round break in the round loop and adds transcript
  rows, so it touches `toVeniceMessage` (how the second-thoughts
  card and the `<think>` block project on replay) and the
  regenerate/delete-from-here ranges. v1 touches none of that.
- **Intuition ([`intuition.md`](../intuition.md))** - the
  metacognitive twin on the other side of the completion.
  Intuition is pre-game, global, ephemeral (one overwritten
  thread-row cache); second thoughts is post-game, per-message,
  persistent. Opposite persistence shapes - which is why this is
  a sibling feature, not an extension of intuition. The reviewer
  deliberately does NOT consume the intuition payload (see Input
  contract).
- **Prompt augmentation
  ([`prompt-augmentation.md`](../prompt-augmentation.md))** -
  phase 2's `<think>` self-doubt block is a new synthetic
  assistant injection, but unlike the priming chain it is
  driven by a post-response verdict and (if we persist the card)
  is a real transcript row rather than an ephemeral one. When
  phase 2 is built, add it to that doc's injection ledger and
  settle its replay semantics there.
- **Samskara ([`samskara.md`](../samskara.md)) / bias profile
  ([`bias-profile.md`](../bias-profile.md))** - phase 3's
  emergent loop feeds `correct` / `reframe` events into these as
  embarrassment substrate. No data flow in v1 or phase 2.
- **Diagnostic pills
  ([`diagnostic-pills.md`](../diagnostic-pills.md))** - second
  thoughts is deliberately NOT a pill (it is per-message). Named
  here so a future editor does not "fix" its absence from the
  column.

## Gotchas (anticipated - fill in as built)

- **A pure reviewer twinging at a good contextual leap is
  correct behavior, not a bug.** The reflex is supposed to doubt
  the asthma paragraph; the deliberation is supposed to overrule
  it. If you "fix" the reviewer to stop doubting contextual
  inferences, you have also blinded it to real projection.
- **Imperative doubt framing destroys good answers.** See "The
  injected doubt MUST permit rejection." The cheap reviewer is
  the blinder model; without an explicit license to reject, the
  smart model rubber-stamps the reviewer's low-context flags.
- **v1 doubt is unresolved by design.** No correction round
  exists yet, so a twinge just displays. Do not read a hanging
  `correct` disposition in v1 as a broken feature.
- **Structured output is the takeover guard, not politeness.**
  If a future change relaxes the reviewer to free-text output,
  the fourth-voice-continuation failure mode comes back.

## Open decisions

**Both remaining decisions are phase 2 and are deliberately
deferred until v1 is built and observed** - the shape of a good
answer here depends on watching real reflex verdicts, so guessing
now would be guessing. Settled: fire policy (every completed turn,
see v1 above).

- **Phase 2 correction bar.** Which dispositions escalate to a
  correction round? Straw proposal: `reframe` + `correct`
  escalate, `hedge` stays display-only. Decide against real v1
  verdicts, not in the abstract.
- **Phase 2 replay semantics.** On future turns, does the model
  replay the original + doubt + correction, the corrected answer
  only, or original + correction without the doubt? Decide once
  the transcript actually has correction rows to reason about.
