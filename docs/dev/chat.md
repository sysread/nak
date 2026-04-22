# Chat

The main user-facing surface plus the orchestration code behind a
single turn. `Chat.svelte` renders the drawer, composer, and message
list; `chat-loop.ts` runs the streaming + tool-call + persistence
round-trip. Model tiers and per-thread overrides also live here —
they're trivial standalone but always accessed through the chat
flow.

## Role in the app

A chat turn goes:

1. User types in the composer and clicks send.
2. `Chat.svelte` resolves the effective model (per-thread override
   → user default), builds the history in OpenAI shape, and calls
   `runChatLoop`.
3. `chat-loop.ts` streams the response from Venice, executing any
   tool calls in parallel and persisting each round (assistant row
   first, then one `role='tool'` row per call) before looping.
4. Terminal assistant message (no tool_calls) ends the loop; the
   composer re-enables.
5. `autoTitle` fires in the background for any thread still
   carrying the placeholder title — the gate is `title ===
   DEFAULT_TITLE`, not "first exchange", so a previous failed
   attempt recovers on the next send. Realtime subscriptions
   keep the sidebar in sync across tabs and devices.

## Files

- `src/screens/Chat.svelte` — the screen itself. Drawer,
  composer, message list, thread lifecycle, plus the call
  sites for every other feature that hooks into chat.
- `src/lib/chat-loop.ts` — `runChatLoop`, `toVeniceMessage`, and
  the round-by-round orchestration. Split from the screen so the
  loop is unit-testable without a Svelte runtime.
- `src/lib/models.ts` — `ModelTier`, `MODELS`, `UTILITY_TIER`, and
  the `VENICE_*_MODEL` constants that every agent also imports.
- `src/lib/venice.ts` — the Venice REST client. `streamChat`
  returns an async generator of `StreamEvent`; `embed` is a
  synchronous fetch.
- `src/lib/supabase.ts` — thread CRUD, `addMessage`, message and
  thread realtime subscriptions.

## Entry points

- **Send button / Enter** — `Chat.svelte`'s `send()` builds the
  history, creates an `AbortController`, and calls
  `runChatLoop(opts)`.
- **Stop button** — aborts the current controller. The loop is
  wired so the outer abort cancels every in-flight tool via
  `childController`; tool errors land as `role='tool'` rows with
  an error payload, so history stays internally consistent even
  on cancellation.
- **Draft creation** — "New thread" button creates an in-memory-
  only `Thread` row (`isDraft: true`). It materializes to
  Supabase on first send; never written as an empty shell. This
  prevents the drawer from accumulating empty threads when the
  user hits "new" repeatedly.
- **Realtime INSERT / UPDATE / DELETE** —
  `subscribeToThreads(userId, handlers)` drives sidebar
  consistency across devices. Each handler is a closure over
  `Chat.svelte`'s thread-list state.
- **Realtime message inserts** — `subscribeToMessages(threadId,
  onInsert)` keeps an open thread in sync when another tab
  answers on it (rare, but we handle it). Dedup is by
  `Message.id` at the append site.

## Data model

- **Threads** — `threads` table; `Thread` TS interface in
  `supabase.ts`. Fields the chat loop reads: `id`, `model`,
  `reasoning_effort`, `verbosity`, `tools_enabled`, `archived`.
  `created_at`/`updated_at` drive sidebar ordering. Drafts are
  never written to Supabase; the `isDraft?: boolean` app-local
  flag keeps them in memory only.
- **Messages** — `messages` table with OpenAI-shape tool support.
  Roles: `system | user | assistant | tool`. Columns the chat
  loop writes or reads: `content`, `tool_calls` (jsonb),
  `tool_call_id`, `name`, `model` (concrete Venice id captured at
  send-time, not the abstract tier), `usage` (jsonb — Venice's
  trailing `usage` SSE frame).
- **Model tiers** — `MODELS: Record<ModelTier, ModelSpec>`.
  `tier` is what persists (`threads.model` or
  `profiles.settings.defaultModel`); `id` is the concrete Venice
  model, resolved at send-time. This indirection lets us retune
  a tier without orphaning stored rows.
