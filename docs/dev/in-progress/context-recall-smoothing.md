# Context recall: narrative smoothing + citations (in progress)

Status: design agreed, not yet built. This doc is the milestone
tracker; when a milestone ships, graduate its durable design into
[`../context-recall.md`](../context-recall.md) / [`../memory.md`](../memory.md)
and trim it here (see the root `CLAUDE.md` on retiring in-progress docs).

## The problem

The context-recall pipeline injects retrieved memories as a synthetic
assistant `<think>` turn before the live round. Two facts about the
current implementation combine into a sharp failure:

- The injected block is **raw, uncompressed, and unbounded by size.**
  `renderContextThink` (`supabase/functions/venice/priming/context-recall.ts`)
  is string concatenation; the memory cap is count-based
  (`CONTEXT_MEMORY_LIMIT = 6`) and each memory's `data` can be up to
  `MAX_MEMORY_DATA_CHARS = 8000`. Six memories can be ~48KB of text
  injected ahead of a one-sentence user message.
- The stored memories carry **encoding-time temporal self-reference.**
  The reflection writer stamps "(this conversation)", "(this session)",
  dates, and first-person AI self-assessment ("What I got wrong TWICE")
  into the memory body. Correct once; a lie every later recall.

Observed symptom: the model answers the recalled block as if it were
events in the *current* conversation, and the sheer volume drowns the
user's actual last message - it responds to days-old memory content and
ignores what was just said. A real example dump (a bread thread) showed
the model replying about trivet gradients and hydration deltas to a
message that just said "this loaf is really good."

The fix is NOT to strip the richness. Rich, episodic, contextual
memories are the goal. The fix is to move the compression + framing
from *encoding time* (where it poisons the store) to *recall time*
(where it can integrate against the current moment) - mirroring how
human recall works: a rich trace is stored, and an associative trigger
replays it through narrative smoothing that compresses it, anchors it
in the past, and explains its relevance to right now.

## Target behaviour

The smoothed recall is a first-person `<think>` paragraph that
*incorporates* facts into a relevance-bridged recollection, with `^N^`
citation superscripts threaded through it (the same convention
`web_search` uses). Shape, illustrative:

```text
<think>
I remember that on 2026-05-27 the user and I worked through the prior
iteration of this recipe ^1^. Their hydration was too low that time, so
they wanted to add 50g for the iteration we are discussing now ^1^. I
also recall their wife did not particularly like that bake ^2^. More
generally they prefer home-milled flour and high-hydration doughs,
often using a tangzhong of soluble-fibre ingredients to set up a
source-sink relationship - retrograding wheat starch releasing water,
trapped by rye pentosans and flax mucilage ^3^.
</think>
```

### Fidelity contract (the smoothing prompt)

- **Preserve, do not quote.** Numbers, names, decisions, metrics, and
  dates are incorporated accurately into the prose - never paraphrased
  into drift (25g must not become 30g), never wrapped in direct
  quotes. Everything else - why the memory surfaced, how it bridges to
  the current turn, emphasis, framing - reconstructs freely against the
  present context.
- **Domain-agnostic.** The prompt names no subject matter. Bread,
  code, relationships - the contract is the same.
- **Relevance bridge is the point.** Every recollection states how it
  connects to what the user just said. This is the mechanism that
  re-subordinates memory to the live turn, so the model stops answering
  the memory instead of the message.
- **Recall, not flashback.** Past-tense temporal anchoring on the
  memory's *real* age (see laundering below) plus a present-relevance
  bridge. The model must read the content as "something I am recalling,"
  never "something happening now."

### Citations make reconstruction safe

Free reconstruction is only safe because every claim is traceable. Each
`^N^` resolves to `{kind: memory|conversation|wiki, id, label}`. A
reconstructed claim that drifts is recoverable: the raw row still exists
in the store, the main model can drill down to verify before asserting,
and the user can trace provenance in the citations UI. Uncited
synthesis is the confabulation the original design feared; cited
synthesis is auditable recall.

## Decision: read-time laundering (option A)

The store is already full of poisoned mega-memories. We do NOT migrate
them up front. Instead the smoothing pass launders at read time: it is
handed each memory's real `created_at`, told to anchor temporally on
*that*, and told to treat any dates / "this conversation" phrasing
*inside* the memory body as unreliable narration to re-frame rather than
reproduce. This makes the read path robust to whatever shape is in the
store - which we want permanently, since rich episodic memories will
always carry some embedded context.

Memories then **fix themselves over time** via the existing REM /
deep-sleep librarian sweeps, which already walk the store on a cadence -
reshaping a visited memory into the timeless-but-rich form is one more
thing they do while they are there. No dedicated one-time migration.

## Architecture

The deterministic gather and its trigger/cache machinery are unchanged.
Only the render step and the payload shape change, plus new drill-down +
UI.

1. **Gather** (`context-recall.ts`, `gatherContextIndex`) - unchanged
   except that the memory layer must now carry `id` and `created_at`
   through to the index (today `renderMemoryLine` drops the id). The
   three searches stay deterministic and verbatim - no hallucination at
   retrieval.
