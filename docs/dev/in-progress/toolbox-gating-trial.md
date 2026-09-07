# Toolbox gating trial (in progress)

> **Status: trial live on main since 2026-09-07 (PR #540).** Every
> tool is declared on every request and the `toggle_toolbox` meta-
> tool is withdrawn, behind one constant (`TOOLBOX_GATING = false`
> in `src/lib/tools/index.ts`). All gating code stays in the tree,
> inert. The open question is cost: the trial adds roughly 8k
> prompt tokens per request before prompt caching. **Exit:** once
> a few days of normal use show the per-turn `prompt_tokens` /
> `cached_tokens` picture is acceptable and no write call goes
> missing, a follow-up session removes the gating code for real
> (checklist at the bottom) and retires this doc. If the cost is
> not acceptable, flip the constant back to `true` and retire this
> doc with a note in `../tools.md`.

## The problem, as it surfaced

Three symptoms, reported in order, turned out to be one chain.

1. **An empty card under an answered `ask_user` question.** The
   streaming placeholder row (born on the first visible text delta)
   was blanked at the round boundary and parked under
   `status='suspended_for_ask_user'` when the turn suspended. The
   resumed invocation created its own row, so the parked one
   persisted as an assistant row with no content, no tool calls,
   and no reasoning: a footer-only card that survived reload.
2. **Reasoning, then a "cut off" card, on an ordinary turn.** A
   round ended with reasoning but no text and no tool call. The
   orchestrator treated that as `'completed'`, and because no text
   ever streamed no row existed to commit, so the turn persisted
   nothing. The transcript tail stayed a bare user message and the
   browser painted the cut-off banner with nothing to retry against.
3. **The same failure three times in a row on one prompt**, with two
   of the three attempts carrying zero reasoning too.

## What the evidence said

Step 2 looked like a model stall (GLM 5.3 Flash writing its answer
inside the thinking channel), and the empty-completion re-roll was
built on that reading. It recovered one turn and failed the next,
so a forensics line was added to `streamFromVenice`: when a stream
yields nothing, log the usage epilogue's `completion_tokens` plus a
bounded sample of the raw frames.

The next occurrence answered it:

- `completion_tokens=955` and `930`, `reasoning_tokens=0`
- frames: an empty role delta, an empty `finish_reason=stop` delta,
  the usage epilogue, `[DONE]`
- the third attempt's surviving reasoning: "Do recipe_update with
  full cooklang", then 1010 tokens delivered as nothing
- the cooking toolbox was **off** on that thread (a follow-up save
  had replaced the enabled set), so `recipe_update` was **not
  declared** on the request

The serving backend holds the model to the declared tool list and
silently drops a call to a tool the request never declared. The
model generated the full recipe card as a tool call each time and
the stream delivered nothing. The system prompt lists every tool by
name on purpose (a state-free catalog keeps the prompt prefix
cacheable across toggles), so the model knows the write exists and
sometimes calls it without toggling first. Under the gate that is a
failure the model cannot see and a temperature re-roll cannot fix.

## What landed

Three PRs, each one layer down.

- **#537** - delete the streaming placeholder on `ask_user` suspend
  instead of parking it, and sweep any empty assistant row on the
  thread's next completed turn (warn to the drawer per hit; the
  END event carries `prunedIds` so the open transcript drops them
  without a refetch). Permanent home: `../chat.md`, the `ask_user`
  bullet and "Empty-row sweep".
- **#538 / #539** - re-roll an empty completion (no text, no tool
  call) with the guards' temperature bump, twice per turn, then
  fail as `guard_exhausted` with the last attempt's reasoning
  preserved as a `status='error'` row; surface the exhausted path
  as the retryable card; log the empty-stream forensics. Permanent
  home: `../chat.md`, "Empty-completion re-roll". This stays as
  the safety net for any other empty completion.
