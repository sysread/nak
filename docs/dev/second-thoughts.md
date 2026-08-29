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

The asymmetry is the point: **the doubt needs far less context than the
answer to the doubt does.** This is what lets the reviewer stay cheap
and narrow (below) without destroying the contextual inference nak
exists to produce - the reflex is *allowed* to twinge at a leap whose
basis is genuinely invisible to it, because the deliberation is where
that twinge gets adjudicated and, most often, overruled. The reviewer
is not allowed to twinge at a leap grounded in the visible thread; see
the background window below.

Worked example (the case this feature must not regress). User has
asthma; days later, in a THREAD THAT NEVER MENTIONS IT, asks "do any
Colorado fires threaten Colorado Springs?" The model correctly weaves
in an N95 precaution keyed to the asthma history. The reviewer sees no
asthma anywhere - not in the exchange, not in the background window -
so it may twinge: "the user didn't mention asthma - projection?" That
is the reflex working, and the deliberation, with the full history,
answers "warranted - stand by it." Suppressing the twinge entirely
would blind the reflex to real projection; letting the reflex *rewrite*
unadjudicated would strip the best part of the answer.

The near-identical case that is NOT allowed to twinge: the asthma came
up earlier *in this thread*. Then it sits in the background window, and
a doubt there is pure noise - the reviewer is contradicting the visible
record. The background window exists to separate these two, because
without it they are indistinguishable and the reflex flags both.

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
`curateOnTurnTail` / `samskaraOnTurnTail` also run,
and only on `terminalKind === 'completed'`. Detached, so it adds zero
latency to the user-visible turn. Best-effort and non-throwing: a
failure leaves the row without a verdict, never breaks the turn.

**Fires on every completed turn**, ungated. Gating "is this worth
doubting?" would need a completion that reads the turn - which is the
reflex itself, so a gate is a false economy. `conviction` (the common
verdict) is the cheap-and-quiet outcome, not a skipped pass.

### Input contract: one turn reviewed, a little background

The reviewer **reviews** only the most recent user message plus the LLM
messages that follow it in the same turn - the assistant response
(content **and** reasoning) plus any tool calls and their result rows,
fenced as `<exchange_under_review>`.

It does NOT see the pregame priming chain (intuition / samskara /
context-recall `<think>` blocks). That exclusion is the load-bearing
one, for two reasons:

- **Independence.** A reviewer that replays the author's inner
  monologue shares the frame that produced the answer, so it
  rationalizes instead of doubting. Excluding the priming chain forces
  a genuinely *second* look, and is the only way the reflex catches the
  case where the priming itself steered the answer wrong.
- **Fidelity to the reflex.** The gut twinge is low-context by nature.

It DOES see a short **background** window: the last
`BACKGROUND_ROWS` (6) user/assistant messages before the anchor,
content only, each clipped to `MAX_BACKGROUND_CHARS` (600), plus the
source URLs any tool returned across that same window, in a separate
`<conversation_so_far>` fence that the prompt marks as
not-under-review. Background is a different thing from the priming
chain - it is the public record of the conversation, not the author's
inner monologue, so it costs nothing on the independence axis.

Reviewing with *zero* history made the reflex fabricate discrepancies,
which is the failure mode that dominated real doubts: a thread moves
from topic A to topic B, the answer legitimately carries an A detail
forward, and a reviewer who can only see the B exchange reports "I
referred to A but there is no evidence of A." Every such doubt is
noise, and noise is what makes the panel worth ignoring. The background
block turns those into `conviction` while leaving genuine projection -
a reference to something in NEITHER block - still flaggable, though the
prompt tells the reviewer to assume unshown-but-uncontradicted material
came from context it cannot see (cross-thread memory, samskara, stored
notes) and to doubt only an outright CONTRADICTION of what the user
said in this exchange. On a first turn the block is omitted entirely,
so the prompt is unchanged from the no-background shape.

Including the assistant's **reasoning** in the reviewed slice makes the
reviewer sharper, not blinder: it weighs the model's own stated
justification ("they have asthma, so N95 advice is relevant") rather
than guessing intent from the prose alone. Background carries no
reasoning - it establishes what was said, nothing more.

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

Easy-task tier - `z-ai-glm-5-3-flash` with the thinking pass disabled,
the same id `web_search` / `summary` / `topics` use. The reflex is dumb
and fast by design, so intuition's model rationale applies verbatim:
latency is what matters, reasoning is actively wrong here - the model
can reason, so the disable pin at the call site is load-bearing. A reasoning
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
standard stage. The refinement is no longer the flag's only caller -
the quick-send button shares it, without a doubt note, so its turn
runs nothing at all (see [`prompt-augmentation.md`](./prompt-augmentation.md),
"Deliberate full skips").

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
  `secondThoughtsOnTurnTail`, the reviewer: the turn-slice +
  background loader (`loadTurnContext`), the two fenced serializers
  (`serializeExchange`, `serializeBackground`), the provenance
  preservers (`extractUrls`, `verifiedQuotes`), the system prompt, the
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

- **The reviewer reviews the turn slice only** - the most recent user
  message and the assistant/tool rows that follow it (with reasoning),
  serialized as a fenced document, plus a clipped
  `<conversation_so_far>` background block it is told not to review.
  **No priming chain, ever.** Changing this changes what "doubt" means.
