# Tools

The tool-calling subsystem. One catalog of tool schemas organised
into named toolboxes on the browser side, and one dispatch layer on
the server side: the venice Supabase edge function runs every tool -
chat-turn calls through `performToolCall`, background-agent calls
through the headless runner in `agents/_run.ts`. Every tool the
model can invoke in any surface is declared here.

## Role in the app

Tools give the model a way to actually do things - store a memory,
search prior threads, save a recipe, flip which toolboxes are
active. The main chat loop exposes them to the primary model via
named toolboxes; background agents expose their own scoped subsets
to their own models.

The catalog and the dispatch live on opposite sides of the wire:

- **The browser owns the catalog.** `buildToolList` composes the
  wire `tools` array from the thread's enabled toolboxes, and
  `src/lib/chat-prompt.ts` renders the same registry into the
  system-prompt catalog. Every browser `ToolDef` is a
  `serverSideTool(schema)` - catalog metadata plus an `execute()`
  that throws. Nothing dispatches tools in the browser.
- **The edge function owns every execution.** A streamed chat turn's
  tool calls dispatch through `performToolCall`
  (`supabase/functions/venice/performToolCall.ts`) against a
  registry the `tools/index.ts` barrel populates at module load.
  Background agents (reflection, the autonomous wiki agent, the
  wiki librarian, rem, deep-sleep, the recall agents) run their
  tool loops server-side via `runHeadlessAgent`
  (`supabase/functions/venice/agents/_run.ts`) against per-agent
  toolboxes.

See [`./architecture.md`](./architecture.md) "Production-path
ownership" for the full browser-vs-function frame.

### Toolbox model: reads ride free, writes gate

The main chat model sees toolboxes as the unit of enablement:

- **`always_on`** - rides every request regardless of the thread's
  `toolboxes_enabled` array. Carries every read-only surface plus a
  few reflexes (below).
- **`cooking`**, **`memories`**, **`wiki`**, **`wiki_records`**,
  **`library`**, **`images`** - gated toolboxes carrying only writes.
  Included in the wire catalog only when their name appears in
  `threads.toolboxes_enabled`. `wiki_records` carries the record writes
  (`record_create` / `record_update` / `record_delete`) plus the file +
  link writes (`record_file_attach` / `record_file_remove` /
  `record_link_create` / `record_link_delete`); the record reads
  (`record_list` / `record_get` / `record_search`) stay always-on. See
  `docs/dev/wiki.md` for the record files + cross-links design.

The principle: reads are idempotent and cheap, so gating them was
forcing the model to weigh "do I need this badly enough to flip a
toolbox?" and frequently answering wrong - passing over
`memory_search` in favour of training data even when the user asked
what Nak remembered. Writes still need a deliberate user-or-model
gate so an autonomous tool turn can't scribble over user data
without intent.

### The always-on toolbox

Notable members (the full ordered list is `alwaysOnToolbox` in
`src/lib/tools/index.ts`):

- `toggle_toolbox` - the gating mechanism itself. Without it in the
  always-on set, the model cannot enable any gated toolbox.
- `context` - umbrella recall over the three persistent layers
  (memories, prior conversations, wiki). One round-trip returns a
  works-cited index: memory facts verbatim plus related
  conversations and wiki articles by id. Preferred first step when
  the model wants broad context on the user.
- `memory_recall`, `conversation_recall`, `wiki_recall` - per-layer
  recall passes, each running an LLM sub-agent that returns a
  synthesized note from one store. The targeted, more-expensive
  drill-down tier above the deterministic `context` survey.
- Direct reads across every store: `memory_search`,
  `conversation_search` / `conversation_get`, `wiki_search` /
  `wiki_list` / `wiki_get`, `recipe_list` / `recipe_get`,
  `doc_list` / `doc_get` / `doc_grep` / `doc_read`.
- `research_docs` - one-shot sub-completion whose system prompt
  bundles the user-facing doc corpus (`docs/user/`), answering
  meta-questions about Nak itself; returns `{answer, sources}`.
  Passing `include_internal_dev_docs: true` expands the corpus to
  `docs/dev/` for "how would I add feature X" planning questions.
  The edge implementation reads a build-time bundle, not the
  filesystem - see Interactions, "Help / user docs."
