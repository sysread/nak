# Tools

The tool-calling subsystem. One registry, two parallel executors
(chat-side and headless-agent-side), and per-agent toolboxes that
subset the registry for read-only or write-scoped roles. Every tool
the model can invoke in any surface is declared here.

## Role in the app

Tools give the model a way to actually do things — store a memory,
search prior threads, flip the thread's toolbox on or off. The main
chat loop exposes them to the primary model; background agents
expose their own scoped subsets to their own models. Both paths
share the `ToolDef` shape and the `executeToolCall` /
`executeToolboxCall` dispatchers, so adding a tool is a
one-file-plus-index change.

Two always-on surfaces ride with every request regardless of the
thread's `tools_enabled` master switch:

- `toggle_tools` — the master switch itself. Without this, the
  toggle model can never flip.
- `memory_recall` and `conversation_recall` — reflex-level surfaces
  the system prompt asks the model to call at the top of a new
  topic. Both are read-only (they spawn a sub-agent and return a
  structured note) so there's no write risk from always exposing
  them.

## Files

- `src/lib/tools/index.ts` — the registry (`TOOLS`), catalog
  builders (`buildToolList`, `buildSystemPrompt`), and the main
  dispatcher `executeToolCall`. Also exports the read-only
  toolboxes for the recall agents.
- `src/lib/tools/run.ts` — `runHeadlessToolLoop`: the agent-side
  executor. Parallel to the chat loop but without persistence or
  streaming callbacks.
- `src/lib/tools/types.ts` — `ToolDef`, `Toolbox`, `ToolContext`,
  OpenAI wire types.
- `src/lib/tools/toggle_tools.ts` — the master-switch tool.
- `src/lib/tools/memory_*.ts` — the five memory tools (`search`,
  `create`, `update`, `invalidate`, `delete`) plus `memory_recall`
  (triggers the recall agent).
- `src/lib/tools/conversation_search.ts`,
  `conversation_recall.ts` — thread-level search + recall-agent
  trigger.
- `src/lib/tools/recall_toolbox.ts`,
  `conversation_recall_toolbox.ts` — the read-only toolboxes
  assembled for the recall agents. Standalone files to break
  import cycles.

## Entry points

- **Chat loop** — `chat-loop.ts` calls `buildToolList(toolsEnabled)`
  on every round and `executeToolCall(name, args, ctx)` for each
  `tool_call` event. The chat loop owns persistence of both the
  assistant-with-tool-calls row and the per-call `role='tool'`
  rows.
- **Background agents** — each agent calls `runHeadlessToolLoop`
  with its own toolbox. The loop extends an in-memory
  `VeniceMessage[]` each round and returns the final text + a few
  counters. No persistence happens inside.
- **System prompt assembly** — `buildSystemPrompt` composes the
  baseline system message the chat loop prepends each round. It
  includes two dynamic tool-catalog sections (always-on and
  gated) built from the registry, so adding a new tool extends
  the prompt automatically.

## Data model

- **Registry** (`TOOLS`) — ordered array of `ToolDef` objects.
  Order is the order the model sees them in, which is the order
  they appear in the system-prompt catalog. Recall tools go
  first.
- **`ALWAYS_ON`** — `toggle_tools` + `memory_recall` +
  `conversation_recall`. These ship with every request regardless
  of the thread's `tools_enabled` flag.
- **`GATED_TOOLS`** — derived (`TOOLS \ ALWAYS_ON`). Shipped only
  when the thread's `tools_enabled` is true.
- **`threads.tools_enabled`** — the per-thread master switch.
  Flipped by `toggle_tools` (model-driven) or the composer
  toolbox button (user-driven). Single source of truth for both
  paths.
- **`Toolbox`** — a name + description + `tools: ToolDef[]`
  subset. The `memoryToolbox` exports the reflection agent's
  scope; `recallToolbox` and `conversationRecallToolbox` are each
  one-tool read-only surfaces.
- **`ToolContext`** — the record every `execute` handler receives
  alongside the parsed args. Fields: `supabase`, `venice`,
  `userId`, `threadId`, `signal`. Assembled at call-time in the
  chat loop; agents assemble their own with a fixed `threadId`
  (or `''` for non-thread-scoped work).

## Contracts

- `ToolDef` — `{ name, description, shortDescription, parameters,
  execute }`. `description` ships on the wire; `shortDescription`
  is a <50-char line used in the system-prompt catalog so the
  model knows what's behind the toggle without needing the full
  JSON schema.
- `execute(args, ctx): Promise<unknown>` — the tool's handler.
  Errors thrown here land as `role='tool'` rows with an `error`
  key in the JSON content; the loop does not retry.