- **Reasoning effort** — same pattern: `profiles.settings.
  defaultReasoningEffort` or per-thread `threads.reasoning_effort`,
  resolved at send-time and only forwarded when
  `ModelSpec.supportsReasoning` is true (some providers 400 on
  the unknown field).
- **Verbosity** — `profiles.settings.defaultVerbosity` or
  per-thread `threads.verbosity`, resolved at send-time via
  `resolveVerbosity`. Forwarded unconditionally as
  `text.verbosity` (OpenAI-shape: nested under the top-level
  `text` object, not a flat field). No capability gate —
  providers that don't honor it silently ignore the knob.
- **Usage** — `messages.usage` stores
  `{ prompt_tokens, completion_tokens, total_tokens }` from
  Venice. Sourced by passing `stream_options:
  { include_usage: true }` on the request; Venice emits a final
  SSE frame with an empty `choices` array and a populated
  `usage` block. Drives the per-message context ring in the UI.

## Contracts

- `runChatLoop(opts): Promise<ChatLoopResult>` — opts must carry
  `venice`, `supabase`, `thread`, `userId`, `modelId`, `history`,
  `signal`, and optional `webSearch`, `reasoningEffort`,
  `handlers`. `history` is already in `VeniceMessage` shape
  (OpenAI roles, tool_calls, tool_call_id); the loop prepends its
  own system-prompt message each round and does NOT persist that
  prepend.
- `toVeniceMessage(m: Message): VeniceMessage` — projection
  between the DB row and the wire format. Handles the three
  shapes: plain text, assistant-with-tool-calls, and tool-result.
  Every feature that replays history should use this rather than
  building wire messages by hand; the shape is subtle.
- `streamChat(req): AsyncGenerator<StreamEvent>` — three event
  types: `{type:'text', delta}`, `{type:'tool_call', toolCall}`
  (fires once per call, after the accumulator has assembled the
  arguments JSON from its fragments), `{type:'usage', usage}`
  (fires once after the terminal event).
- `ChatLoopHandlers` — the event surface the UI uses: text
  updates, tool start/done/error, persistence events,
  `onToolsEnabledChange` (for the composer toolbox flash when
  `toggle_tools` fires). Every handler is optional; the loop
  runs cleanly with none of them.
- `MAX_ROUNDS = 5` — guardrail on runaway tool loops. Exits with
  `stoppedByLimit: true`; the UI shows a "tool-use round cap
  reached" banner.

## Interactions with other features

