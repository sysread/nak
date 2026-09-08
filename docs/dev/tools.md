# Tools

The tool-calling subsystem. One catalog of tool schemas organised
into named toolboxes on the browser side, and one dispatch layer on
the server side: the venice Supabase edge function runs every tool -
chat-turn calls through `performToolCall`, background-agent calls
through the headless runner in `agents/_run.ts`. Every tool the
model can invoke in any surface is declared here.

## Role in the app

Tools give the model a way to actually do things - store a memory,
search prior threads, save a recipe. The main chat loop exposes the
full catalog to the primary model, grouped into named toolboxes;
background agents expose their own scoped subsets to their own
models.

The catalog and the dispatch live on opposite sides of the wire:

- **The browser owns the catalog.** `buildToolList` composes the
  wire `tools` array (every static tool plus every connected MCP
  integration's tools), and `src/lib/chat/system-prompt.ts` renders
  the same registry into the system-prompt catalog. Every browser
  `ToolDef` is a `serverSideTool(schema)` - catalog metadata plus an
  `execute()` that throws. Nothing dispatches tools in the browser.
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

### Toolbox model: every tool is declared on every request

`buildToolList` declares every static tool plus every connected MCP
integration's tools on every request. There is no per-thread gate,
no toggle meta-tool, and no composer picker. The toolboxes are
grouping devices for the system-prompt catalog (reads listed first,
writes grouped by area), not enablement switches.

Why there is no wire-level gate: the serving backend (GLM 5.3 Flash
via Venice) holds the model to the declared tool list and silently
DROPS a call to a tool the request did not declare. The forensics
line from `streamFromVenice` showed it plainly: ~950 completion
tokens spent, zero reasoning tokens, an empty role frame + an empty
`finish_reason=stop` frame, three attempts in a row, on a turn
whose surviving reasoning said "Do recipe_update with full cooklang"
while the cooking toolbox was off the wire. The system prompt lists
every tool by name (deliberately, for the prefix cache), so the
model knows the write exists and sometimes calls it without
toggling first - and a gate turns that into a failure the model
cannot see and a temperature re-roll cannot fix. An earlier shape
gated only the writes and the model passed over read tools rather
than pay a toggle round-trip, answering from training data even
when the user asked what Nak remembered. Both failure modes come
from the same place: the system prompt's state-free catalog names
every tool, so the model believes what it reads. Declaring
everything makes the wire match the catalog and removes the failure
class.

**Never reintroduce a wire-level gate.** If a tool must be refused
at runtime, refuse at dispatch: declare it, then return a tool
result naming why the call was refused. That failure the model can
see and recover from. (The empty-completion re-roll in `./chat.md`
stays as the safety net for any other empty completion.)

Cost, measured 2026-09-07: the full declared set is ~72k chars
(~18k tokens) for 60 tools after the activity-parameter trim. The
gate's always-on set shipped ~32.6k chars (~8k), so the delta is
about +10k tokens per request - and prompt caching (Venice reports
`cached_tokens`, ~95% on the second request of a turn) absorbs the
repeat within a conversation, since the array is byte-stable
turn-to-turn now that no toggle can reshape it.

### The always-on toolbox

Notable members (the full ordered list is `alwaysOnToolbox` in
`src/lib/tools/index.ts`):

- `context` - umbrella recall over the three persistent layers
  (memories, prior conversations, wiki). One round-trip returns a
  works-cited index: memory facts verbatim plus related
  conversations and wiki articles by id. Preferred first step when
  the model wants broad context on the user.
- `memory_recall`, `conversation_recall`, `wiki_recall` - per-layer
  recall passes, each running an LLM sub-agent that returns a
  synthesized note from one store. The targeted, more-expensive
  drill-down tier above the deterministic `context` survey.
- Direct reads across every store: `memory_search` / `memory_get`,
  `conversation_search` / `conversation_get`, `wiki_search` /
  `wiki_list` / `wiki_get`, `recipe_list` / `recipe_get`,
  `doc_list` / `doc_get` / `doc_grep` / `doc_read`. The `*_get` trio
  (`memory_get` / `conversation_get` / `wiki_get`) is the by-id
  drill-down behind the recall block's `^N^` citations.
- `research_docs` - one-shot sub-completion whose system prompt
  bundles the user-facing doc corpus (`docs/user/`), answering
  meta-questions about Nak itself; returns `{answer, sources}`.
  Passing `include_internal_dev_docs: true` expands the corpus to
  `docs/dev/` for "how would I add feature X" planning questions.
  The edge implementation reads a build-time bundle, not the
  filesystem - see Interactions, "Help / user docs."
- `web_search` - two retrieval modes behind one name. With `query`,
  runs a one-shot Venice sub-completion with
  `enable_web_search: 'on'` + `enable_web_citations: true` and
  returns `{answer, citations}`. With `url`, posts the link to
  Venice's `/augment/scrape` endpoint (`veniceScrapeUrl` in
  `_shared/venice.ts`) and returns `{url, content}` - the page as
  markdown, capped at 32k chars with a `truncated` flag, plus a
  single self-citation so the page shows in the reply's sources
  panel. The split exists because the search pipeline is built
  around queries and searches FOR a bare URL instead of reading
  it. Read-only (no DB writes).
  Deliberately absent from every agent toolbox - background agents
  have no reason to reach for live web data, and giving them the
  tool would burn search quota and pollute memories with scraped
  noise. Both modes tag their result with the untrusted-content
  notice (see Contracts, "Untrusted tool results").