- `buildToolList(toolsEnabled): OpenAIToolDef[]` — canonical way
  to build the request's `tools` array. Enabled → full set;
  disabled → `ALWAYS_ON` only. Callers should never construct
  this array by hand.
- `executeToolCall(name, args, ctx): Promise<ToolResult>` — the
  main chat dispatcher. Throws on unknown tool name.
- `executeToolboxCall(toolbox, name, args, ctx)` — the agent
  dispatcher. Scoped strictly to the toolbox's tools; throws with
  the toolbox name included so errors from, say, the memory agent
  don't look identical to errors from the main chat.
- `toolbox.tools` is the authoritative subset. Two surfaces
  declaring the same tool name but different toolboxes are fine;
  the dispatcher reaches for the declared one.
- `runHeadlessToolLoop(opts): Promise<HeadlessToolLoopResult>` —
  `opts.messages` is already composed by the caller (no system-
  prompt prepend). Returns `{ finalText, rounds, toolCalls,
  stoppedByLimit }`. Default `maxRounds` is 8.

## Interactions with other features

- **Chat** — every tool call the main model emits is dispatched
  here. The registry's ordering of recall tools first shapes the
  system-prompt cadence the model learns. See `./chat.md`.
- **Memory** — the five memory tools (`search`, `create`,
  `update`, `invalidate`, `delete`) ARE the memory CRUD
  interface. Both the user-facing chat path and the reflection
  agent's path dispatch through the tool harness. `memory_recall`
  is a separate top-level tool that kicks off the recall agent.
  See `./memory.md`.
- **Conversation recall** — `conversation_recall` is a top-level
  tool; the agent it triggers has its own read-only toolbox that
  imports `conversation_search` directly from its file to avoid
  the cycle tools/index → conversation_recall → agents/… →
  tools/index. See `./conversation-recall.md`.
- **Reflection agent** — uses `memoryToolbox`, a write-scoped
  subset of the memory tools: `create / update / invalidate /
  search`, but NOT `delete` (agent can only soft-invalidate; hard
  deletes are user-directed) and NOT `memory_recall` or any
  `*_recall` (recursion with no purpose — reflection already has
  the whole conversation in context). See `./memory.md`.

## Gotchas

- **Two parallel executors, not one abstraction.** `chat-loop.ts`
  and `run.ts` look superficially similar but diverge on
  persistence, streaming, prompt-prepend, and the web-search
  toggle. Trying to collapse them into a single function grew a
  laundry list of optional flags last time; keeping them separate
  is deliberate. If you find yourself copying a fix between the
  two, the fix probably wants to live in `types.ts` or a small
  shared helper, not in a unified loop.
- **`encodeToolContent` is duplicated in both executors.** Kept
  separate so `run.ts` doesn't import anything from
  `chat-loop.ts` (agents shouldn't depend on streaming chat
  infrastructure). The invariant: the two encoders must produce
  identical shapes, so a future model swap between the two
  surfaces doesn't have to relearn the result format. Check that
  they match if you change either one.
- **Circular-import dance around recall toolboxes.** `memory_recall`
  lives in `tools/index.ts` and triggers `agents/recall/agent.ts`,
  which needs a toolbox. If the agent imported the toolbox from
  `tools/index.ts` the cycle would bite — the agent would load
  before `memoryRecall` was defined, giving it an undefined
  toolbox. The fix: `recall_toolbox.ts` and
  `conversation_recall_toolbox.ts` are their own files,
  re-exported from `tools/index.ts` so consumers that read
  `$lib/tools` still see them. Don't inline them back into the
  barrel.
- **Catalog builders are the contract.** `buildSystemPrompt`'s
  two catalog sections (`ALWAYS_ON_CATALOG`, `GATED_TOOLS`)
  derive from the registry. If you add a tool and hand-edit the
  system-prompt string instead of going through the registry,
  the two drift and the model ends up with a catalog that
  doesn't match the tools on the wire.
- **`toggle_tools` belongs in `ALWAYS_ON` but not in the
  always-on catalog.** It's the gating mechanism, not a
  capability to describe alongside recall. `ALWAYS_ON_CATALOG`
  filters it out; the toggle rule is explained in its own
  prompt block.
- **Recall tools are the only `ALWAYS_ON` non-toggle tools
  because they're read-only.** Any new tool that wants
  always-on behavior needs that same property or it should live
  behind the gate.

## Where to go next

- `./chat.md` — the main caller of `executeToolCall` and the
  owner of persistence around tool rounds.
- `./memory.md` — the memory tools + reflection agent + recall
  agent story.
- `./conversation-recall.md` — recall-agent-specific plumbing.