- **#540** - this trial. Remove the cause: nothing undeclared to
  call. Permanent home for the current shape: `../tools.md`,
  "TRIAL: toolbox gating is OFF".

## What the trial changes

- `buildToolList` declares every static toolbox and every connected
  MCP toolbox on every request, minus `toggle_toolbox` (a declared
  toggle would invite the call it exists to prevent).
- `buildSystemPrompt` frames the catalog as plainly available: no
  toggle rule, the two "enable the X toolbox and call Y" sentences
  become "call Y", no per-turn `(on)`/`(off)` state block. Each of
  those would otherwise steer the model into a toggle call the
  backend would drop the same way.
- The composer's toolbox button and popover are hidden.
- Every builder takes `gating` as a trailing parameter defaulting to
  the constant; the existing tests pin the gated shape with
  `gating=true` and new suites pin the trial default, so both modes
  stay tested and the revert path cannot rot.
- The per-tool `activity` parameter description (bolted onto every
  tool schema at the wire projection, mirrored in the agent runner)
  shrank from ~400 to ~100 characters. The examples and UI
  rationale live once in the prompt's activity block.

## Cost

Measured 2026-09-07, characters of the wire `tools` JSON:

| shape | tools | chars | approx tokens |
| ----- | ----- | ----- | ------------- |
| gated, always-on set only, before trim | 28 | 40.5k | 10k |
| gated, always-on set only, after trim | 28 | 32.6k | 8k |
| trial, everything declared, after trim | 60 | 72.2k | 18k |

So about +8k prompt tokens per request over what the gate used to
ship. Venice reports `cached_tokens` on the usage epilogue and the
forensics run showed ~53k of a 56k-token prompt cached on the second
request of a turn, so within a conversation the tool block should
be paid for once. The tool array was already byte-stable except
across a toggle, which invalidated the cache from the tool block
onward; under the trial it never changes.

## Exit criteria and the cleanup that follows

**Keep the trial** if, over normal use: no write call goes missing
(no `empty stream` forensics lines with `completion_tokens` in the
hundreds and `reasoning_tokens=0`), and the per-turn
`prompt_tokens` / `cached_tokens` picture is acceptable.

Then a follow-up session removes the gating machinery for real:

- `TOOLBOX_GATING` and every `gating` parameter; `buildToolList`
  collapses to "all tools minus the toggle" and the toggle def can
  go entirely (`toggle_tools.schema.ts`, server `toggle_tools.ts`,
  `tests/toggle-toolbox-mirror.test.ts`).
- The orchestrator's mid-turn rearm block and
  `buildToolsFromCatalog` / `enabledSetFromToggleResult` in
  `tool_catalog.ts` (the envelope's `toolCatalog` may still be
  wanted for `schemaMapFromCatalog` - check before dropping it),
  plus `tests/tool-catalog-parity.test.ts` and the rebuild cases in
  `supabase/functions/tests/tool-catalog.test.ts`.
- `buildToolboxStateBlock` and its assembly site, the gated
  branches in `buildCatalog`, `stripToolboxEnables` (rewrite the
  wiki/library blocks directly instead).
- The composer toolbox button, popover, `toggleToolboxManually`,
  `toolboxFlash`, `GATED_TOOLBOX_META`; the `threads.toolboxes_enabled`
  column and the thread-realtime handler that watches it.
- Docs: the "Toolbox model" section of `../tools.md` and its
  Gotchas, the `toolbox-midturn-enable.md` QA case, the Toolboxes
  section of `docs/user/chat.md` and every "enable the X toolbox"
  instruction elsewhere under `docs/user/`.

**Revert** if the cost is not acceptable: flip the constant to
`true`, delete the trial callout in `docs/user/chat.md`, and add a
short note in `../tools.md` recording the cost figures and that the
backend drops undeclared calls, so the next attempt at a wire gate
starts from a dispatch-side refusal (declare everything, refuse at
dispatch with a result naming the toggle) rather than an undeclared
tool.
