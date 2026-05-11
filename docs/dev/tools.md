# Tools

The tool-calling subsystem. One registry organised into named
toolboxes, two parallel executors (chat-side and headless-agent-
side), and per-agent toolboxes that subset the registry for read-
only or write-scoped roles. Every tool the model can invoke in any
surface is declared here.

## Role in the app

Tools give the model a way to actually do things - store a memory,
search prior threads, save a recipe, flip which toolboxes are
active. The main chat loop exposes them to the primary model via
named toolboxes; background agents expose their own scoped subsets
to their own models. Both paths share the `ToolDef` shape and the
`executeToolCall` / `executeToolboxCall` dispatchers, so adding a
tool is a one-file-plus-toolbox-entry change.

The main chat model sees toolboxes as the unit of enablement:

- **`always_on`** - reflex-level tools that ride every request
  regardless of the thread's `toolboxes_enabled` array.
- **`cooking`**, **`memories`**, **`conversations`**, **`research`**
  - gated toolboxes. Included in the wire catalog only when their
  name appears in `threads.toolboxes_enabled`.

The always-on toolbox carries:

- `toggle_toolbox` - the gating mechanism itself. Without it in the
  always-on set, the model cannot enable any gated toolbox.
- `context` - umbrella over the four recall tools. Fans out the
  same four recall agents (memory, conversation, wiki, journal) the
  topic-boundary pipeline uses, in parallel, and returns a single
  stitched first-person paragraph. The system prompt nudges the
  model to consider this first when it wants broad context on the
  user - one round-trip instead of four sequential per-layer calls.
  Read-only.
- `memory_recall`, `conversation_recall`, `wiki_recall`,
  `journal_recall` - reflex-level per-layer reads the model uses
  when it already knows which store it wants (or when it wants to
  drill into one layer after the umbrella `context` call). Each
  spawns its dedicated recall sub-agent and returns a structured
  note. All four are read-only - they each ship with a toolbox
  that carries only the matching `*_search` tool, so a bug in a
  recall prompt can't scribble over user data.
- `web_search` - runs a one-shot Venice sub-completion with
  `enable_web_search: 'on'` + `enable_web_citations: true` and
  returns `{answer, citations}`. Must be available without a
  toggle round-trip because time-sensitive questions (news,
  prices, today's weather) are the canonical case for search and
  we don't want the model to refuse or hedge while waiting for a
  toolbox flip. Read-only (no DB writes). Deliberately excluded
  from `memoryToolbox`, `recallToolbox`,
  `conversationRecallToolbox`, `wikiRecallToolbox`, and
  `journalRecallToolbox` - background agents have no reason
  to reach for live web data, and giving them the tool would burn
  search quota and pollute memories with scraped noise.
- `update_title` - has to fire on the very first turn of a fresh
  thread when `toolboxes_enabled=[]` by default; gating it would
  mean a toolbox flip before the model could name the
  conversation.
- `analyze_image` - fires a one-shot vision sub-completion (balanced
  tier) for an image attachment identified by filename and a caller-
  supplied query. Always-on so the model can reach for it on any
  tier when the user sends an image. The main model phrases the
  query from the user's intent (e.g. "what does this say?" becomes
  an OCR-focused query); the tool returns the vision model's plain-
  text answer. Image bytes live in `ctx.attachments`, hydrated by
  the chat loop from the current user message's DB rows - no
  in-tool DB query needed.

The gated `research` toolbox carries:

- `research_docs` - fires a one-shot sub-completion on the fast
  tier whose system prompt bundles every user-facing doc under
  `docs/user/` (loaded via `src/lib/docs.ts`'s Vite glob). The
  sub-model answers the caller's question from that context alone
  and returns `{answer, sources}` where `sources` is an array of
  doc paths. Same in-app corpus the Help modal renders, just with
  the fast model doing the synthesis. Gated (not always-on) because
  meta-questions about the app are a small fraction of
  conversation turns; paying a tool-schema tax on every request
  would be wasteful. The LLM flips the toolbox on via
  `toggle_toolbox` when it sees a meta-question and keeps it on
  for the rest of a research-oriented thread.

  Dev-docs opt-in: passing `include_internal_dev_docs: true`
  expands the bundled corpus to also carry every doc under
  `docs/dev/` (architecture + per-feature dev notes, loaded via
  `listDevDocs` / `loadDevDoc` from the same module). This lets
  the tool field "how would I add feature X to Nak" planning
  questions - the sub-model can cross-reference user-facing
  behavior against internal design notes in a single pass. The
  dev tree is ~4x the user tree's size, so opt-in per call rather
  than always-on keeps the common case cheap. In dev mode the
  sub-model is asked to cite sources with the tree prefix
  (`docs/user/memory.md` vs `docs/dev/memory.md`) since several
  filenames collide across the two trees, and
  `parseResearchResult` preserves those prefixes when
  `keepPrefixes: true` is passed.

## Files

- `src/lib/tools/index.ts` - the toolbox definitions
  (`alwaysOnToolbox`, `cookingToolbox`, `memoriesToolbox`,
  `conversationsToolbox`, `researchToolbox`), the ordered
  `TOOLBOXES` list, the derived `GATED_TOOLBOX_NAMES` /
  `GATED_TOOLBOX_META`, the flat `TOOLS` view used by tests, the
  catalog builders (`buildToolList`, `buildSystemPrompt`), and the
  main dispatcher `executeToolCall`. Also exports the agent-only
  toolboxes (`memoryToolbox`, `recallToolbox`,
  `conversationRecallToolbox`, `wikiRecallToolbox`,
  `journalRecallToolbox`).
- `src/lib/tools/run.ts` - `runHeadlessToolLoop`: the agent-side
  executor. Parallel to the chat loop but without persistence or
  streaming callbacks.
- `src/lib/tools/types.ts` - `ToolDef`, `Toolbox`, `ToolContext`,
  OpenAI wire types.
- `src/lib/tools/toggle_tools.ts` - the gating meta-tool
  (`toggle_toolbox`). Validates incoming names against the current
  `GATED_TOOLBOX_NAMES` set; unknown names are silently dropped
  (the tool's return value tells the model what took effect).
- `src/lib/tools/memory_*.ts` - the five memory tools (`search`,
  `create`, `update`, `invalidate`, `delete`) plus `memory_recall`
  (triggers the recall agent).
- `src/lib/tools/conversation_search.ts`,
  `conversation_recall.ts` - thread-level search + recall-agent
  trigger.
- `src/lib/tools/wiki_recall.ts`, `wiki_recall_toolbox.ts` - the
  wiki-recall tool (main-chat) and the read-only toolbox the
  wiki-recall agent uses internally.
- `src/lib/tools/journal_recall.ts`, `journal_recall_toolbox.ts` -
  same shape for the journal-recall agent.
- `src/lib/tools/context.ts` - the umbrella recall tool: fans out
  all four recall agents in parallel via `runRecallFanOut` (see
  `src/lib/context-recall/pipeline.ts`) and returns the stitched
  paragraph. Thin wrapper; the heavy lifting is shared with the
  reflexive pipeline.
- `src/lib/tools/recipe_*.ts` - five cookbook tools (`save`,
  `list`, `get`, `update`, `delete`). Mutating ones fire
  `notifyCookbookChanged` from `cookbook-store.svelte.ts` so the
  Cookbook modal + drawer tab refresh without the UI layer needing
  to import the tools module. See `./cookbook.md`.
- `src/lib/tools/recall_toolbox.ts`,
  `conversation_recall_toolbox.ts` - the read-only toolboxes
  assembled for the recall agents. Standalone files to break
  import cycles.
- `src/lib/tools/web_search.ts` - wraps a Venice sub-completion
  with server-side web search on. Chat-loop harvests the
  returned `citations` array into the terminal assistant row's
  `citations` column so `CitationsPanel` + `^N^` markdown
  superscripts light up the same way they did under the old
  always-on search path.
- `src/lib/tools/analyze_image.ts` - fires a one-shot vision sub-
  completion against the balanced tier with the image bytes from
  `ctx.attachments`. Requires `ToolContext.attachments` to be
  populated (the chat loop does this from the current user
  message's attachment rows). Returns `{answer: string}`.
- `src/lib/tools/research_docs.ts` - bundles every `docs/user/`
  markdown file into the system prompt of a fast-tier sub-
  completion and returns `{answer, sources}`. The trailing
  `Sources: ...` line the prompt asks for is parsed back into
  the sources array by `parseResearchResult`, exported for
  direct test coverage. Uses `listDocs` / `loadDoc` from
  `src/lib/docs.ts` so the bundled corpus is always identical
  to what the Help modal renders. When the caller passes
  `include_internal_dev_docs: true` the bundle also carries
  every `docs/dev/` file (loaded via `listDevDocs` / `loadDevDoc`
  from the same module), swaps in a dev-aware system prompt
  header that asks for tree-prefixed source cites, and lifts the
  output token cap so architecture answers aren't cramped.

## Entry points

- **Chat loop** - `chat-loop.ts` calls
  `buildToolList(thread.toolboxes_enabled)` on every round and
  `executeToolCall(name, args, ctx)` for each `tool_call` event.
  The chat loop owns persistence of both the assistant-with-tool-
  calls row and the per-call `role='tool'` rows.
- **Background agents** - each agent calls `runHeadlessToolLoop`
  with its own toolbox. The loop extends an in-memory
  `VeniceMessage[]` each round and returns the final text + a few
  counters. No persistence happens inside.
- **System prompt assembly** - `buildSystemPrompt({
  enabledToolboxes, promptAppendix })` composes the baseline
  system message the chat loop prepends each round. The catalog
  section lists always-on tools first, then each gated toolbox
  with a `[x]` or `[ ]` mark showing its current enabled state,
  so the model sees the same picture the user does in the
  composer popover.

## Data model

- **Toolbox definitions** (`alwaysOnToolbox`, `cookingToolbox`,
  `memoriesToolbox`, `conversationsToolbox`, `researchToolbox`) -
  each is a `Toolbox` with a stable name, a human-readable
  description (surfaced in the UI popover and in the system-prompt
  catalog), and an ordered `tools: ToolDef[]` array.
- **`TOOLBOXES`** - ordered list: always-on first, then cooking,
  memories, conversations, research. Order is visible to the model
  (system-prompt catalog) and to the user (popover).
- **`GATED_TOOLBOX_NAMES`** - `TOOLBOXES` minus `alwaysOnToolbox`.
  The canonical name list for both writers (the `toggle_toolbox`
  tool and the composer popover) to validate against.
- **`GATED_TOOLBOX_META`** - `{name, description}[]` projection
  that the UI popover reads; kept narrow so Chat.svelte does not
  pull in tool definitions just to render a list.
- **`TOOLS`** - flat, deduped view of every tool across
  `TOOLBOXES`. Exported for test assertions; the wire builder
  composes from `TOOLBOXES` so a tool's toolbox membership drives
  enablement.
- **`threads.toolboxes_enabled text[]`** - the per-thread set of
  enabled gated toolbox names. Written by `toggle_toolbox` (model-
  driven) and by the composer popover (user-driven). Empty array
  means "only the always-on set on the wire." The `always_on`
  name is implicit and is never stored here; writers drop it
  silently, as they drop any unknown name, so a renamed or
  deleted toolbox does not break mid-flight.
- **`Toolbox`** - a name + description + `tools: ToolDef[]`
  subset. The agent-only `memoryToolbox` exports the reflection
  agent's scope (memory CRUD with `memory_invalidate` in place of
  `memory_delete`); `recallToolbox` and `conversationRecallToolbox`
  are each one-tool read-only surfaces.
- **`ToolContext`** - the record every `execute` handler receives
  alongside the parsed args. Fields: `supabase`, `venice`,
  `userId`, `threadId`, `signal`, `attachments?`. The
  `attachments` field is optional (`Attachment[]`) - populated by
  the chat loop from the current user message's DB rows so
  `analyze_image` can find image bytes without a DB round-trip.
  Agents assemble their own context with a fixed `threadId` (or
  `''` for non-thread-scoped work) and leave `attachments`
  absent; tools guard with `ctx.attachments ?? []`.

## Contracts

- `ToolDef` - `{ name, description, shortDescription, parameters,
  execute }`. `description` ships on the wire;
  `shortDescription` is a <50-char line used in the system-prompt
  catalog so the model knows what's behind the toggle without
  needing the full JSON schema.
- **Injected `activity` param** - every tool's wire schema gets a
  required `activity: string` property bolted on at the
  `toOpenAIToolDef` seam in `dispatch.ts`. The model fills it with a
  short present-tense sentence narrating the call, the chat UI
  renders the sentence above the tool name in `ToolCalls.svelte`,
  and the corresponding system-prompt block in `buildSystemPrompt`
  primes the model to write a useful one. `ToolDef.parameters` stays
  pristine - the injection happens at projection time - and handlers
  never read `args.activity` (they ignore unknown keys the way
  they've always ignored them). Older persisted calls predate the
  injection; `ToolCalls.svelte` falls back to the legacy tool-name
  primary line when the key is missing.
- `execute(args, ctx): Promise<unknown>` - the tool's handler.
  Errors thrown here land as `role='tool'` rows with an `error`
  key in the JSON content; the loop does not retry.
- `buildToolList(enabledToolboxes: readonly string[]):
  OpenAIToolDef[]` - canonical way to build the request's `tools`
  array. Always includes the always-on toolbox; then each gated
  toolbox whose name appears in the input. Unknown names are
  ignored; duplicates across toolboxes are deduped by tool name
  (first-seen wins). Callers should never construct this array
  by hand.
- `buildSystemPrompt(opts?)` - `{ enabledToolboxes?,
  promptAppendix? }`. The enabled toolbox list drives the
  `[x]`/`[ ]` marks in the catalog; an absent `enabledToolboxes`
  is treated as "none enabled."
- `executeToolCall(name, args, ctx): Promise<ToolResult>` - the
  main chat dispatcher. Throws on unknown tool name. Looks up the
  tool across every toolbox in `TOOLBOXES` in order.
- `executeToolboxCall(toolbox, name, args, ctx)` - the agent
  dispatcher. Scoped strictly to the toolbox's tools; throws with
  the toolbox name included so errors from, say, the memory agent
  don't look identical to errors from the main chat.
- `toolbox.tools` is the authoritative subset. Two surfaces
  declaring the same tool name but different toolboxes are fine;
  the dispatcher reaches for the declared one.
- `runHeadlessToolLoop(opts): Promise<HeadlessToolLoopResult>` -
  `opts.messages` is already composed by the caller (no system-
  prompt prepend). Returns `{ finalText, rounds, toolCalls,
  stoppedByLimit }`. Default `maxRounds` is 8.
- **Toggle semantics.** The `toggle_toolbox` tool takes
  `{enabled: string[]}` and replaces the thread's set. Passing
  `{enabled: []}` disables every gated toolbox. The tool returns
  `{enabled: <accepted-set>}` - the accepted set filters out
  unknown names and the implicit `always_on` name. On the UI side
  the composer popover writes through the same column via
  `setThreadToolboxesEnabled(threadId, names)`.

## Interactions with other features

- **Chat** - every tool call the main model emits is dispatched
  here. `buildToolList(thread.toolboxes_enabled)` shapes the wire
  catalog each round; `onToolboxesEnabledChange` fires whenever
  the model flips the thread's enabled set so the UI can patch
  its local thread row without a refetch. See `./chat.md`.
- **Memory** - the five memory tools (`search`, `create`,
  `update`, `invalidate`, `delete`) ARE the memory CRUD
  interface. The user-facing `memoriesToolbox` packages
  `search / create / update / delete`. The reflection agent's
  `memoryToolbox` swaps `memory_delete` for `memory_invalidate`
  because agents can only soft-decay, not hard-delete.
  `memory_recall` is a separate always-on tool that kicks off the
  recall agent. See `./memory.md`.
- **Conversation recall** - `conversation_recall` is an always-
  on tool; the agent it triggers has its own read-only toolbox
  that imports `conversation_search` directly from its file to
  avoid the cycle tools/index -> conversation_recall -> agents/...
  -> tools/index. See `./conversation-recall.md`.
- **Wiki recall and journal recall** - `wiki_recall` and
  `journal_recall` follow the same pattern as the memory and
  conversation recall tools: always-on entries in the main chat,
  each backed by a dedicated sub-agent whose toolbox carries only
  the matching `*_search` tool. The umbrella `context` tool wraps
  all four recall agents (via `runRecallFanOut`) so a single tool
  call surfaces broad context across every persistent layer. See
  `./context-recall.md`.
- **Cookbook** - five `recipe_*` tools gated by the `cooking`
  toolbox. The store in `cookbook-store.svelte.ts` owns the
  reactive recipe list; mutating tools fire a `window`
  `CustomEvent` so the UI refreshes without a tools -> UI import.
  See `./cookbook.md`.
- **Journal** - four user-facing tools
  (`journal_list`, `journal_read`, `journal_search`,
  `journal_delete`) gated by the `journal` toolbox. The
  background journaling agent does NOT use a tool to
  write; it goes through `response_format=json_object`
  and calls `supabase.upsertJournalAutomaticEntry`
  directly. See `./journal.md` for the rationale (long
  Markdown bodies double-escaped through tool-call
  arguments lost too many writes). The store in
  `journal-store.svelte.ts` fans out a
  `JOURNAL_CHANGE_EVENT` on every write so modal /
  drawer surfaces refresh without a tools -> UI import.
- **Reflection agent** - uses `memoryToolbox`, a write-scoped
  subset of the memory tools: `create / update / invalidate /
  search`, but NOT `delete` (agent can only soft-invalidate; hard
  deletes are user-directed) and NOT `memory_recall` or any
  `*_recall` (recursion with no purpose - reflection already has
  the whole conversation in context). See `./memory.md`.
- **Logging** - the recall tools (`memory_recall`,
  `conversation_recall`, `wiki_recall`, `journal_recall`) and the
  umbrella `context` tool emit diagnostic breadcrumbs via
  `createLogger`. New tools should follow suit rather than
  calling `console.*` directly - the `no-console` ESLint rule
  enforces this outside `src/lib/logger.svelte.ts`. See
  `./logging.md`.
- **Help / user docs** - `research_docs` reads the bundled
  `docs/user/` corpus via the same `listDocs` / `loadDoc`
  primitives the Help modal uses (`src/lib/docs.ts`). New docs
  added to the Help manual are automatically visible to the
  research tool on the next build - the Vite glob is the single
  source of truth. See `./help.md`.
- **Dev docs** - `research_docs` also reaches into `docs/dev/`
  via the parallel `listDevDocs` / `loadDevDoc` primitives in
  `src/lib/docs.ts` when the caller opts in with
  `include_internal_dev_docs: true`. Nothing else consumes that
  glob; the Help modal is user-docs-only. Adding a new file
  under `docs/dev/` makes it visible to the research tool on
  the next build with no other wiring needed.

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
  `tools/index.ts` the cycle would bite - the agent would load
  before `memoryRecall` was defined, giving it an undefined
  toolbox. The fix: `recall_toolbox.ts`,
  `conversation_recall_toolbox.ts`, `wiki_recall_toolbox.ts`, and
  `journal_recall_toolbox.ts` are their own files,
  re-exported from `tools/index.ts` so consumers that read
  `$lib/tools` still see them. Don't inline them back into the
  barrel. For the same reason, `toggle_tools.ts` imports
  `GATED_TOOLBOX_NAMES` and `alwaysOnToolbox` via a deferred
  `await import('./index')` inside `execute()` rather than at the
  top of the file.
- **`toggle_toolbox` is in `always_on` but not in the catalog.**
  It's the gating mechanism, not a capability to describe
  alongside recall. `buildSystemPrompt` filters it out of the
  always-on catalog block; the toggle rule is explained in its
  own prompt paragraph with the exact call shape
  (`toggle_toolbox({enabled: [...]})`).
- **Unknown toolbox names are dropped silently.** Both writers
  (`toggle_toolbox` and the composer popover) filter against
  `GATED_TOOLBOX_NAMES`, so a renamed or deleted toolbox doesn't
  break mid-flight. On the read side, `coerceThread` filters
  non-string array elements out of `toolboxes_enabled` so a
  drifting row can never poison the UI's `.includes()` checks.
  Validation is at the edges; internal code trusts the shape.
- **The `always_on` name is implicit.** Listing it in the
  `enabled` array does nothing (we already include it) and
  writers drop it. The stored array should never contain
  `always_on`.
- **Recall tools are the only `always_on` non-toggle tools
  because they're read-only.** Any new tool that wants always-on
  behavior needs that same property or it should live inside a
  gated toolbox.

## Where to go next

- `./chat.md` - the main caller of `executeToolCall` and the
  owner of persistence around tool rounds.
- `./memory.md` - the memory tools + reflection agent + recall
  agent story.
- `./conversation-recall.md` - recall-agent-specific plumbing.
