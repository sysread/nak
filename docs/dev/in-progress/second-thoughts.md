# Second thoughts (in progress)

> **Status: v1 + phase 2 shipped (the reflex + the user-triggered
> refinement button). Phases 3-4 are still design only.** The reviewer,
> the per-message slide-down, and now the auto-expand + disposition
> button that runs an append refinement turn are built, gated, and
> tested. What remains is the AUTOMATIC correction (phase 3) - and
> whether to build it at all is gated on the phase-2 button's
> click-through data. When that resolves, graduate the durable parts
> (the reflex/deliberation model, the reviewer input contract, the data
> model, the refinement flow) into a permanent
> `docs/dev/second-thoughts.md` and retire this file per the
> in-progress doc rules in `CLAUDE.md`.

**Build status.** Landed (v1 + phase 2):

1. **Data model** - `messages.second_thoughts jsonb`
   (`supabase/schema.sql`), the versioned `{v, disposition, note,
   model, computed_at}` verdict. Replicates on the `supabase_realtime`
   publication (whole-table), so the UPDATE echoes to the browser.
2. **The reviewer agent** -
   `supabase/functions/venice/agents/second_thoughts.ts`
   (`secondThoughtsOnTurnTail`). Loads the turn slice, serializes it
   as a fenced document, calls the fast model (`xiaomi-mimo-v2-5`) via
   `completeJsonObject` (response_format json_object), parses +
   validates the verdict, writes it onto the terminal row. Non-throwing
   throughout. Pure surface (parser + serializer) pinned by
   `supabase/functions/tests/second-thoughts.test.ts`.
3. **Tail wiring** - `getStreamingResponse.ts` calls it FIRST in the
   `terminalKind === 'completed'` waitUntil tail (ahead of
   curation/samskara/reflection), guarded on a committed row.
4. **Browser** - `second_thoughts` on the `Message` type
   (`src/lib/supabase/types/chat.ts`); the coercer + disposition maps
   in `src/lib/ui/second-thoughts.ts` (vitest:
   `tests/second-thoughts.test.ts`); the `SecondThoughtsPanel.svelte`
   slide-down; wired through `AssistantBody.svelte` and both
   `Chat.svelte` call sites. `appendMessage` extended so the reviewer's
   later UPDATE echo merges the verdict onto the already-hydrated row
   (instead of being dropped as a duplicate).

Phase 2 (user-triggered refinement), landed on top of v1:

1. **Primitive** - `dispositionAction` (button label, null for
   conviction) + `buildRefinementThink` (the permit-rejection `<think>`
   builder) in `src/lib/ui/second-thoughts.ts` (vitest-covered).
2. **UI** - `SecondThoughtsPanel` auto-expands an actionable doubt and
   renders the disposition button; `AssistantBody` forwards `onRefine`;
   `Chat.svelte` passes it ONLY for the latest assistant row
   (`latestAssistantId`).
3. **Refinement flow** - `Chat.svelte` `refineFrom` runs one extra
   streaming turn via the existing `runExchange` path: it marks the
   original verdict `acted`, anchors on the original user message with
   NO `supersededIds` (so the new answer APPENDS, commit_assistant_message
   keys on newer user rows only), and skips priming.
4. **Skip-priming plumbing** - `ChatLoopOptions.skipPriming` ->
   `streamCtx.priming.skipPriming` (`venice.ts`) -> the `/stream` body
   (`index.ts`) -> `PrimingInputs.skipPriming` -> an early-return at the
   top of `runServerPriming`. Keeps a refinement from double-firing
   samskara for the round and from burying its own `<think>` doubt.
5. **Acted connective** - `acted` on the verdict + coercer; the
   `mark_second_thoughts_acted` SECURITY DEFINER RPC (`schema.sql`) +
   `SupabaseService.markSecondThoughtsActed`; `toVeniceMessage`
   projects an acted doubt as a `<think>` (via `buildRefinementThink`,
   now worded to permit rejection AND mark supersession); a muted
   "refined" tag in the panel. This is what gives replay its logical
   link between the two answers.

Deferred (design only below): phase 3 (AUTOMATIC correction - the
critical-path relocation) and phase 4 (the emergent samskara/bias
feedback). Whether to build phase 3 at all is gated on the phase-2
click-through data.

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

### phase 2 - the user-triggered refinement (append + button)

The key move: the user, not the system, decides whether a doubt is
worth acting on. On a doubt verdict the panel auto-expands and offers
a button ("Let me temper that", etc.); a click runs a **refinement
turn** that APPENDS a fresh answer below the original. The button is
the safety valve - a low-context reviewer's false flag costs nothing
because a human just doesn't click it. This is a strictly safer
escalation than automatic correction, and it is what phase 2 builds.

Crucially, **this leaves the reviewer exactly where v1 put it**:
detached in the completed-turn tail. The verdict lands on the row as
today; the panel + button are pure UI over that verdict; and the
refinement is a separate, user-initiated turn. So phase 2 touches
**neither the round loop nor the critical path** - it is UI plus one
new "reconsider" turn flow. Details in "The refinement turn" below.

