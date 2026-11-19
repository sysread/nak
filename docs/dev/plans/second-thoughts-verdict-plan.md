# Second-Thoughts Verdict via Decision Model (B2)

Status: PLANNED 2026-11-19 (branch second-thoughts-verdict, base
196fb594 = landed B1). Research round done (feature mapped end to
end); refinement rounds not started. Citations are
research-verified; the refinement reviewer re-verifies.

## SYNOPSIS

Convert the second-thoughts doubt reflex's DISPOSITION VERDICT to a
Decisions API call: one `clef-api` `choice` question per completed
turn ("how do these second thoughts land?") replaces the per-turn
chat completion for the verdict. The prose `note` - the only part
needing generation - becomes a small chat call that runs ONLY when
the disposition is a doubt (hedge / reframe / correct), which is
rare by design. The persisted shape, the browser coercer, the
panel, the samskara assimilation, and the deliberation flow all
keep their contracts unchanged.

## BACKGROUND

The reflex (`venice/agents/second_thoughts.ts`) runs FIRST in the
completed-turn tail (`getStreamingResponse.ts:1613-1635`), reviews
only the turn slice + a background fence (anti-fourth-voice guard,
`second_thoughts.ts:38-45`), and writes
`{v:1, disposition, note, model, computed_at}` to
`messages.second_thoughts` (`:664-676`).

Today it is ONE chat completion per turn: 512 output tokens,
thinking pinned off, cheapest model (`second_thoughts.ts:654-656`),
observed ~5s typical / ~12s max reviewer latency
(`Chat.svelte:1840-1841`). The whole delivery apparatus - the
realtime echo merge (`Chat.svelte:1814-1827`) and the 20s backfill
re-fetch (`:1831-1869`) - exists because the verdict is slow and
lossy. The persisted shape's `note` is load-bearing: an acted
doubt's note projects into every future replay as a `<think>` block
(`prompt-assembly.ts:725-737`), seeds the refinement turn
(`Chat.svelte:6245-6249`), and feeds the samskara assimilator
(`samskara.ts:434-462`).

The conversion's premise (research-verified): conviction is
write-only data - nothing in either runtime reads a conviction
verdict beyond the `isDoubt` gate that hides the panel - and the
note is already optional-by-convention exactly along B2's seam: the
prompt instructs an empty string for conviction, and the UI has
fallback copy for an empty-note doubt (`src/lib/ui/second-thoughts.ts:159-164`).

The Decisions API (landed: `veniceDecision`) answers a `choice`
question - the pick plus every option's probability plus a
confidence - in ~360ms. The CoT-leak failure class that killed the
xiaomi experiment (`second_thoughts.ts:58-71`: ~40% usable
verdicts) is structurally impossible: the decision model emits no
chain to leak.

## DECISIONS (proposed - refinement may amend)

- **D1 - The decision call owns the verdict; the chat call owns
  only the doubt note.** Per turn: one `clef-api` `choice` question
  over the SAME serialized turn slice + background fence the
  current prompt reads (`serializeExchange` / `serializeBackground`
  reused verbatim). On doubt: one small chat completion writes the
  1-2 first-person note sentences. On conviction: write the row
  with `note: ''` and stop - no chat call at all.
