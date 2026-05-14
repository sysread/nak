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
- `src/lib/venice.ts` — the Venice REST client. Two chat-completion
  entry points: `streamChat` (SSE-streaming, used only by this
  chat loop) returns an async generator of `StreamEvent`;
  `completeChat` (one-shot non-streaming POST, used by every
  background path - sub-agents, headless tool loop, web_search /
  research_docs / analyze_image, the intuition / context-recall /
  samskara / summary pipelines) returns a flat `ChatCompletion`
  record. `embed` is a synchronous fetch.
- `src/lib/supabase.ts` — thread CRUD, `addMessage`, message and
  thread realtime subscriptions.

## Entry points

- **Send button / Enter** — `Chat.svelte`'s `send()` builds the
  history, creates an `AbortController`, and calls
  `runChatLoop(opts)`.
- **Stop button** — the send button's dual mode. While `sending`
  is true the paper-plane icon swaps for a filled square; the
  click handler routes to `stopStreaming()` (which fires the
  outer `AbortController`) instead of `send()`. Same for the
  submit-modifier Enter shortcut. Two phases:
  - *Mid-stream:* `runChatLoop` catches the `AbortError` inside
    its round loop, persists the accumulated `roundText` /
    `roundReasoning` / `roundCitations` with the
    `INTERRUPTED_MARKER` (`--- user interrupted response`)
    appended to content, and returns `{ interrupted: true }`.
    Tool-call fragments still being assembled in `venice.ts`
    are discarded; so are any fully-assembled-but-unexecuted
    `tool_call` events from the current round.
  - *Mid-tool-execution:* the outer abort cascades through every
    `childController`, in-flight tool fetches reject with
    `AbortError`, the tool executor's per-call catch maps those
    to error `role='tool'` rows, and `Promise.all(executions)`
    resolves normally. The next round's top-of-loop
    `signal.aborted` guard exits the loop and sets
    `interrupted: true` on the result. No marker - the error
    tool rows already record the cancellation.
  The `ChatLoopResult.interrupted` flag lets the UI suppress the
  "something went wrong" banner a generic catch would raise - the
  user asked for the stop, it's not a failure to report.
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
  `reasoning_effort`, `verbosity`, `toolboxes_enabled`, `archived`.
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
  `signal`, and optional `reasoningEffort`, `verbosity`,
  `handlers`. `history` is already in `VeniceMessage` shape
  (OpenAI roles, tool_calls, tool_call_id); the loop prepends its
  own system-prompt message each round and does NOT persist that
  prepend.
- `toVeniceMessage(m: Message): VeniceMessage` — projection
  between the DB row and the wire format. Handles the three
  shapes: plain text, assistant-with-tool-calls, and tool-result.
  Every feature that replays history should use this rather than
  building wire messages by hand; the shape is subtle.
- `streamChat(req): AsyncGenerator<StreamEvent>` — five event
  types: `{type:'text', delta}`, `{type:'reasoning', delta}`,
  `{type:'tool_call', toolCall}` (fires once per call, after the
  accumulator has assembled the arguments JSON from its
  fragments), `{type:'usage', usage}` (fires once after the
  terminal event), `{type:'citations', citations}`. Used only by
  this main user-facing chat loop - background callers use
  `completeChat`.
- `completeChat(req): Promise<ChatCompletion>` - non-streaming
  one-shot. Returns the same fields the streaming path would
  produce (`text`, `reasoning`, `toolCalls`, `usage`, `citations`,
  `finishReason`) as a flat record. Lower latency than streaming
  for headless callers (no SSE flush-per-token serialisation), and
  immune to provider-specific stream-only failure modes (e.g. the
  silent "stream completed with no text" condition the web_search
  tool kept hitting on Venice). The two methods share their wire
  body builder so behaviour stays in lockstep. 429 responses are
  retried transparently inside `completeChat` (up to 5 attempts,
  honoring Retry-After / x-ratelimit-reset-* when present, falling
  back to a log10-spaced 1s -> 5s schedule otherwise, cancellable
  via `req.signal`); a stuck quota still surfaces as a
  `VeniceError(kind='rate_limit')` after retries exhaust. Streaming
  chat has its own retry loop in `chat-loop.ts`
  (`streamChatWithRateLimitRetry`) because that path emits UI
  lifecycle events around the sleep; `completeChat` sits behind
  tool sub-calls and background agents with no UI surface, so the
  retry is silent except for a log entry.
- `ChatLoopHandlers` - the event surface the UI uses: text
  updates, tool start/done/error, persistence events,
  `onToolboxesEnabledChange` (for the composer toolbox flash when
  `toggle_toolbox` fires). Every handler is optional; the loop
  runs cleanly with none of them.
- `MAX_ROUNDS = 5` — guardrail on runaway tool loops. Exits with
  `stoppedByLimit: true`; the UI shows a "tool-use round cap
  reached" banner.

## Interactions with other features