- `update_title` - renames the conversation; fires from the very
  first turn so a fresh thread gets a real title.
- `analyze_image` - fires a vision sub-completion for an image
  attachment identified by filename and a caller-supplied query.
  Runs against a primary vision model first and falls back once to
  a permissive uncensored model on any failure (e.g. a spurious
  content-safety block on an innocuous photo). Each attempt is
  bounded by a per-attempt abort (`VISION_ATTEMPT_TIMEOUT_MS` in
  `tools/_vision.ts`) so a hung vision upstream degrades to the
  fallback instead of eating the turn's wall deadline. The edge
  implementation (`supabase/functions/venice/tools/analyze_image.ts`)
  looks the image up by filename in the thread, downloads the
  bytes, and inlines them as a base64 data URL. Its lookup filters
  on `image/%`, so a miss is ambiguous - it re-queries without the
  filter and names what the file actually is rather than reporting a
  present-but-non-image attachment as absent. See
  `./attachments.md`, Gotchas.
- `analyze_pdf_page` - the same vision sub-call against ONE rasterized
  page of a PDF in the thread (`filename`, 1-based `page`, `query`).
  Covers what the text layer can't: scanned documents, charts,
  diagrams, signatures, layout. Pages are rendered in the browser at
  upload time, not on demand, so an out-of-range request comes back
  naming the pages that ARE viewable. Shares the vision runner and the
  bytes-to-data-URL helper with `analyze_image` via `tools/_vision.ts`.
  See `./attachments.md`, "PDF page rendering."
- `ask_user` - pose a clarifying multiple-choice question instead
  of guessing intent. The turn suspends after the call lands; the
  next round starts when the user submits an answer via the
  AskUserCard UI. The tool surface is unique in the catalog: every
  other tool's result is computed by code, this one's is supplied
  by the user across a suspend/resume gap. Browser-side envelope
  helpers (`parseAskUserContent`, `buildAskUserAnswerContent`) live
  in `src/lib/ask-user.ts`; see `./chat.md` for the suspend/resume
  contract.

### The write toolboxes

Each of these groups only tools that mutate user data; every read
surface lives in the always-on set above.

