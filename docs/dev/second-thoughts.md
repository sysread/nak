# Second thoughts

A self-doubt reflex on the chat model. After a response finishes, a
fast pass re-reads what the model just said and reports a *felt
confidence* - stands behind it, or something feels off. A doubt
surfaces on the message as a small panel; the user can then let the
model take another pass at the answer.

The framing is psychological, not mechanical. Nak models human mental
processes to see whether many small LLM passes can *emerge* into
something that reads as contextual and less sycophantic (see
[`architecture.md`](./architecture.md) and the sibling subconscious
features). An LLM is a plausibility engine; humans are too, but
self-doubt and the memory of having been wrong make us re-check before
we speak. Second thoughts is that re-check. It is the post-game
metacognitive twin of [intuition](./intuition.md)'s pre-game
subconscious.

## Role in the app: reflex vs deliberation

The load-bearing design decision, from which everything else falls out:
**doubt and the resolution of doubt are two different mental motions,
modeled as two separate passes with opposite properties.**

- **The reflex (the reviewer).** Fast, cheap, low-context. The 2am
  "wait - was it weird that I brought up asthma?" It does NOT replay
  the reasoning that produced the answer; it is a gut twinge over a
  deliberately narrow slice of the turn. Runs automatically on every
  completed turn.
- **The deliberation (the refinement).** Slow, smart, full-context.
  The considered "no, it's fine - I know they have asthma, stand by
  it" (or "actually that acreage was a guess - let me check"). Runs on
  the thread's own tier with everything it normally sees, and can call
  `web_search`. Triggered by the user, not the system.

The asymmetry is the point: **the doubt does not need the context; the
answer to the doubt does.** This is what lets the reviewer stay pure
and narrow (below) without destroying the contextual inference nak
exists to produce - the reflex is *allowed* to twinge at a good
contextual leap, because the deliberation is where that twinge gets
adjudicated and, most often, overruled.

Worked example (the case this feature must not regress). User has
asthma; days later asks "do any Colorado fires threaten Colorado
Springs?" The model correctly weaves in an N95 precaution keyed to the
asthma history. A pure reviewer, seeing only this turn, *should*
twinge: "the user didn't mention asthma - projection?" That is the
reflex working. The deliberation, with the full history, answers:
"warranted - stand by it." Suppressing the twinge would blind the
reflex to real projection; letting the reflex *rewrite* unadjudicated
would strip the best part of the answer. Two passes, opposite context
budgets, resolves both.

**Not a pre-finalization gate.** The response streams token-by-token to
the browser as Venice emits it, so by the time it is complete the user
has already read it - there is no "generated but not yet shown" holding
pen. Second thoughts is therefore explicitly a *post-response* feature:
it displays doubt after the fact and can append a refinement as a
follow-on turn, but never blocks the original reply from reaching the
user live.

## The reviewer

Runs as a turn-tail unit (`secondThoughtsOnTurnTail`), FIRST in the
`EdgeRuntime.waitUntil` tail of `getStreamingResponse.ts` where
`curateOnTurnTail` / `samskaraOnTurnTail` / `reflectOneThread` also run,
and only on `terminalKind === 'completed'`. Detached, so it adds zero
latency to the user-visible turn. Best-effort and non-throwing: a
failure leaves the row without a verdict, never breaks the turn.

**Fires on every completed turn**, ungated. Gating "is this worth
doubting?" would need a completion that reads the turn - which is the
reflex itself, so a gate is a false economy. `conviction` (the common
verdict) is the cheap-and-quiet outcome, not a skipped pass.

### Input contract: pure and narrow

The reviewer sees **only** the most recent user message plus the LLM
messages that follow it in the same turn - the assistant response
(content **and** reasoning) plus any tool calls and their result rows.
It does NOT see the pregame priming chain (intuition / samskara /
context-recall `<think>` blocks) or prior conversation history. Two
reasons:

- **Independence.** A reviewer that replays the author's inner
  monologue shares the frame that produced the answer, so it
  rationalizes instead of doubting. Excluding the priming chain forces
  a genuinely *second* look, and is the only way the reflex catches the
  case where the priming itself steered the answer wrong.
- **Fidelity to the reflex.** The gut twinge is low-context by nature.