- **Tools** — every round's `streamChat` call passes `tools:
  buildToolList(toolsEnabled)`. Tool calls arrive as
  `StreamEvent` of type `tool_call`; `executeToolCall` dispatches
  them against the registry; results are persisted as
  `role='tool'` rows and echoed back in the next round's
  `history`. See `./tools.md`.
- **Memory (recall)** — `memory_recall` is a tool; the main model
  calls it whenever it judges prior context would help. The chat
  loop dispatches it like any other tool. See `./memory.md`.
- **Conversation recall** — same: `conversation_recall` is a tool
  that drops into the same executor path. See
  `./conversation-recall.md`.
- **Summaries / reflection** — no direct call; their triggers
  watch for a terminal assistant message newer than
  `last_summarised_msg_id` / `last_reflected_msg_id`. The chat
  loop creates that assistant message; the workers pick it up on
  their next poll. See `./summaries.md` and `./memory.md`.
- **Settings** — `Chat.svelte` reads `app.defaultModel`,
  `app.defaultReasoningEffort`, `app.defaultVerbosity`,
  `app.systemPrompts`, `app.webSearchEnabled` from the state
  store. Settings writes those values. System prompts
  configured as `enabledByDefault` seed the per-thread active
  set; per-thread toggles aren't persisted. See
  `./settings.md`.
- **Auth-session** — the screen renders only after `activate()`
  instantiates `app.supabase` + `app.venice`. A separate
  in-screen gate (`{:else if !session} <Auth />`) handles the
  Supabase auth step. See `./auth-session.md`.
- **Logging** - `Chat.svelte` mounts `<LogsDrawer />` on
  the right edge (same side as `<ExtractedTextDrawer />`)
  and owns the document-glyph button at the right end of
  the top bar that toggles it. Every diagnostic
  breadcrumb from any worker or tool surfaces there
  without needing devtools. See `./logging.md`.

## Gotchas

- **System prompts are re-assembled every round.** The baseline
  tool-framing system message is NOT persisted — it's built from
  the tool registry at request-time by `buildSystemPrompt`. User-
  configured prompts from Settings ride AFTER the baseline so a
  custom "you are a pirate" prompt still wins on voice while the
  tool framing stays in force. If you add a new tool, the model
  learns about it on the next turn automatically.
- **Concrete vs. abstract model ids.** `messages.model` stores
  the *concrete* Venice id (`'kimi-k2-5'`) captured at send-time,
  not the abstract tier. Retargeting a tier later doesn't rewrite
  history. `threads.model` stores the abstract tier (`'smart'`) —
  same reason, opposite direction (let retunes flow through).
- **The trailing `usage` SSE frame is optional.** Not every
  provider sends it, and a cancelled stream may drop it. `usage`
  is nullable in `messages` and the context ring renders nothing
  when either usage or the model's context window is missing.
- **Realtime echo of your own write.** `subscribeToMessages`
  delivers an insert event for every row including your own.
  The dedup-by-id at the append site handles both orderings
  (you resolve the `addMessage` promise before or after the
  realtime echo lands). If you add a second write path that
  doesn't pipe through the same `Message.id`, you get a
  duplicate render.
- **`autoTitle` uses `UTILITY_TIER`, not the thread's tier.**
  Titling a thread with the Smart tier would be silly; the fast
  tier is always adequate for "3-6 words summarizing the first
  message." Silent failure keeps the placeholder — and because
  the gate is `title === DEFAULT_TITLE` (not "first exchange"),
  the next send on that thread retries automatically. The seed
  passed in is the *opening* user turn, not the current one, so
  a retry titles the conversation's original topic rather than
  whatever follow-up triggered the retry.
- **`toggle_tools` is the only tool that mutates the loop's
  master switch in-flight.** Its return value is inspected
  specifically (`call.function.name === toggleTools.name`) to
  avoid a DB re-read. If you add another tool that also flips
  thread state, it needs similar special-casing or a refetch.
- **Drafts must not enter realtime state.** The draft's in-memory
  id is a freshly-minted UUID; if a draft leaks into `addMessage`
  before being materialized, the realtime `INSERT` handler sees a
  thread it doesn't have, and the list gets out of order. The
  `isDraft` flag gates this; don't remove it.
- **Venice can inject content into the user turn via two
  independent paths.** Both happen server-side — we never see or
  forward the injected content, so there is nothing to strip on
  our side:
  - `enable_web_scraping` (always on in `venice.ts`). When the
    user's latest message contains any URLs, Venice fetches their
    full content via Firecrawl and inlines the page text after
    the user's prose. Firing condition: a URL in the message.
    Independent of `enable_web_search` per Venice's docs; baseline
    cost when no URLs are present is zero.
  - `enable_web_search` (opt-in). When active, Venice splices a
    search payload plus platform framing ("you can use this real
    time information to answer the user's query above") into the
    user turn.

  Without help, the model misreads both kinds of injection as
  user-authored (observed: thanking the user for links they never
  sent, quoting snippets back as their words). Mitigation is
  two-part and unconditional: the system prompt's boundary block
  — which sits before the webSearch-gated hint block, not inside
  it — calls out the non-user origin and names both paths, and
  `runChatLoop` always wraps the current turn's user text in
  `<user_message>...</user_message>` via `tagLastUserMessage`.
  The tags are request-time only, never persisted. If you add
  another place that constructs wire messages for any Venice
  call, apply the same wrap — the wrap is no longer gated on
  `webSearch`, because scraping fires even with search off.

  There is also a companion rule in the webSearch block and its
  else branch: both branches mention the URL-scraping capability
  so the model doesn't refuse "what does this page say?" with a
  generic "I can't browse the web" on turns where search is off
  but a scraped page is sitting in the user turn ready to read.

## Where to go next

- `./tools.md` — the tool registry + two executors pattern.
- `./memory.md` — recall is a tool invocation from here; this is
  the other end of that wire.
- `./components.md` — `<Markdown>`, `<ToolCalls>`,
  `<ContextRing>`, `<ReasoningPicker>` are all mounted here.
- `./architecture.md` — the boot flow that gets us to this
  screen.