- **D2 - The persisted shape does not change.** Still
  `{v:1, disposition, note, model, computed_at}`; `model` records
  `clef-api` (the verdict's model); the browser coercer drops
  `model`/`computed_at` anyway (`src/lib/ui/second-thoughts.ts:51-67`)
  and samskara's reader keys on `v` + disposition + note
  (`samskara.ts:452`). No version bump, no dual-read.
- **D3 - Doubt-note failure degrades to the empty-note doubt.** A
  note-call failure writes the verdict with `note: ''` - the UI's
  `displayNote` fallback copy and `buildRefinementThink`'s generic
  misgiving already cover exactly that shape
  (`src/lib/ui/second-thoughts.ts:159-164`, `:202-218`). A
  DECISION-call failure still writes NOTHING (the column stays
  null; the card shows nothing) - preserving the audit-trail rule:
  never a fabricated verdict (`second_thoughts.ts:559-562`).
- **D4 - The note call keeps the wire discipline and gains a shape
  check.** Thinking pinned (the standing rule), max tokens small
  (256), and the persisted note passes a shape check before the
  write: non-empty after trim, capped at 800 (existing cap), no
  `<think>` tag, no list-line leak (the GLM reasoning-into-content
  scar: persisted verbatim prose needs a shape check - the
  compound-summary guard's precedent). A failed check = empty note.
- **D5 - The choice criteria carry the disposition semantics.** The
  four options keep the prompt's meanings verbatim-ish (conviction
  = "the response holds up - the DEFAULT and by far the most common
  verdict", heavy bias stated in the criteria; correct = "suspect
  an outright error, not verified wrong"). The bias-toward-
  conviction instruction moves into the criteria/incorrect-alternative
  framing rather than dying with the chat prompt.
- **D6 - No confidence gating in v1.** The disposition drives
  everything exactly as today (`isDoubt` gates the panel; doubts
  auto-expand when refinable). The answer's confidence is logged
  for calibration. Rationale: adding a visibility gate changes
  user-visible behavior; B2 changes the producer, not the contract.
- **D7 - The old chat-verdict path retires.** `parseVerdict` /
  `SYSTEM_PROMPT` / the JSON-transport call are deleted, not
  kept-alongside - no fallback toggle. Failure modes degrade per
  D3. The serializer, `verifiedQuotes`, `loadTurnContext`, the
  thin-slice skip, and the tail wiring all stay.

## PLAN

- **M1 - The decision-verdict path in `second_thoughts.ts`.**
  `buildVerdictRequest(turnSlice, background)` (the choice question
  with D5's criteria), `coerceDisposition(payload)` (pick + confidence
  from the /decisions answer; null on drift), and the rewritten
  `secondThoughtsOnTurnTail`: decision call -> conviction = write
  + done; doubt = note call -> write. Retire `parseVerdict` +
  `SYSTEM_PROMPT`'s JSON contract (the reviewer persona's grounding
  instructions live on in the note prompt).
- **M2 - The doubt-note call.** A narrowed prompt: the reviewer
  persona, the same fenced exchange, "voice the twinge in one or
  two first-person sentences for a <disposition> verdict" -
  `veniceComplete` with the thinking pin, 256 max tokens, the D4
  shape check before persist.
- **M3 - Tests.** The Deno suite keeps every serializer /
  `verifiedQuotes` / background pin (untouched) and replaces the
  `parseVerdict` pins with: request shaping (the fenced slice rides
  the state), disposition coercion (all four + drift -> null), the
  conviction/doubt split (no note call on conviction - asserted via
  an injected complete-seam), the note shape check (cap, `<think>`
  rejection, empty-after-trim), and the fail postures (decision
  failure -> no write; note failure -> empty-note write).
- **M4 - Docs.** `docs/dev/second-thoughts.md` (the reflex's
  mechanics + the QA recipe's model-repoint instruction at
  `docs/qa/use-cases/chat-second-thoughts.md:21,159` - the knob's
  meaning changed), `venice-decisions-plan.md` B2 pointer.
- **M5 - Live QA.** Local stack: a turn's verdict lands in
  seconds-not-tens (the visible win), conviction rows keep the
  panel hidden, a doubt (if one occurs naturally) writes a note and
  the refine flow works. Forcing doubts live is not
  straightforward (the old repoint-to-a-weak-model trick has no
  decisions equivalent) - the note path is unit-covered; live doubt
  coverage is best-effort and logged honestly.

## RISKS

- **The verdict distribution shifts.** The decision model may draw
  doubts more (or less) readily than the chat prompt's
  bias-toward-conviction did. The criteria carry the bias, the live
  QA samples real turns, and the fallback is the D2-shape
  unchanged - a distribution complaint is a criteria edit, not a
  migration.
- **clef-api beta drift** lands as coerce-null -> no verdict written
  -> the card shows nothing (today's failure shape). The reflex
  degrades to absent, never wrong.
- **The note call's leak scar**: the shape check (D4) fails closed
  to an empty note; the display fallbacks own the empty case.

## VERIFICATION

- `mise run check` per commit, exit code read directly.
- Live QA per M5 from /Users/jeff.ober/dev/nak (the stack serving
  quirk).
- No `docs/user/` change: the panel, labels, refine flow, and
  fallback copy are all unchanged; only the latency moves.