- `web_search` - runs a one-shot Venice sub-completion with
  `enable_web_search: 'on'` + `enable_web_citations: true` and
  returns `{answer, citations}`. Always-on because time-sensitive
  questions (news, prices, today's weather) are the canonical case
  for search and we don't want the model to refuse or hedge while
  waiting for a toolbox flip. Read-only (no DB writes).
  Deliberately absent from every agent toolbox - background agents
  have no reason to reach for live web data, and giving them the
  tool would burn search quota and pollute memories with scraped
  noise.
- `update_title` - has to fire on the very first turn of a fresh
  thread when `toolboxes_enabled=[]` by default; gating it would
  mean a toolbox flip before the model could name the conversation.
- `analyze_image` - fires a vision sub-completion for an image
  attachment identified by filename and a caller-supplied query.
  Runs against a primary vision model first and falls back once to
  a permissive uncensored model on any failure (e.g. a spurious
  content-safety block on an innocuous photo). The edge
  implementation (`supabase/functions/venice/tools/analyze_image.ts`)
  looks the image up by filename in the thread, downloads the
  bytes, and inlines them as a base64 data URL.
- `ask_user` - pose a clarifying multiple-choice question instead
  of guessing intent. The turn suspends after the call lands; the
  next round starts when the user submits an answer via the
  AskUserCard UI. The tool surface is unique in the catalog: every
  other tool's result is computed by code, this one's is supplied
  by the user across a suspend/resume gap. Browser-side envelope
  helpers (`parseAskUserContent`, `buildAskUserAnswerContent`) live
  in `src/lib/ask-user.ts`; see `./chat.md` for the suspend/resume
  contract.

### The gated write boxes

- **`cooking`** - recipe writes: `recipe_save` / `recipe_update` /
  `recipe_delete` plus the photo tools (`recipe_photos_attach` /
  `_remove` / `_reorder`, `recipe_photo_label_set`). See
  `./cookbook.md`.
- **`memories`** - memory writes: `memory_create` / `memory_update`
  / `memory_delete` plus the volitional levers (`memory_reaffirm` /
  `memory_doubt` for graded confidence, `memory_relate` /
  `memory_unrelate` for the memory graph). See `./memory.md`.
- **`wiki`** - carries only `wiki_librarian`, which delegates a
  maintenance task to a multi-round sub-agent. Direct `wiki_create`
  / `wiki_update` / `wiki_delete` are NOT exposed to the main chat
  at all - those are reserved for the autonomous wiki agent and the
  librarian itself, so any chat-driven wiki edit goes through the
  librarian's full read-then-plan loop rather than a one-shot
  scribble. See `./wiki.md`.
- **`library`** - document writes: `doc_create` (promote a file the
  user attached into a permanent searchable document), `doc_update`,
  `doc_delete`. See `./library.md`.
- **`images`** - `generate_image`. Gated because a generation
  spends Venice credits and writes a persistent attachment.
  Unusually for a tool, its real output does NOT come back in the
  tool-result content: the edge orchestrator harvests the generated
  bytes (`supabase/functions/venice/tools/_generated_image.ts` +
  `getStreamingResponse.ts`) and writes a `message_attachments` row
  on the round's assistant-with-tool-calls message; the model only sees
  a compact descriptor (filename + dimensions). The browser renders that
  image in a dedicated `GeneratedImageCard` that resolves it by filename
  (the per-round attach never echoes over realtime). See
  `./attachments.md`.

## Files

Browser catalog (`src/lib/tools/`):

- `index.ts` - the toolbox definitions (`alwaysOnToolbox`,
  `cookingToolbox`, `memoriesToolbox`, `wikiToolbox`,
  `libraryToolbox`, `imagesToolbox`), the ordered `TOOLBOXES` list,
  the derived `GATED_TOOLBOX_NAMES` / `GATED_TOOLBOX_META`, the
  flat `TOOLS` view used by tests, the wire builder
  (`buildToolList`), and `getToolFormatters` for the tool-call
  detail panel. Every `ToolDef` here is a `serverSideTool(schema)`.
- `<tool>.schema.ts` (one per tool) - the tool's name, description,
  `shortDescription`, JSON Schema parameters, and any
  `formatArgs` / `formatResult` pretty-printer overrides. The
  schema half is everything the browser needs: the wire `tools`
  array, the system-prompt catalog, and the detail-panel renderers
  all read from it.
- `server_side.ts` - `serverSideTool(schema)`: wraps a schema into
  a `ToolDef` whose `execute()` throws, naming the tool's edge
  home. The throw is the point - if a regression re-routes dispatch
  browser-side it surfaces loudly instead of silently running stale
  logic.
- `types.ts` - `ToolDef`, `Toolbox`, `ToolContext`, `ToolResult`,
  OpenAI wire types (`OpenAIToolDef`, `OpenAIToolCall`).
- `wire.ts` - wire-shape helpers shared by the chat loop and the
  browser agents that replay stored threads (summary, topics):
  `sanitizeToolCallIdForWire`, `sanitizeToolCallsForWire`,
  `parseToolArguments`, and `toOpenAIToolDef` (which injects the
  `activity` narration parameter - see Contracts).

Adjacent browser modules:

- `src/lib/chat-prompt.ts` - `buildSystemPrompt` renders the
  registry into the system-prompt catalog; `buildToolboxStateBlock`
  renders the volatile `(on)`/`(off)` state.
- `src/lib/ask-user.ts` - the ask_user suspend/resume envelope
  helpers shared by `Chat.svelte` and the chat loop.

Edge dispatch (`supabase/functions/venice/`):

- `performToolCall.ts` - the function-side single-tool dispatcher:
  the module-scoped registry, `registerTool` (throws on duplicate
  names at module load), `listRegisteredTools`, the function-side
  `ToolContext` (`adminClient`, `userId`, `threadId` - a string for
  chat dispatch, null for the cross-thread librarian agents -
  `signal`, `depth?`), `requireThreadId` (the loud guard
  thread-requiring tools call instead of trusting the field), and
  the dispatch the streaming orchestrator calls per tool-call
  request. NOTE: supabase-js `.eq()` accepts `string | null`
  silently, so the null-safety of each tool is a reviewed manual
  discipline, not a compiler guarantee.
- `tools/index.ts` - side-effect barrel: importing it registers
  every tool implementation. New tool ports add one import line.
- `tools/<name>.ts` - the implementations. Direct queries run on
  the service-role client and MUST filter by `userId`
  (`// RLS OFF` discipline); SECURITY DEFINER RPCs are the safer
  path where one exists. See `./edge-function-auth.md`.
- `agents/context.ts`, `agents/recall.ts`,
  `agents/conversation_recall.ts`, `agents/wiki_recall.ts`,
  `agents/wiki_librarian.ts` - agent-backed tools. Each file is
  both the agent and its tool registration: `registerTool` at the
  bottom makes the agent invocable as a chat tool.
- `agents/_run.ts` - `runHeadlessAgent`, the headless tool loop
  every background agent drives, plus the agent-side `AgentTool` /
  `Toolbox` / `AgentToolContext` shapes, the `AgentProgressEvent`
  union, and the injectable `complete` test seam. Documented in
  depth in `./wiki.md` (the runner's first consumer).
- `agents/_agent_tools.ts` - `asAgentTool(tool, wire)`: wraps a
  registered `ToolDef` as an `AgentTool` so agent writes stay
  byte-identical to the chat-side tools, plus the wire schemas more
  than one agent shares.
- `agents/_memory_librarian_tools.ts` - the shared toolbox the two
  memory librarians (rem, deep-sleep) run with. See `./memory.md`.
- `agents/_wire.ts` - function-side mirror of the browser wire
  helpers (`encodeToolContent`, `parseToolArguments`, the
  sanitizers) for the agent loop.

## Entry points

- **Chat loop** - `chat-loop.ts` calls
  `buildToolList(thread.toolboxes_enabled)` to ship the wire
  `tools` array, then observes the streamed `tool_call_request` /
  `tool_call_response` events. The edge function is
  writer-of-record for the whole turn: it dispatches each call via
  `performToolCall` and persists the assistant-with-tool-calls row
  and the per-call `role='tool'` rows. See `./chat.md`.
- **Background agents** - server-side only. Each agent composes its
  own prompt and toolbox and calls `runHeadlessAgent`, which drives
  model -> tool -> model rounds entirely in memory (no DB writes,
  no streaming) until the model settles into a text-only response.
  Triggers and per-agent stories live with the owning features
  (`./memory.md`, `./wiki.md`).
- **System prompt assembly** - `buildSystemPrompt({ biasProfile })`
  in `src/lib/chat-prompt.ts` composes the baseline system message.
  The catalog section lists always-on tools first, then each gated
  toolbox and its tools. The catalog is state-free: it lists what
  toolboxes exist, not which are enabled, so the baseline stays
  byte-identical across a `toggle_toolbox` flip and the
  prompt-prefix cache survives it. The volatile `(on)`/`(off)`
  state is rendered by `buildToolboxStateBlock` and folded into the
  per-turn metadata system message (right after the datetime), so
  the model still sees the same enabled picture the user does in
  the composer popover - just from the trailing block, not the
  catalog.

## Data model

- **Toolbox definitions** (`alwaysOnToolbox`, `cookingToolbox`,
  `memoriesToolbox`, `wikiToolbox`, `libraryToolbox`,
  `imagesToolbox`) - each is a `Toolbox` with a stable name, a
  human-readable description (surfaced in the UI popover and in
  the system-prompt catalog), and an ordered `tools: ToolDef[]`
  array.
- **`TOOLBOXES`** - ordered list: always-on first, then the gated
  write boxes. Order is visible to the model (system-prompt
  catalog) and to the user (popover).
- **`GATED_TOOLBOX_NAMES`** - `TOOLBOXES` minus `alwaysOnToolbox`.
  The canonical name list for both writers (the `toggle_toolbox`
  tool and the composer popover) to validate against. **Mirror
  alert:** `toggle_toolbox` actually dispatches server-side
  (`supabase/functions/venice/tools/toggle_tools.ts`), which can't
  import this browser barrel and so keeps a HAND-MAINTAINED copy of
  these names. A toolbox added here but not there can't be enabled
  by the model - the toggle silently drops the unknown name and
  returns `enabled: []` (the bug that shipped with `wiki_records`).
  `tests/toggle-toolbox-mirror.test.ts` cross-checks the two lists,
  so adding a gated toolbox means editing BOTH places (and the
  guard fails the gate if you forget).
- **`GATED_TOOLBOX_META`** - `{name, description}[]` projection
  that the UI popover reads; kept narrow so Chat.svelte does not
  pull in tool definitions just to render a list.
- **`TOOLS`** - flat, deduped view of every tool across
  `TOOLBOXES`. Exported for test assertions; the wire builder
  composes from `TOOLBOXES` so a tool's toolbox membership drives
  enablement. Does NOT include agent-only toolboxes - those are
  composed server-side and addressed by toolbox directly.
- **`threads.toolboxes_enabled text[]`** - the per-thread set of
  enabled gated toolbox names. Written by `toggle_toolbox` (model-
  driven) and by the composer popover (user-driven). Empty array
  means "only the always-on set on the wire." The `always_on`
  name is implicit and is never stored here; writers drop it
  silently, as they drop any unknown name, so a renamed or
  deleted toolbox does not break mid-flight.
- **Context shapes** - three, deliberately not unified:
  - The browser `ToolContext` (`src/lib/tools/types.ts`) survives
    as part of the `ToolDef.execute` signature and its shape tests;
    no production code constructs one, since nothing dispatches
    browser-side.
  - The function-side `ToolContext` (`performToolCall.ts`) is what
    chat-tool implementations actually receive: service-role
    `adminClient`, the gateway-verified `userId`, `threadId`,
    `signal`, and the agent-recursion `depth`.
  - `AgentToolContext` (`agents/_run.ts`) is the same shape with
    the same nullable `threadId` (null for the cross-thread
    librarians). `asAgentTool` adapts between the latter two so agents
    reuse registered implementations.

## Contracts

- `ToolDef` (browser) - `{ name, description, shortDescription,
  parameters, execute, formatArgs?, formatResult? }`. `description`
  ships on the wire; `shortDescription` is a <50-char line used in
  the system-prompt catalog so the model knows what's behind the
  toggle without needing the full JSON schema. `execute()` throws
  on every chat tool (see `serverSideTool`). The optional
  formatters live on the schema half so the tool-call detail panel
  can render domain-specific args/results; `getToolFormatters(name)`
  resolves them, returning `undefined` for unknown names so a
  persisted call referencing a renamed tool still renders via the
  generic formatter.
- **Injected `activity` param** - every tool's wire schema gets a
  required `activity: string` property bolted on at the
  `toOpenAIToolDef` seam in `wire.ts`. The model fills it with a
  short present-tense sentence narrating the call, the chat UI
  renders the sentence above the tool name in `ToolCalls.svelte`,
  and the corresponding system-prompt block primes the model to
  write a useful one. `ToolDef.parameters` stays pristine - the
  injection happens at projection time - and handlers never read
  `args.activity`. Older persisted calls predate the injection;
  `ToolCalls.svelte` falls back to the legacy tool-name primary
  line when the key is missing. The venice function's agent runner
  injects the same parameter for progress-observed agent runs (see
  below); the two schemas must stay mirrored so the model sees one
  contract whichever side composed the wire.
- `buildToolList(enabledToolboxes: readonly string[]):
  OpenAIToolDef[]` - canonical way to build the request's `tools`
  array. Always includes the always-on toolbox; then each gated
  toolbox whose name appears in the input. Unknown names are
  ignored; duplicates across toolboxes are deduped by tool name
  (first-seen wins). Callers should never construct this array
  by hand.
- `buildSystemPrompt(opts?)` / `buildToolboxStateBlock(enabled)` -
  live in `src/lib/chat-prompt.ts`, importing the registry from
  here. The baseline is state-free; the state block renders the
  gated toolboxes as `(on)`/`(off)` lines and rides the per-turn
  metadata message. Unknown names in `enabled` are ignored;
  toolboxes absent from `enabled` render `(off)`.
- `serverSideTool(schema): ToolDef` - wraps a schema into a chat
  `ToolDef` whose `execute()` throws, naming the tool and its edge
  home. The chat catalog (`TOOLS`, `buildToolList`) carries it by
  name; the edge function's `performToolCall` is what actually
  runs it.
- `registerTool(def)` / `performToolCall` (edge) - the function-
  side `ToolDef` is just `{ name, execute(args, ctx) }`; the wire
  schema stays browser-side. Implementations self-register at
  module load via the `tools/index.ts` barrel; duplicate names
  throw immediately so a registration collision surfaces at load
  time, not as a "wrong tool ran" symptom. `listRegisteredTools()`
  feeds the /stream response envelope so the browser can warn when
  the model has tools armed that the function cannot dispatch.
- `runHeadlessAgent(opts, parentDepth)` (edge) - drives the agent
  loop until the model settles or `maxRounds` (default 20) runs
  out; returns `{ finalText, rounds, toolCalls, stoppedByLimit }`.
  Tool dispatch is scoped strictly to the passed toolbox - a name
  outside it throws with the toolbox name included, because agents
  are bounded contexts. `opts.complete` is the injectable
  completion seam unit tests script model rounds through;
  `opts.onProgress` attaches a live step listener AND opts the
  toolbox wire schemas into the `activity` narration parameter
  (narration costs output tokens, so unobserved agents keep their
  wire bytes free of it). Depth is enforced here: an agent run
  whose effective depth would exceed `MAX_AGENT_DEPTH` (3) is
  refused before the first Venice call. Aborts short-circuit at
  round boundaries and cascade into per-tool child controllers.
  Full treatment in `./wiki.md`.
- **Toggle semantics.** The `toggle_toolbox` tool takes
  `{enabled: string[]}` and replaces the thread's set. Passing
  `{enabled: []}` disables every gated toolbox. The tool returns
  `{enabled: <accepted-set>}` - the accepted set filters out
  unknown names and the implicit `always_on` name. On the UI side
  the composer popover writes through the same column via
  `setThreadToolboxesEnabled(threadId, names)`.

## Interactions with other features

- **Chat** - `buildToolList(thread.toolboxes_enabled)` shapes the
  wire catalog; the edge function dispatches and persists;
  `onToolboxesEnabledChange` fires whenever the model flips the
  thread's enabled set so the UI can patch its local thread row
  without a refetch. See `./chat.md`.
- **Attachments** - `generate_image` (gated `images` toolbox) is
  the one tool whose output bypasses the tool-result content
  entirely: the edge orchestrator harvests its generated bytes and
  writes a `message_attachments` row on the terminal assistant
  message, so generated images share storage, the manual-delete
  lifecycle, RLS, and `analyze_image` reachability with user uploads.
  See `./attachments.md`.
- **Memory** - the memory tools ARE the memory CRUD interface. The
  user-facing `memoriesToolbox` packages the writes; the agent
  toolboxes (reflection's in `agents/reflection.ts`, the shared
  librarian toolbox in `agents/_memory_librarian_tools.ts`) swap
  `memory_delete` for `memory_invalidate` because agents can only
  soft-decay, not hard-delete. See `./memory.md`.
- **Recall** - `context`, `memory_recall`, `conversation_recall`,
  and `wiki_recall` are chat tools whose implementations are
  themselves agents (`agents/context.ts`, `agents/recall.ts`,
  etc.), registered into the same dispatcher as the plain tools.
  Each recall agent runs with a one-tool read-only toolbox so a
  bug in a recall prompt can't scribble over user data. See
  `./context-recall.md` and `./conversation-recall.md`.
- **Wiki** - reads are always-on; the gated `wiki` toolbox carries
  only the librarian delegation. Direct wiki writes exist solely
  as agent-toolbox members. See `./wiki.md`.
- **Library** - the `doc_*` read/write split mirrors the other
  stores: reads always-on, writes behind the `library` box. See
  `./library.md`.
- **Cookbook** - recipe writes run server-side, so the browser
  learns about chat-driven saves through the recipes-table Realtime
  relay (`SupabaseService.subscribeToRecipeChanges` in
  `src/lib/supabase.ts`) wired by `Chat.svelte` into the coarse
  `emitCookbookChange` / `onCookbookChange` event bus in
  `src/lib/cookbook-events.ts`. Open Cookbook surfaces refetch on
  that event rather than depending on per-tool browser publishers.
  See `./cookbook.md`.
- **Help / user docs** - the edge `research_docs` cannot read the
  repo at request time, so `scripts/bundle-research-docs.mjs`
  embeds both doc trees as static strings in
  `supabase/functions/venice/_generated/research-docs-corpus.ts`.
  The deploy workflow regenerates the bundle before deploying the
  function, so committed doc edits reach the tool on the next
  deploy. See `./help.md`.
- **Logging** - edge-side tool and agent execution logs stream to
  the in-app Logs drawer over the logs Broadcast channel. Browser
  code that touches tool wire data logs via `createLogger` rather
  than `console.*` (the `no-console` ESLint rule enforces this).
  See `./logging.md`.

## Gotchas

- **The throwing `execute()` is the point.** `serverSideTool`'s
  throw never fires in production; if it does, tool dispatch was
  wrongly routed browser-side. Don't "fix" a thrown
  "executes server-side" error by giving the browser ToolDef a
  body - the regression is in whatever routed the call, and a
  browser body would silently drift from the live edge
  implementation.
- **The name is the cross-side contract.** The browser schema
  (`src/lib/tools/<name>.schema.ts`) and the edge registration
  (`registerTool` in `supabase/functions/venice/tools/<name>.ts`
  or an `agents/*.ts` file) must agree on the wire-facing name:
  the model emits whatever name the catalog declared, and the
  dispatcher runs whatever registered under it. A schema without a
  registration produces an armed-but-undispatchable tool (the
  /stream envelope's `listRegisteredTools` check exists to catch
  exactly this); a registration without a schema is unreachable
  dead code.
- **Two ToolContext shapes, deliberately not shared with the
  browser.** The browser's `ToolContext` carries the session-JWT-
  scoped `SupabaseService`; the function side has a service-role
  admin client and an explicit user id. Muxing them under one
  interface would force one side to inherit the other's
  awkwardness; both honor the same external contract (the tool's
  `execute(args, ctx)` signature) through their own interface.
- **The `activity` injection lives in two mirrored places.** The
  browser's `wire.ts` injects it into every chat tool; the edge
  `agents/_run.ts` injects it into agent toolboxes only when an
  `onProgress` listener is attached. The schema text must stay
  identical in both so the model sees one contract. A change to
  one without the other silently degrades the narration on the
  un-updated side.
- **`toggle_toolbox` is in `always_on` but not in the catalog.**
  It's the gating mechanism, not a capability to describe
  alongside recall. `buildSystemPrompt` filters it out of the
  always-on catalog block by `toggleToolbox.name`; the toggle rule
  is explained in its own prompt paragraph with the exact call
  shape (`toggle_toolbox({enabled: [...]})`).
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
- **Always-on membership requires read-only behavior.** The
  always-on set is "reads plus reflexes" by design; any new tool
  that wants always-on placement needs the same no-writes property
  or it belongs in a gated write box.
- **Wire-schema constraints are advisory, not enforced.** The
  `required`, `minLength`, `maxLength`, and enum bounds in a
  `.schema.ts` are prompt text the model reads, not a contract the
  runtime checks - Venice does no constrained decoding against the
  JSON schema. The edge `execute()` is the only real gate, so a
  malformed call lands there and must be rejected with a message the
  model can act on. Tightening the schema alone never stops a fumble;
  the server-side check is what does.
- **Write tools validate arguments all-at-once, not first-fail.**
  Each tool's `execute()` collects every argument problem into an
  `ArgErrors` accumulator (`tools/_validate.ts`) and throws once via
  `throwIfAny()`, rather than throwing on the first bad field. The
  reason: a model supplying several malformed args against a fail-fast
  check learns one problem per round trip and tends to fix one field
  while dropping another - a single memory_create save was observed
  taking five attempts this way. The combined throw preserves each
  problem string verbatim (substring test assertions still pass) and
  joins multiple with "; ". Dependent checks guard on their
  prerequisite (a self-loop/"differ" check only fires once both ids
  are present; an empty-patch "provide at least one of" only fires
  when nothing else is wrong) so one root cause never doubles up as
  two errors.
- **`memory_create` `message` is optional; the changelog line is
  derived when omitted.** Unlike the other changelog-bearing writes,
  memory_create defaults `message` to `Created: <label>` server-side.
  Models kept dumping the full memory body into `message` and then
  round-tripping its 200-char cap; making it optional removes the
  field as a failure surface for the common save-a-fact path. The
  content always belongs in `data`. memory_update/wiki_* keep
  `message` required - an edit/delete has no sensible label-derived
  default and the user wants the "why" recorded.
- **The research_docs corpus is a build artifact.** Doc edits do
  not reach the edge tool until `scripts/bundle-research-docs.mjs`
  regenerates `_generated/research-docs-corpus.ts` and the
  function redeploys - locally that means rerunning the bundle
  script before `supabase functions serve` picks up new docs.

## Where to go next

- `./chat.md` - ships the wire `tools` array and consumes the
  streamed tool events the edge function publishes.
- `./architecture.md` - "Production-path ownership," the
  browser-vs-function frame this subsystem's split follows.
- `./wiki.md` - the `runHeadlessAgent` runner in depth, including
  its test seam and progress events.
- `./memory.md` - the memory tools + reflection + the librarian
  fleet (rem, deep-sleep) + recall.
- `./conversation-recall.md` / `./context-recall.md` - recall-
  agent-specific plumbing.