### phase 3 - automatic correction (deferred, gated on data)

The autonomous version: a strong-enough verdict triggers the
refinement WITHOUT a click, before control returns to the user. This
is the phase that would move the reviewer onto the critical path and
touch the round loop - and it is only worth building if the phase-2
click-through data shows the reviewer is trustworthy enough to take
the human out of the loop. How often the user actually clicks the
phase-2 button is precisely that signal. Details deferred; the
critical-path mechanics are sketched under "Automatic correction
(phase 3)" below. `web_search` grounding and the `defer` disposition
are meaningful in both this phase and the phase-2 refinement turn.

### phase 4 - the emergent loop (deferred, maybe organic)

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

## The refinement turn (phase 2)

On a doubt verdict (`hedge` / `reframe` / `correct` - not
`conviction`) the panel **auto-expands** and shows a
disposition-specific **button** whose click runs a **refinement
turn**. The button's voice is the model owning the goof and asking
permission: "I might have goofed; if you agree, let's refine." The
label is disposition-specific (see "Button phrasing" below).

**Append, not replace.** The refinement adds a fresh assistant turn
BELOW the original; it never destroys the original. Two consequences
worth stating because they simplify the build:

- **No separate "second thoughts card" row.** The original row's v1
  panel already carries the note - it *is* the card. The refinement
  is just the next assistant row. Transcript reads `[user] ->
  [assistant: original + its second-thoughts panel] -> [assistant:
  refinement]`.
- **No grey/restore machinery.** Replace (regenerate-from-here) needs
  it because it destroys the original; append destroys nothing, so a
  flopped refinement leaves the original untouched. Closer to "send a
  follow-up on the model's behalf" than to regenerate.

**Mechanism.** The click is browser-initiated (no round-loop change).
`refineFrom` marks the original row's verdict `acted`, then runs a
normal streaming turn via the existing `runExchange` path. The new
assistant row commits appended after the original, anchored to the
SAME user message the original answered. There is no new user message
(the turn is the model reconsidering itself), so the append must not
trip `commit_assistant_message`'s newer-user-message conflict check -
which keys on user rows, not the existing assistant answer. `correct`
verdicts let the refinement reach `web_search` to actually verify.