Including the assistant's **reasoning** in the slice makes the reviewer
sharper, not blinder: it weighs the model's own stated justification
("they have asthma, so N95 advice is relevant") rather than guessing
intent from the prose alone.

### Guarding against conversational takeover

Replaying a conversation as role-tagged messages makes the model want
to *continue* it - answering as a fourth voice instead of reviewing.
Three layered defenses:

1. **Separate completion with a reviewer system prompt** - an agent
   whose whole job is the meta-task, a sibling to `summary` / `bias` /
   `topics` under `venice/agents/`.
2. **The slice is serialized as one fenced document** inside a single
   user message, not replayed as role-tagged turns. Handed a fenced
   `<exchange_under_review>` document the model analyzes instead of
   continuing (same reason the chat path fences the user turn - see
   [`chat.md`](./chat.md)).
3. **Structured output** (`response_format: json_object`) leaves no
   schema slot for a conversational reply. The hard guard; 1 and 2 keep
   quality up.

### Model

Fast, **non-reasoning** instruct tier - `mistral-small-3-2-24b-instruct`,
the same id `web_search` / `summary` / `topics` use, chosen because it
reliably honors `response_format: json_object`. The reflex is dumb and
fast by design, so intuition's model rationale applies verbatim:
latency is what matters, reasoning is actively wrong here. A reasoning
model leaks chain-of-thought around the JSON, which in production
dropped ~60% of verdicts and every doubt (the empty-note `conviction`
survived the parser; longer doubt notes came back messy and failed it).
The parser keeps a balanced-brace fallback (`extractJsonObject`) so a
stray wrapping token can never again silently drop a verdict. Held
directly in `second_thoughts.ts` (not `src/lib` `AGENT_MODELS`) because
this agent runs only server-side, like the curation / bias / samskara
agents.

### Output: the disposition spectrum

Structured `{ disposition, note }`:

- `conviction` - stands behind it, framing and facts. The common case;
  displayed as nothing (see UI).
- `hedge` - fine but overconfident; a caveat is missing.
- `reframe` - may have misread the question or the person.
- `correct` - suspects a factual error.

`note` is the first-person voicing of the twinge. The reviewer has no
prior context, so `correct` means "I suspect this is wrong," not
"verified wrong" - verification happens in the refinement, which can
reach `web_search`.

## The refinement (user-triggered)