- **Tools** - every main-chat round's `streamChat` call passes `tools:
  buildToolList(thread.toolboxes_enabled)`. Tool calls arrive as
  `StreamEvent` of type `tool_call`; `executeToolCall` dispatches
  them against the registry; results are persisted as
  `role='tool'` rows and echoed back in the next round's
  `history`. See `./tools.md`.
- **Memory (recall)** — `memory_recall` is a tool; the main model
  calls it whenever it judges prior memory context would help. The
  chat loop dispatches it like any other tool. See `./memory.md`.
- **Conversation recall** — same: `conversation_recall` is a tool
  that drops into the same executor path. See
  `./conversation-recall.md`.
- **Wiki / journal recall** — `wiki_recall` and `journal_recall`
  are their per-layer counterparts; same executor path, dedicated
  sub-agents. See `./context-recall.md`.
- **Umbrella `context` tool** — fans out all four recall agents in
  parallel (`runRecallFanOut`) and returns a single stitched note;
  the system prompt nudges the model to consider this first when
  it wants broad context on the user. Same executor path. See
  `./context-recall.md`.
- **Summaries / reflection / journal** — no direct call;
  their triggers watch for a terminal assistant message
  newer than `last_summarised_msg_id` /
  `last_reflected_msg_id` / `last_journaled_msg_id`. The
  chat loop creates that assistant message; the workers
  pick it up on their next poll. See `./summaries.md`,
  `./memory.md`, `./journal.md`.
- **Journal** — `chat-loop.ts` also reads
  today's automatic journal entry on the opening turn of
  each conversation (via
  `supabase.getJournalEntriesForDate(todayInZone(tz))`)
  and appends a `## Today's journal` block to the
  appendix so the main model has same-day reflective
  context without an explicit tool call. The Journal
  modal + drawer tab + Settings pane are parallel to the
  Cookbook surfaces. See `./journal.md`.
- **Settings** — `Chat.svelte` reads `app.defaultModel`,
  `app.defaultReasoningEffort`, `app.defaultVerbosity`,
  `app.systemPrompts` from the state store. Settings writes
  those values. System prompts configured as `enabledByDefault`
  seed the per-thread active set; per-thread toggles aren't
  persisted. See `./settings.md`.
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
- **`toggle_toolbox` is the only tool that mutates the loop's
  gated-toolbox set in-flight.** Its return value is inspected
  specifically (`call.function.name === toggleToolbox.name`) to
  avoid a DB re-read. The loop compares the new array to the
  previous one (order-insensitive) and only fires the UI
  notification on a real change. If you add another tool that
  also flips thread state, it needs similar special-casing or a
  refetch.
- **Drafts must not enter realtime state.** The draft's in-memory
  id is a freshly-minted UUID; if a draft leaks into `addMessage`
  before being materialized, the realtime `INSERT` handler sees a
  thread it doesn't have, and the list gets out of order. The
  `isDraft` flag gates this; don't remove it.
- **The main chat loop no longer asks Venice to auto-inject
  reference material into the user turn.** Both
  `enable_web_scraping` and `enable_web_search` are caller-gated
  in `venice.ts` and neither is set on the main loop's request.
  Live web search flows through the `web_search` tool (see
  `./tools.md`), which runs its own one-shot sub-completion with
  `enable_web_search: 'on'` + `enable_web_citations: true` +
  `enable_web_scraping: true` (so a research query that quotes
  a URL can still pull the page content) and returns
  `{answer, citations}`. The chat loop harvests those citations
  into a turn-scoped list and persists them on the terminal
  assistant row so the `CitationsPanel` + `^N^` superscript
  rendering the old always-on path fed keeps working.

  Historical context: scraping was unconditional on every
  completion, which auto-inlined any URL the user pasted into
  the user turn. The model misread that content as
  user-authored (observed: thanking the user for links they
  never sent, quoting snippets back as their words). The
  mitigation was structural - the system prompt's boundary
  block calling out non-user origin, plus an unconditional
  `<user_message>...</user_message>` wrap on the current turn
  via `tagLastUserMessage`. The fence is still load-bearing
  for the `<datetime>` tag and the optional
  `<system_reminder>` directive that ride outside it. If you
  add another place that constructs wire messages for any
  Venice call where reference material could ride outside the
  user's typed words, apply the same wrap.

  The same projection also prepends a per-turn `<datetime
  local="..." utc="..." zone="..." />` tag outside the
  user_message fence. LLMs have no clock - asked "what year is
  it?" the model either refuses or hallucinates from training-
  cutoff data. `buildDatetimeTag` formats the current wall-clock
  time in ISO 8601 (local with offset, UTC Z form) using the
  user's `journalTimezone` (falling back to the runtime's
  reported zone), and the system prompt's boundary block tells
  the model the tag is authoritative. The tag is recomputed
  every round of the loop, not once at send-time, so a long
  multi-tool turn reflects actual elapsed time.

  On mid-thread turns the same tag also carries
  `since_last_response="..."` (e.g. "about 22 hours",
  "yesterday", "about 3 days"). The chat-loop receives the
  most recent persisted assistant message's `created_at` via
  the `lastAssistantTimestamp` option (Chat.svelte walks its
  messages array for the latest role==='assistant' row that
  isn't in `pendingDeleteSet`), and `formatRelativeDuration`
  buckets the wall-clock delta into a coarse human-friendly
  string. The model uses it to calibrate register - resume
  vs. re-orient - on a thread the user revived hours or days
  later. The attribute is OMITTED on the opening turn (no
  prior assistant to anchor against) and when the supplied
  timestamp doesn't parse, so a fresh thread never carries
  a misleading "just now". Synthetic ephemeral injections
  (intuition / context-recall `<think>` blocks) aren't
  persisted and therefore not eligible anchors - the semantic
  is "how long since you last actually replied to the user?",
  not "since any assistant-role row appeared on the wire."

  The system prompt unconditionally mentions URL scraping so the
  model doesn't refuse "what does this page say?" with a generic
  "I can't browse the web" when a scraped page is sitting in the
  user turn ready to read.

## Where to go next

- `./tools.md` — the tool registry + two executors pattern.
- `./memory.md` — recall is a tool invocation from here; this is
  the other end of that wire.
- `./components.md` — `<Markdown>`, `<ToolCalls>`,
  `<ContextRing>`, `<ReasoningPicker>` are all mounted here.
- `./architecture.md` — the boot flow that gets us to this
  screen.