**The doubt becomes model-visible ONLY when acted - and that is the
`<think>` connective.** This is the load-bearing subtlety, and it
resolves the replay-coherence gap: without it, on any later turn the
model would see two consecutive answers (original, refinement) with no
link explaining the second, and could waffle over which is
authoritative on a dependent question. So `toVeniceMessage`
(`src/lib/chat/prompt-assembly.ts`) projects an `acted` doubt as a
`<think>` block appended to that answer's wire content - built by
`buildRefinementThink`, which frames it to PERMIT rejection ("if the
misgiving doesn't hold, restate and stand by it") AND to mark
supersession ("the reply that follows is my current, considered
answer - prefer it"). One projection serves both moments: it seeds the
refinement turn itself (whose history includes the just-acted row) and
persists into every future replay. An UN-acted doubt is never
projected - it stays a display-only column, invisible to the model
(the same posture as `reasoning`).

**Why `acted` is a server-side RPC, not a client UPDATE.** The
messages-UPDATE RLS policy is scoped to `role='tool'` rows (so a
client can never rewrite assistant/user content), so the browser
cannot flip the flag directly. `mark_second_thoughts_acted`
(SECURITY DEFINER, `schema.sql`) is the narrow write path: it touches
only the `acted` key, only on an assistant row, only when `auth.uid()`
owns the thread. `refineFrom` patches the LOCAL row first (so THIS
turn's wire carries the connective without waiting on the DB) and
fires the RPC best-effort for persistence across reload / device.

### Button phrasing

Disposition-specific, first-person, "let me" - short, because the
panel note already carries the specifics. A UI-behavior primitive
(`dispositionAction` in `src/lib/ui/second-thoughts.ts`) returning
the label, or null for `conviction` (which gets no button and stays
collapsed). Starting set, tunable to taste:

- `hedge` -> "Let me temper that"
- `reframe` -> "Let me re-read your question"
- `correct` -> "Let me double-check that"

The null-for-conviction return is the single gate for BOTH "which
dispositions get a button" and "which auto-expand" - the same
doubt-vs-conviction split the (deleted, now-resurrected) `isDoubt`
helper drew.

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

### Recursion (phase 2: user-gated, so no runaway)

The refinement turn is itself a completed turn, so the v1 tail
reviewer runs on it too and may flag it - showing a button on the
refinement. Under the user-triggered model this is fine, not
runaway: the human gates every step, so a doubt -> refine -> doubt
chain only continues as far as the user keeps clicking. No
automatic ping-pong to bound.

The ping-pong concern is a **phase-3 (automatic)** problem: once
clicks are removed, a cheap reflex re-doubting a smart-tier
refinement could loop on its own. The rule there is **at most one
automatic refinement per user turn - the refined response is
terminal and not itself auto-reviewed** (enforced by an explicit
per-turn flag, with `MAX_ROUNDS = 24` only as the backstop). Do not
let a multi-pass cap default open.

### Automatic correction mechanics (phase 3)

Sketched here so the phase-3 build is not a blank page; NONE of
this is phase 2 (which is browser-triggered and touches neither
the round loop nor the critical path).

**The reviewer moves off the tail and onto the critical path.**
v1 (and phase 2) run the reviewer detached in the `waitUntil` tail
*after* the turn committed. Automatic correction needs the verdict
*before* it decides whether to end the turn, so the reviewer call
relocates INTO `getStreamingResponse`'s flow, at the terminal-round
break (`!roundHadToolCalls`), before the terminal commit. On a
non-escalating verdict the loop breaks and commits as today; on an
escalating verdict it converts the would-be-terminal round into a
non-terminal one (splice `<think>`, continue). This is a big,
delicate change to the round loop - the reason it waits for data.

**It puts reviewer latency on the critical path, every turn.** The
pause before END now includes the reviewer round-trip (plus, on the
correction branch, a `web_search` call and a refinement round).
Surface it as a **Reconsidering** row on the in-flight bubble's
priming checklist. Two mitigations that did not matter in v1/phase
2: run the reviewer with thinking disabled (it is a reflex, now in
the latency path), and give it a timeout that falls back to "no
escalation" so a slow reviewer degrades to shipping the original
rather than hanging the turn (mirror `SAMSKARA_PRIMING_TIMEOUT_MS`
in `priming.ts`).

**web_search grounding + `defer`.** Applies to BOTH the phase-2
refinement turn and phase-3 auto: a `correct` verdict lets the
refinement reach the existing `web_search` path (`toolComplete`
with `enable_web_search`, returning `{answer, citations}`) to
actually verify, and its citations persist on the refinement row.
This is the only place the `defer` disposition ("cannot resolve
without asking the user") becomes meaningful, so `defer` enters the
disposition set when phase 2 lands, not before.

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
  next to curation/samskara/reflection. Phase 2 (user-triggered
  refinement) reuses the browser send/regenerate flow to run one
  extra streaming turn that APPENDS a new assistant row anchored to
  the original user message; it touches the send path,
  `commit_assistant_message`'s anchor handling (append does not
  conflict - the check keys on user rows), and `toVeniceMessage`
  (which now projects an `acted` doubt as a `<think>` connective),
  but NOT the round loop. The `acted` flag is persisted via the
  `mark_second_thoughts_acted` SECURITY DEFINER RPC (the client
  cannot UPDATE assistant rows under RLS). Only phase 3 (automatic)
  hooks the terminal-round break.
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
- **A doubt on an OLD assistant row has no button - that is
  correct, not a missing feature.** The refinement appends at the
  transcript tail, so it can only reconsider the LATEST answer;
  `Chat.svelte` passes `onRefine` (and thus the auto-expand +
  button) only for `latestAssistantId`. Older rows keep their
  verdict for display but no action.
- **A refinement writes a second samskara substrate row for the
  same user message.** The chat-loop's end-of-turn substrate stub
  pairs the anchor user message with the terminal assistant row;
  a refinement anchors on the original user message, so its stub
  is a second pairing for that message. Tolerated: substrate
  `user_message_id` is a soft pointer the samskara design already
  accepts going off-by-N (see the delete-from-here gotcha in
  `chat.md`). Priming's samskara *fire* is NOT double-counted -
  `skipPriming` suppresses it.
- **Structured output is the takeover guard, not politeness.**
  If a future change relaxes the reviewer to free-text output,
  the fourth-voice-continuation failure mode comes back.

## Open decisions

Settled by the user-triggered-append pivot:

- **Fire policy** - every completed turn (see v1 above).
- **Which dispositions get the button** - all three doubts (`hedge`
  / `reframe` / `correct`); `conviction` gets none. The human gates
  each click, so a generous button set is safe - a false flag just
  goes unclicked.
- **Replay semantics** - resolved to *keep both answers; the doubt is
  visible to the model ONLY when acted*. Append keeps the original and
  the refinement in the transcript. An un-acted doubt stays a
  display-only column (invisible to the model). An ACTED doubt is
  projected as a `<think>` connective on the original answer's wire
  content (see "The doubt becomes model-visible" above), so the model
  understands why there are two answers and treats the refinement as
  authoritative rather than waffling on dependent turns.

Still open, and genuinely gated on data:

- **Whether to build phase 3 (automatic correction) at all**, and
  its escalation bar if so. The phase-2 button's **click-through
  rate** is the signal: if the user routinely clicks on `correct`
  flags and the refinements land, automatic correction on that
  disposition is earning its keep; if the user rarely clicks, or the
  refinements often come back worse, automatic is not warranted and
  the human-gated button is the right permanent home. Do not start
  phase 3 before this data exists.
- **Button phrasing** - the starting labels ("Let me temper that",
  etc.) are a taste call the user owns; retune as the personality
  settles.