On a doubt verdict the panel auto-expands and shows a
disposition-specific button ("Let me temper that" / "Let me re-read
your question" / "Let me double-check that"); a click runs a
**refinement turn**. The button is the safety valve - a low-context
reviewer's false flag costs nothing because the human just doesn't
click it.

**Append, not replace.** The refinement adds a fresh assistant turn
BELOW the original; it never destroys it. Two consequences: no separate
"card" row is needed (the original's own panel is the card), and no
grey/restore machinery is needed (a flopped refinement leaves the
original untouched). Transcript reads `[user] -> [assistant: original +
its panel] -> [assistant: refinement]`.

**Mechanism.** `Chat.svelte` `refineFrom` runs one extra streaming turn
via the existing `runExchange` path. It marks the original verdict
`acted`, anchors on the SAME user message the original answered with NO
`supersededIds` (so the new row APPENDS - `commit_assistant_message`'s
conflict check keys on newer *user* rows, not the existing assistant
answer), and skips standard priming (getting the targeted samskara
probe instead - next section). Offered only on the thread's LATEST
assistant row (`latestAssistantId`), since a refinement always lands at
the transcript tail. Touches neither the round loop nor the critical
path.

**Skip-priming, plus the doubt-keyed samskara probe.** A refinement is
the model reconsidering itself, not a new user round, so re-running the
user-round-keyed priming would double-fire the samskara situational
cohort and bury the refinement's own `<think>` doubt.
`ChatLoopOptions.skipPriming` threads through
`streamCtx.priming.skipPriming` (`venice.ts`) -> the `/stream` body
(`index.ts`) -> `PrimingInputs.skipPriming` -> `runServerPriming`,
which routes the turn to `runRefinementPriming` instead of the
standard stage.

What the refinement DOES get is the deliberation's share of context:
the design asymmetry is "the doubt does not need the context; the
answer to the doubt does," and cross-thread samskara knowledge is
exactly the context a full-context adjudication is otherwise missing
(the priming `<think>` chain is never persisted, so a refinement
cannot inherit the original turn's fire from history).
`refinementDoubtNote` - the reviewer's raw first-person note, threaded
alongside `skipPriming` from `refineFrom` - keys ONE read-only samskara
probe (`queryFiredSamskaras`: embed + top-k + score floor, NO cohort
write) against the doubt plus the original user text, under the same
1500ms race cap as the standard fire. Whatever fires is spliced as a
single `<think>` block (`formatRefinementFireThink`) framed as
evidence for weighing the misgiving, after the acted doubt in wire
order. Read-only on purpose: the original turn's fire remains the
round's only samskara bookkeeping, so fire_count, co-fire detection,
and the evaluation judge still see one fire per user round. An empty
note (or an old client that sends `skipPriming` alone) skips the
probe entirely.

### The acted `<think>` connective

**A doubt becomes model-visible ONLY when acted.** Without a link,
later turns would see two consecutive answers (original, refinement)
with no explanation for the second and could waffle over which is
authoritative on a dependent question. So `toVeniceMessage`
(`src/lib/chat/prompt-assembly.ts`) projects an `acted` doubt as a
`<think>` block appended to that answer's wire content, built by
`buildRefinementThink`. One projection serves both moments: it seeds
the refinement turn itself (whose history includes the just-acted row)
and persists into every future replay. An UN-acted doubt is never
projected - it stays a display-only column, invisible to the model (the
same posture as `reasoning`).

**The `<think>` MUST permit rejection.** The block is advisory
misgiving, never an instruction to comply. `buildRefinementThink`
frames it to both PERMIT rejection ("if the misgiving doesn't hold,
restate and stand by it") AND mark supersession ("the reply that
follows is my current, considered answer - prefer it"). This is the
single most important prompt constraint: the reviewer is a cheap,
low-context model second-guessing a smart, full-context one, so an
imperative "fix these errors" framing makes the strong model dutifully
"fix" things that were never broken - disproportionately the contextual
inferences that make nak good. The permission to reject is what lets
the full-context author overrule the low-context reflex.

**Why `acted` is a SECURITY DEFINER RPC, not a client UPDATE.** The
messages-UPDATE RLS policy is scoped to `role='tool'` rows so a client
can never rewrite assistant/user content. `mark_second_thoughts_acted`
(`schema.sql`, granted to `authenticated`) is the narrow write path: it
touches only the `acted` key, only on an assistant row, only when
`auth.uid()` owns the thread. `refineFrom` patches the LOCAL row first
(so this turn's wire carries the connective without waiting on the DB)
and fires the RPC best-effort for persistence across reload / device.

## Files

- `supabase/functions/venice/agents/second_thoughts.ts` -
  `secondThoughtsOnTurnTail`, the reviewer: turn-slice loader, the
  fenced serializer (`serializeExchange`), the system prompt, the
  `completeJsonObject` call, and the verdict parser (`parseVerdict` +
  `extractJsonObject`). Pure surface pinned by
  `supabase/functions/tests/second-thoughts.test.ts`.
- `supabase/functions/venice/getStreamingResponse.ts` - calls the
  reviewer first in the completed-turn tail.
- `supabase/functions/venice/priming.ts` - `PrimingInputs.skipPriming`
  and `refinementDoubtNote`, plus `runRefinementPriming`, the
  refinement's doubt-keyed samskara probe.
- `supabase/functions/venice/priming/samskara.ts` /
  `priming/samskara-format.ts` - `queryFiredSamskaras` (the read-only
  fire half the probe calls) and `formatRefinementFireThink` (the
  probe's `<think>` body).
- `supabase/schema.sql` - the `messages.second_thoughts` column and the
  `mark_second_thoughts_acted` RPC.
- `src/lib/ui/second-thoughts.ts` - the coercer + the pure
  disposition-to-display maps (`isDoubt`, `dispositionTone` / `Icon` /
  `Label` / `Headline`, `dispositionAction`, `displayNote`) and
  `buildRefinementThink`. vitest: `tests/second-thoughts.test.ts`.
- `src/components/SecondThoughtsPanel.svelte` - the per-message
  slide-down + refinement button.
- `src/components/AssistantBody.svelte` - mounts the panel (gated on
  `isDoubt`) and forwards `onRefine`.
- `src/screens/Chat.svelte` - `refineFrom`, `latestAssistantId`, the
  `onRefine` wiring, `scheduleVerdictBackfill`, and the `appendMessage`
  merge that lands the verdict's realtime echo.
- `src/lib/chat/prompt-assembly.ts` - `toVeniceMessage`'s acted-doubt
  `<think>` projection.
- `src/lib/chat/types.ts` / `src/lib/chat/loop.ts` / `src/lib/venice.ts`
  - the `skipPriming` plumbing.
- `src/lib/supabase.ts` - `markSecondThoughtsActed`.

## Data model

One jsonb column on `messages`, sibling to `usage` / `reasoning` /
`citations`:

```ts
{
  v: 1,
  disposition: 'conviction' | 'hedge' | 'reframe' | 'correct',
  note: string,        // first-person voicing of the twinge
  model: string,       // reviewer model id, provenance
  computed_at: number, // ms since epoch
  acted?: boolean,     // set by the browser RPC when the user refines
}
```

1:1 with the assistant row it reviews; cascades on delete-from-here and
regenerate for free (anchored to a real durable row, so no round-id
staleness like intuition's thread-row cache). Loosely typed at the row
layer; the browser coercer (`coerceSecondThoughts`) owns the parse - a
drifting shape reads as "no verdict" rather than crashing the card.

## UI

A per-message slide-down (NOT a global diagnostic pill; global
diagnostics reflect conversation-current state, per-message analytics
live on the message). In the `AssistantBody` neighborhood alongside the
reasoning and tool-call panels.

**The panel renders ONLY for a doubt.** `AssistantBody` gates the mount
on `isDoubt(disposition)`; `conviction` shows nothing. The reviewer
still runs on every turn and the verdict still persists - purely a
display gate. At the ~95%+ conviction base rate a good model produces,
a calm row on every fine answer is chrome, and a doubt tracks answer
quality (it fires on sloppy models, stays quiet on good ones), so a
visible panel should always *mean* something. **Consequence: an absent
panel means "reviewed, no doubt" (or, rarely, the reviewer wrote
nothing) - it does NOT mean "not reviewed."**

Per the [frontend split](./frontend-organization.md) the
disposition-to-display maps are pure primitives in
`src/lib/ui/second-thoughts.ts`; the `.svelte` files hold only
composition + wiring.

## Contracts

- **Reviewer input is the turn slice only** - the most recent user
  message and the assistant/tool rows that follow it (with reasoning),
  serialized as a fenced document. No priming chain, no prior history.
  Changing this changes what "doubt" means.
- **The reviewer never blocks or fails a turn.** Best-effort, detached,
  non-throwing.
- **A verdict is additive metadata on a committed row.** The reviewer
  writes only the `second_thoughts` column; the refinement is the only
  thing that writes new rows (appended, never replacing).
- **The injected doubt is advisory.** `buildRefinementThink` must
  always preserve the explicit permission to stand by the original.

## Interactions

- **Chat ([`chat.md`](./chat.md))** - the reviewer is a turn-tail unit
  next to curation/samskara/reflection. The refinement reuses the
  browser send/regenerate flow for one extra APPEND turn anchored to the
  original user message; it touches the send path,
  `commit_assistant_message`'s anchor handling (append does not conflict
  - the check keys on user rows), and `toVeniceMessage` (the acted-doubt
  `<think>` projection), but not the round loop.
- **Intuition ([`intuition.md`](./intuition.md))** - the metacognitive
  twin on the other side of the completion. Intuition is pre-game,
  global, ephemeral (one overwritten thread-row cache); second thoughts
  is post-game, per-message, persistent - opposite persistence shapes,
  which is why it is a sibling feature, not an extension. The reviewer
  deliberately does NOT consume the intuition payload.
- **Prompt augmentation
  ([`prompt-augmentation.md`](./prompt-augmentation.md))** - the acted
  `<think>` connective is a turn-time injection driven by a
  post-response verdict, distinct from the pregame priming chain.
- **Samskara ([`samskara.md`](./samskara.md)) / bias profile
  ([`bias-profile.md`](./bias-profile.md))** - a refinement `skipPriming`
  suppresses samskara's situational COHORT fire for that turn (it is not
  a new user round), but the refinement gets the read-only doubt-keyed
  probe described above - samskara-to-deliberation is the one live data
  flow. The reviewer itself still consumes nothing samskara-shaped (the
  independence contract). The reverse flow (doubt verdicts feeding
  samskara substrate - the emergent feedback below) is deferred.
- **Diagnostic pills ([`diagnostic-pills.md`](./diagnostic-pills.md))**
  - second thoughts is deliberately NOT a pill (it is per-message).
  Named here so a future editor does not "fix" its absence.

## Gotchas

- **Truncating a tool result must never hide its source URLs.** The
  slice caps each tool result at `MAX_TOOL_RESULT_CHARS` (4k), but a
  `web_search` result runs ~14k chars with citation URLs deep in the
  list. Cutting the body dropped a cited URL, and the reviewer then
  wrongly flagged a legitimately-sourced URL as fabricated - the model
  DID cite it; the reviewer just couldn't see the source.
  `serializeExchange` appends every URL from the FULL content
  (`extractUrls`) as a "source URLs this tool returned" line, and the
  prompt tells the reviewer that a URL in any tool result is
  legitimately sourced. Preserve key evidence past truncation for any
  new provenance-bearing tool shape.
- **A pure reviewer twinging at a good contextual leap is correct
  behavior, not a bug.** The reflex is supposed to doubt the asthma
  paragraph; the refinement is supposed to overrule it. "Fixing" the
  reviewer to stop doubting contextual inferences also blinds it to
  real projection.
- **Imperative doubt framing destroys good answers.** Without an
  explicit license to reject, the smart model rubber-stamps the cheap
  reviewer's low-context flags. See the permit-rejection contract.
- **The verdict's live delivery has a re-fetch backstop.** The verdict
  reaches the open tab via the messages UPDATE realtime echo, which
  Supabase realtime occasionally drops.
  `Chat.svelte` `scheduleVerdictBackfill` fires one delayed `getMessage`
  (~20s, past observed reviewer latency) for each completed terminal row
  (gated on `status==='complete'` in `onAssistantPersisted`) and merges
  the verdict if the echo missed it; no-op otherwise. The DB row is
  always correct, so a still-slower reviewer just needs a manual
  refresh.
- **A doubt on an OLD assistant row has no button** - the refinement
  appends at the tail, so only `latestAssistantId` is refinable. Older
  rows keep their verdict for display but no action.
- **A refinement writes a second samskara substrate row** for the same
  user message (its stub anchors on the original user message).
  Tolerated: substrate `user_message_id` is a soft pointer the samskara
  design already accepts going off-by-N. The samskara *fire* is not
  double-counted: `skipPriming` suppresses the cohort fire, and the
  refinement's doubt-keyed probe is read-only (no cohort recorded).
- **Structured output is the takeover guard, not politeness.** Relaxing
  the reviewer to free-text output brings back the
  fourth-voice-continuation failure mode.

## Deferred / future work

Two extensions were designed but deliberately not built. The full
design narrative (and the reasoning that got here) lives in git
history, in the `docs/dev/in-progress/second-thoughts.md` this doc
graduated from.

- **Automatic correction.** The autonomous version: a strong-enough
  verdict triggers the refinement WITHOUT a click, before control
  returns to the user. It would move the reviewer onto the critical path
  and hook the round loop's terminal-round break - a big, delicate
  change. Gated on data: whether the user routinely clicks the
  user-triggered button (the click-through rate is the demand signal).
  If refinements are rarely wanted, or often come back worse than the
  original, the human-gated button is the right permanent home and this
  is never built.
- **The emergent loop.** A `correct` / `reframe` is an *embarrassment
  event* - the same class of signal samskara and the bias profile
  consume. Feeding it into them would let the model's learned doubt
  disposition tune its own future baseline confidence. Deliberately not
  a dedicated diagnostic pill: if the loop works, the emergence should
  show up secondarily in mood and bias calibration on its own.