- **`cooking`** - recipe writes: `recipe_save` / `recipe_update` /
  `recipe_delete` plus the photo tools (`recipe_photos_attach` /
  `_remove` / `_reorder`, `recipe_photo_label_set`). See
  `./cookbook.md`.
- **`memories`** - memory writes: `memory_save` (create, or edit by
  id) / `memory_delete` plus the volitional levers (`memory_reaffirm`
  / `memory_doubt` for graded confidence, `memory_relate` /
  `memory_unrelate` for the memory graph). See `./memory.md`.
- **`wiki`** - the whole chat-driven wiki write surface.
  Article save + delete (`wiki_save` - create without an id, or
  rewrite by id; `wiki_delete`), the `wiki_librarian` delegation (a
  multi-round sub-agent for multi-article consolidations), and the
  full record write surface (`record_create` / `record_update` /
  `record_delete`, the file tools `record_file_attach` /
  `record_file_remove`, and the cross-link tools
  `record_link_create` / `record_link_delete`). See `./wiki.md`.
- **`followups`** - follow-up writes: `followup_save` (create, or
  reschedule by id) / `followup_close` / `followup_dismiss`, the
  lifecycle of the pending questions the model saves for itself.
  The read (`followup_list`) stays always-on. See `./followups.md`.
- **`library`** - document writes: `doc_save` (promote a file the
  user attached into a permanent searchable document, or update an
  existing document's metadata by id), `doc_delete`. See
  `./library.md`.
- **`images`** - `generate_image`. A generation
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

  The backing image model is user-configurable: the tool reads
  `profiles.settings.imageModel` (via the service-role client, keyed by
  the dispatch's `userId`) and falls back to `DEFAULT_IMAGE_MODEL`
  (`venice-sd35`, mirrored from `VENICE_DEFAULT_IMAGE_MODEL` in
  `src/lib/models/index.ts`) when unset or on any read error - a missing
  preference must never block an image. The choice is made in Settings ->
  AI -> Image generation (see `./settings.md`). Aspect-ratio -> pixel
  sizing stays a single table tuned to the default model's 1280px cap; v1
  deliberately does not fetch per-model size constraints, so an exotic
  pick with a tighter cap surfaces Venice's error rather than being
  pre-validated. A per-model constraint lookup is the follow-up if that
  bites.

## Files

Browser catalog (`src/lib/tools/`):

- `index.ts` - the toolbox definitions (`alwaysOnToolbox`,
  `cookingToolbox`, `memoriesToolbox`, `wikiToolbox`,
  `libraryToolbox`, `imagesToolbox`), the ordered `TOOLBOXES` list,
  the flat `TOOLS` view used by tests, the wire builder
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

- `src/lib/chat/system-prompt.ts` - `buildSystemPrompt` renders the
  registry into the system-prompt catalog.
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

- **Chat loop** - `chat/loop.ts` calls `buildToolList()` to ship
  the wire `tools` array, then observes the streamed
  `tool_call_request` / `tool_call_response` events. The edge
  function is writer-of-record for the whole turn: it dispatches
  each call via `performToolCall` and persists the
  assistant-with-tool-calls row and the per-call `role='tool'`
  rows. See `./chat.md`.
- **Background agents** - server-side only. Each agent composes its
  own prompt and toolbox and calls `runHeadlessAgent`, which drives
  model -> tool -> model rounds entirely in memory (no DB writes,
  no streaming) until the model settles into a text-only response.
  Triggers and per-agent stories live with the owning features
  (`./memory.md`, `./wiki.md`).
- **System prompt assembly** - `buildSystemPrompt(mcpToolboxes?)`
  in `src/lib/chat/system-prompt.ts` composes the baseline system
  message. The catalog section lists read tools first, then each
  write toolbox and its tools. The catalog is state-free and lists
  every tool, matching the wire `tools` array exactly - nothing in
  the baseline varies per turn, which is what lets it anchor the
  prompt-prefix cache.

## Data model

- **Toolbox definitions** (`alwaysOnToolbox`, `cookingToolbox`,
  `memoriesToolbox`, `wikiToolbox`, `libraryToolbox`,
  `imagesToolbox`) - each is a `Toolbox` with a stable name, a
  human-readable description (surfaced in the system-prompt
  catalog), and an ordered `tools: ToolDef[]` array.
- **`TOOLBOXES`** - ordered list: always-on first, then the write
  boxes. Order is visible to the model (system-prompt catalog).
- **`TOOLS`** - flat, deduped view of every tool across
  `TOOLBOXES`. Exported for test assertions. Does NOT include
  agent-only toolboxes - those are composed server-side and
  addressed by toolbox directly.
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
  the system-prompt catalog so the model knows what the tool does
  without needing the full JSON schema. `execute()` throws
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
- `buildToolList(mcpToolboxes?): OpenAIToolDef[]` - canonical way
  to build the request's `tools` array. Every static tool plus
  every connected MCP integration's tools; duplicates across
  toolboxes are deduped by tool name (first-seen wins). Callers
  should never construct this array by hand.
- `buildSystemPrompt(mcpToolboxes?)` - lives in
  `src/lib/chat/system-prompt.ts`, importing the registry from
  here. The catalog it renders mirrors this array exactly.
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
- **`opts.budgetMs` - the wall-clock bound.** Rounds are what the
  loop can stop between, but wall clock is what kills a run: the
  hosted edge runtime terminates the isolate around 400s, and
  everything after the loop dies with it - the run-outcome write,
  the in-flight lease release. The result is a pass that persisted
  nothing and a lease every client honours until its TTL expires.
  With `budgetMs` set, the loop calls `roundFitsBudget(elapsed,
  budget, slowestRoundMs)` before each round after the first and
  stops early with `stoppedByLimit` instead, so the post-loop work
  still runs. The estimate is the SLOWEST round so far, not the
  mean: underestimating gets you killed, overestimating costs one
  round. Round 1 is unconditional, so a run always does something.
  `opts.now` injects the clock, which is what keeps the budget
  tests deterministic rather than timing-dependent.

  It is **opt-in per agent**, not defaulted, because "too long" is
  the caller's policy: deep-sleep sets 300s
  (`DEEP_SLEEP_BUDGET_MS`) because a death strands its lease, while
  a long reflection is expected and already handled by its own
  failure counter. Any agent whose post-loop work must run wants a
  budget under the platform's kill threshold.
- **Untrusted tool results.** A tool whose payload contains bytes
  nak did not author - a scraped page, a live search synthesis, an
  MCP server's response - returns it through
  `withUntrustedNotice(source, payload)`
  (`supabase/functions/venice/untrusted-content.ts`), which attaches
  an `untrusted_content_notice` sibling key telling the model the
  rest of the result is data to read and report on, never
  instructions. Current callers: `tools/web_search.ts` (both
  retrieval modes) and `mcp/dispatch.ts` (every MCP-routed call).
  The notice is written first so it serializes ahead of the payload.

  It is a **sibling key, not a prose prefix with delimiters**, and
  that is load-bearing: tool results are JSON-encoded before the
  model sees them (`encodeToolContent`), so an unbounded
  attacker-chosen payload cannot escape its own string - a quote in
  scraped markdown comes out as an escape, not a structural
  delimiter. A text fence around the same bytes could simply be
  closed by the bytes. It also keeps the row JSON-parseable for the
  tool-call detail panel's `formatResult` path.

  The notice covers tool RESULTS only. An MCP server's tool
  **descriptions** are the other server-authored surface and cannot
  be tagged this way - they are prompt text, not tool output. They
  are disclaimed instead, at the "Connected integrations" section of
  `buildCatalog`, and flattened to one line each by `oneLine` so a
  line break in a description cannot forge a catalog row. See
  [`./mcp-integrations.md`](./mcp-integrations.md) "Security
  surface."

  The notice is **half of a pair.** It ships inside the same message
  as the attacker-reachable payload, so payload text can claim the
  notice is fake or already satisfied. The other half is a standing
  rule in the baseline system prompt
  (`UNTRUSTED_CONTENT_BLOCK` in `src/lib/chat/system-prompt.ts`),
  which arrives on the trusted channel and cannot be forged by a tool
  result. Neither half works alone: the prompt rule has nothing to
  point at without the tag, and the tag has no authority without the
  rule. Deleting either as redundant breaks the mitigation.

  Adding a tool that returns outside bytes means adding a call here,
  not writing a fresh warning; the wording lives in one place.
  `supabase/functions/tests/untrusted-content.test.ts` pins the
  ordering and the escaping property;
  `tests/system-prompt.test.ts` pins the prompt half.

## Interactions with other features

- **Chat** - `buildToolList()` shapes the turn's wire array; the
  edge function dispatches and persists. See `./chat.md`.
- **Attachments** - `generate_image` (gated `images` toolbox) is
  the one tool whose output bypasses the tool-result content
  entirely: the edge orchestrator harvests its generated bytes and
  writes a `message_attachments` row on the terminal assistant
  message, so generated images share storage, the manual-delete
  lifecycle, RLS, and `analyze_image` reachability with user uploads.
  On the read side, `analyze_image` and `analyze_pdf_page` are the two
  tools that reach attachment bytes by filename; the `<thread_attachments>`
  system block is what tells the model which filenames each one accepts.
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
- **Wiki** - reads are always-on; the gated `wiki` toolbox is the
  single gate for every chat-driven write - article CRUD, the
  librarian delegation, and the record writes (records + files +
  links). The same write tool impls also compose the autonomous
  agents' own toolboxes via `asAgentTool`. See `./wiki.md`.
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
- **Dispatch does not re-check a gate.** `performToolCall` runs
  whatever registered name the model emits - under the
  declare-everything model there is no gate to re-check. A model
  that hallucinates a name (or replays a call to a tool retired
  since the row was written) gets the dispatcher's unknown-tool
  error as its tool result, which it can see and recover from.
- **Always-on membership requires read-only behavior.** The
  always-on set is "reads plus reflexes" by design; any new tool
  that wants always-on placement needs the same no-writes property
  or it belongs in a write toolbox.
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
  while dropping another - a single memory_save was observed
  taking five attempts this way. The combined throw preserves each
  problem string verbatim (substring test assertions still pass) and
  joins multiple with "; ". Dependent checks guard on their
  prerequisite (a self-loop/"differ" check only fires once both ids
  are present; an empty-patch "provide at least one of" only fires
  when nothing else is wrong) so one root cause never doubles up as
  two errors. (A single memory_save was the observed five-attempt
  case.)
- **`memory_save` `message` is optional; the
  changelog line is derived when omitted.** The create form defaults
  `message` to `Created: <label>` and the edit form to
  `Updated: <label>` server-side. Models kept dumping the full memory
  body into `message` and round-tripping its 200-char cap, or
  omitting it (and inventing param names to carry it) and
  round-tripping the required-field rejection; making it optional
  removes the field as a failure surface. The content always belongs
  in `data`. wiki_* and memory_delete keep `message` required - a
  delete has no sensible label-derived default and the user wants
  the "why" recorded.
- **The `untrusted_content_notice` key is not noise; don't strip it
  at the encode seam.** It looks like per-round overhead riding in
  the model's context on every web_search and MCP result, and
  `encodeToolContent` is the obvious place to filter it out. Doing
  that removes the whole mitigation: the notice has to sit in the
  same message as the content it frames, or the model reads the
  content with nothing telling it where the trust boundary is. If
  the token cost ever needs cutting, shorten the wording in
  `untrusted-content.ts` - one place, all callers.
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