2. **Smoothing pass** (new) - replaces `renderContextThink`. One
   `deepseek-v4-flash` completion (already `REFLECTION_MODEL`;
   `disableThinking: true`, like `web_search`), reads the gathered index
   + recent turns + per-memory real timestamps, returns
   `{ note, citations }`: the note carries inline `^N^` markers, the
   citation array resolves them. Runs only when recall actually fires
   (the existing trigger cadence), so cost is bounded - not per turn.
3. **Payload shape** (`context-recall-payload.ts` + the browser mirror
   `src/lib/context-recall/types.ts`) - `note: string` becomes `note`
   plus `citations[]`. Ripples through `coerceContextRecallPayload`, the
   realtime echo decoder, and `pickFresherContextRecallPayload`. Bump
   the schema version; an old-shape row coerces to "no cache" and
   refreshes.
4. **`memory_get`** (new tool) - primary-key fetch of one memory by id,
   parallel to `conversation_get` / `wiki_get`, registered always-on.
   Makes a memory citation actionable for both the model (verify before
   asserting) and the UI link.
5. **Citations UI** - reuse `CitationsPanel.svelte`, generalized from
   URL-only to two citation kinds: external URL (web, new tab) vs
   internal route (memory/conversation/wiki, in-app navigation via the
   `?memory=` / conversation / wiki article routes). The kind-to-link
   decision is a `src/lib/ui/` primitive, not inline in the `.svelte`
   (per `src/components/CLAUDE.md`). The existing `unavailable`
   orphan-refs mode already covers turns that predate the new shape.

## Build order

- **M1 - symptom fix.** Smoothing pass + payload shape (note +
  citations) + gather carrying memory id/created_at + wiring through
  `runServerPriming`. Ships the de-poisoned, compressed,
  relevance-bridged `<think>` block. Citation *markers* land here; the
  citation list is persisted but need not be drill-down-actionable yet.
  This alone fixes the reported bug.
- **M2 - citations end-to-end.** `memory_get` tool + `CitationsPanel`
  generalization + the `Citation` type's `kind` discriminator + the
  in-body `^N^` click wiring for internal routes. Turns the citation
  list into the "trace the context behind this response" UX.
- **M3 - self-healing.** Teach REM / deep-sleep to reshape a poisoned
  memory they visit. See the open sub-decision below.
- **M4 - writer fast-follow.** Stop the reflection writer baking
  "(this conversation)" / dates / AI self-narration into new memory
  bodies. Reduces the laundering burden on M1; not a blocker because A
  handles legacy and new rows alike.

## Open sub-decisions

- **Librarian content-write authority (gates M3).** The librarian
  toolbox deliberately omits `memory_update` - "librarian collapses,
  reflection generates" (`memory.md`). Self-healing rewrite is a content
  write, so M3 crosses that boundary on purpose. Options: grant the
  librarians a constrained reshape capability (narrower than full
  `memory_update`), or extend `memory_consolidate`'s rewrite to a
  single-memory degenerate case. Decide when M3 starts.
- **Citation type shape (gates M2).** Extend the existing `Citation`
  type in `$lib/supabase` with a `kind` + optional internal route, or
  introduce a parallel internal-citation type. Leaning extend, to keep
  one citations panel.
- **Inline vs fully-behind-citations memories (M1).** Whether the
  smoothed note ever still inlines a short verbatim memory or routes
  everything through citation references. Leaning all-cited for
  consistency.

## Interactions

- [`../context-recall.md`](../context-recall.md) - the pipeline this
  rewrites the render half of. Update its "Why deterministic, not
  synthesized" section when M1 lands: retrieval stays deterministic, but
  the render step is now an LLM smoothing pass - the distinction that
  keeps this from being the reverted three-agent design is that the
  gather is still verbatim and the synthesis is cited/auditable.
- [`../memory.md`](../memory.md) - `memory_get` is a new always-on
  memory tool; M4 changes the reflection writer's prompt; M3 widens the
  librarian toolbox.
- [`../tools.md`](../tools.md) - `memory_get` joins the always-on
  drill-down trio.
- `web_search` (`supabase/functions/venice/tools/web_search.ts`) - the
  `{answer, citations}` + `^N^` convention this borrows.

## Verification

- **Before/after on a real thread.** Use the `nak-inspect-thread` skill
  to dump a thread's `context_recall_payload` and injected block pre-
  and post-change; confirm the de-poisoning and the size drop.
- **Real store shape.** Supabase MCP to quantify the existing memory
  rows (size distribution, count carrying "this conversation") so the
  laundering prompt is tuned against reality, not the one sample.
- **QA use-case** under `docs/qa/use-cases/` per the repo's
  feature-ships-with-a-walkthrough rule.
- `mise run check` + `mise run functions-test` (the smoothing pass and
  `memory_get` are Deno edge code) + `mise run knip`.
- Cloud agent cannot open a browser - the `CitationsPanel` internal-link
  rendering and the slide-down need a manual sanity pass before M2
  lands.