- **Evidence the truncation hides must be preserved, not restored by
  raising caps.** Source URLs and verbatim-confirmed quotations ride
  the transcript as summary lines; provenance survives independent of
  how long a tool result is.
- **The reviewer never blocks or fails a turn.** Best-effort, detached,
  non-throwing.
- **A verdict is additive metadata on a committed row.** The reviewer
  writes only the `second_thoughts` column; the refinement is the only
  thing that writes new rows (appended, never replacing).
- **The injected doubt is advisory.** `buildRefinementThink` must
  always preserve the explicit permission to stand by the original.

## Interactions

- **Chat ([`chat.md`](./chat.md))** - the reviewer is a turn-tail unit
  next to curation/samskara. The refinement reuses the
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
  ([`bias-profile.md`](./bias-profile.md))** - data flows in BOTH
  directions with samskara, on opposite sides of the turn. Out: a
  refinement `skipPriming` suppresses samskara's situational COHORT
  fire for that turn (it is not a new user round), but the refinement
  gets the read-only doubt-keyed probe described above. In: the
  samskara assimilator reads the assistant row's doubt verdict when
  enriching that round's substrate (`assistant_second_thoughts` in the
  assimilator payload - the embarrassment-event feed; see samskara.md's
  Assimilate contract), so repeated misgivings shape the user model.
  The reviewer itself still consumes nothing samskara-shaped (the
  independence contract). The bias-profile half of the emergent
  feedback (below) remains deferred.
- **Diagnostic pills ([`diagnostic-pills.md`](./diagnostic-pills.md))**
  - second thoughts is deliberately NOT a pill (it is per-message).
  Named here so a future editor does not "fix" its absence.

## Gotchas

- **Truncating a tool result must never hide the evidence for what the
  answer cited.** The slice caps each tool result at
  `MAX_TOOL_RESULT_CHARS` (4k), but a `web_search` result runs ~14k
  chars, so most of its substance is invisible. Anything the assistant
  drew from the cut portion looks unsupported, and the reviewer reports
  correctly-sourced material as invented. This has now bitten twice, in
  two fields: first URLs, then quoted text. Both are handled by
  preserving the evidence rather than raising the cap:
  `serializeExchange` appends every URL from the FULL content
  (`extractUrls`) as a "source URLs this tool returned" line, and
  `verifiedQuotes` mechanically confirms the assistant's quoted spans
  against the FULL untruncated results, echoing the confirmed ones back
  as a "quotations confirmed verbatim" line the prompt tells the
  reviewer to treat as settled. **Any new provenance-bearing tool shape
  needs the same treatment** - assume the reviewer will flag whatever
  the truncation hides.
- **An unmatched quote is never reported as suspect.** `verifiedQuotes`
  is a one-way check: a match is proof of provenance, a non-match is
  nothing. The assistant may be quoting the user, or a paraphrase may
  have defeated the substring match, and a "these quotes were NOT
  found" line would manufacture exactly the doubt this feature is
  trying to stop. Only whitespace is normalized before matching -
  anything looser starts confirming quotes no tool returned, which is
  worse than confirming none.
- **Prior turns' tool results are gone, but their URLs are not.** A
  turn that cites a page found two turns ago has no tool row in the
  slice at all. `loadTurnContext` collects source URLs from tool rows
  across the background window into `backgroundUrls`, rendered as one
  line inside `<conversation_so_far>`. Without it the background
  window's own effect makes things worse: the reviewer sees the claim
  carried forward but not what sourced it.
- **A reviewer twinging at a leap it genuinely cannot see the basis
  for is correct behavior, not a bug.** The reflex is supposed to doubt
  a cross-thread asthma inference; the refinement is supposed to
  overrule it. "Fixing" the reviewer to stop doubting contextual
  inferences outright also blinds it to real projection. Doubting
  something the BACKGROUND window plainly contains is the actual bug,
  and is what the window and the prompt's grounding check exist to
  prevent - if that class of false positive comes back, widen or fix
  the background block, do not mute the disposition.
- **Background is not the priming chain and must never become it.**
  Widening the window is a tuning knob; feeding the reviewer intuition
  / samskara / context-recall `<think>` blocks breaks the independence
  contract and turns the reflex into a rationalizer.
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

Extensions designed but deliberately not built. The full design
narrative (and the reasoning that got here) lives in git history, in
the `docs/dev/in-progress/second-thoughts.md` this doc graduated
from.

- **Automatic correction.** The autonomous version: a strong-enough
  verdict triggers the refinement WITHOUT a click, before control
  returns to the user. It would move the reviewer onto the critical path
  and hook the round loop's terminal-round break - a big, delicate
  change. Gated on data: whether the user routinely clicks the
  user-triggered button (the click-through rate is the demand signal).
  If refinements are rarely wanted, or often come back worse than the
  original, the human-gated button is the right permanent home and this
  is never built.
- **The bias-profile half of the emergent loop.** The samskara half is
  BUILT: doubt verdicts ride the assimilator payload and colour
  substrate (see Interactions), so learned doubt patterns can reach the
  compound summary and future mints on their own. Still deferred:
  feeding embarrassment events into the bias profile so the model's
  doubt disposition tunes its baseline confidence directly.
  Deliberately not a dedicated diagnostic pill either way: if the loop
  works, the emergence should show up secondarily in mood and bias
  calibration on its own.
