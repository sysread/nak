# Chat

The main user-facing surface plus the browser-side orchestration
that drives a single turn. `Chat.svelte` renders the drawer,
composer, and message list; `chat/loop.ts` builds the per-turn
priming chain and the system-prompt preamble, then issues one
`venice.streamChat` call that routes through the venice edge
function's `/stream` route. The function owns the streaming round
chain, tool dispatch, persistence, and error handling end-to-end.
Model-profile resolution and per-thread overrides also live here.

## Role in the app

A chat turn goes:

1. User types in the composer and clicks send. `Chat.svelte`
   `addMessage`s the user row (browser-owned: see
   [Production-path ownership](./architecture.md#production-path-ownership-browser-vs-edge-function)).
2. `Chat.svelte` resolves the effective model profile (per-thread
   pin -> default profile), builds the history in OpenAI shape, and
   calls `runChatLoop`.
3. `chat/loop.ts` runs the per-turn priming layers (samskara
   fire-and-compound, intuition, context recall), stitches their
   synthetic `<think>` blocks into the history, assembles the
   three-layer system-prompt preamble (baseline, user-configured,
   per-turn metadata), and issues a single `venice.streamChat` call.
4. The venice edge function takes over. Its round loop streams
   from Venice, dispatches tool calls server-side, persists each
   non-terminal round (the tool-using assistant row, then one
   `role='tool'` row per call) before looping, commits the terminal
   round via the `commit_assistant_message` RPC, and broadcasts
   typed events on `thread:<id>:stream` so the browser's UI stays
   live.
5. `chat/loop.ts` consumes those events and routes them to the
   UI handler surface (streaming bubble, reasoning panel, tool
   timings, rate-limit indicator, slop-notice cards). At the END
   event it captures the persisted assistant row id + terminal
   kind, fires `onAssistantPersisted`, and writes the samskara
   substrate stub.
6. The auto-title worker (background, not driven from
   `Chat.svelte`) polls for threads still on the `'New
   conversation'` placeholder and titles them. The worker shape
   exists so naming survives a tab close before the title call
   resolves. Realtime subscriptions keep the sidebar in sync
   across tabs and devices. See
   [./auto-title.md](./auto-title.md).

## Files

- `src/screens/Chat.svelte` - the screen itself. Drawer,
  composer, message list, thread lifecycle, plus the call sites
  for every other feature that hooks into chat.
- `src/lib/ui/message-blocks.ts`, `src/lib/ui/thread-buckets.ts`,
  `src/lib/ui/chat-screen.ts` - the screen's pure UI-primitive
  companions: the transcript render plan (tool-result folding,
  recovery-row hiding, the rename / generated-image / ask-user
  sibling blocks), the drawer's four-bucket list surgery, and the
  small scoped decisions (platform send-hint copy, rate-limit
  countdown). They sit alongside the per-feature companions the
  screen already used (`incomplete-turn`, `last-error`,
  `recovery-banner`, `streaming-bubble`, ...); the split contract
  is [frontend-organization.md](./frontend-organization.md).
- `src/lib/chat/loop.ts` - `runChatLoop`, `toVeniceMessage`, and
  the per-turn priming + event-routing orchestration. Issues one
  `venice.streamChat` call per turn; the function-side round
  chain takes over from there. Split from the screen so the
  loop is unit-testable without a Svelte runtime.
- `src/lib/models/index.ts` - `ModelProfile` (+ its coercion and
  the seed profile), `MODELS`, `AGENT_MODELS`, and the resolution
  helpers (`resolveModelProfile`, `defaultModelProfile`,
  `thinkingWireForProfile`, `profileModelSpec`) that every agent
  also imports.
- `src/lib/venice.ts` - the Venice wire-shape facade.
  `VeniceClient.streamChat` posts to the venice edge function's
  `/stream` route, subscribes to the per-thread Broadcast
  channel, and yields a typed `StreamEvent` union. Background
  callers go through `SupabaseService.complete` instead. See
  [Venice adapter](./architecture.md#venice-adapter) for the
  full split.
- `src/lib/supabase.ts` - thread CRUD, user-message inserts,
  message and thread realtime subscriptions, and the
  function-routing chat methods (`complete`, `embed`,
  `extractText`).
- `supabase/functions/venice/` - the function-side round chain,
  tool dispatch, persistence, broadcast fan-out. See
  [`../../supabase/functions/README.md`](../../supabase/functions/README.md).

## Entry points

- **Send button / Enter** — `Chat.svelte`'s `send()` builds the
  history, creates an `AbortController`, and calls
  `runChatLoop(opts)`.
- **Stop button** - the send button's dual mode. While `sending`
  is true the paper-plane icon swaps for a filled square; the
  click handler calls `cancelStream` (`venice.ts`), which
  publishes a control message on `thread:<id>:control` to tear
  down the function-side round chain, and fires the outer
  `AbortController` to stop the local event consumer. The
  function persists whatever it had accumulated this round as a
  `status='aborted'` row with the `INTERRUPTED_MARKER`
  (`--- user interrupted response`) appended; a stop that landed
  before any text or reasoning streamed still persists a
  marker-only `'aborted'` row (`withInterruptedMarker('')`), so a
  deliberate stop is ALWAYS a first-class row rather than a bare
  user-message tail another device can't tell apart from a crash.
  A mid-tool-execution stop persists the in-flight tool's row with
  an error envelope (no marker on the assistant row in that case -
  the tool row already records the cancellation). The function
  emits an `END` event with `terminalKind: 'aborted'` so the
  browser knows the stop landed; `ChatLoopResult.interrupted` lets
  the UI suppress the "something went wrong" banner. The
  persisted `status='aborted'` is the cross-device signal: the
  transcript-tail classifiers
  (`incompleteTurnTail`, `isReasoningOnlyStall`,
  `isCutOffPartialText`) all treat an aborted tail as a deliberate
  endpoint and never offer it for retry, so a second device that
  opens the thread reaches the same verdict the stopping device
  did.
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
  send-time, not the profile id), `usage` (jsonb — Venice's
  trailing `usage` SSE frame).
- **Model profiles** — the user-defined named configurations in
  `profiles.settings.modelProfiles` (`ModelProfile[]` in
  `models/index.ts`): name + Venice model id + default thinking +
  default verbosity + a capability snapshot, exactly one flagged
  default. What persists on a thread is the profile ID
  (`threads.model`, null = track the default profile); the concrete
  Venice id is resolved at send-time via
  `resolveModelProfile(app.modelProfiles, thread.model)`, so renaming
  or re-pointing a profile never orphans stored rows. Unknown ids
  (deleted profiles, legacy pre-profile tier names like
  `'balanced'`) resolve to the default profile. Each profile carries
  a capability snapshot so resolution never has to wait on the
  lazily-fetched model catalog; accounts with no stored profiles get
  `seedModelProfiles()` in memory (one "Default" profile on
  deepseek-v4-flash, medium thinking, low verbosity). See
  [Settings](./settings.md).
- **Reasoning effort** — the per-thread value is a `ThinkingLevel`
  (`off` | low | medium | high), not a bare `ReasoningEffort`.
  Cascade `threads.reasoning_effort` (override) -> the profile's
  `thinking` default, resolved and split into wire knobs by
  `thinkingWireForProfile`: `off` ->
  `venice_parameters.disable_thinking`, the rest -> `reasoning_effort`.
  Only forwarded when the profile's `supportsReasoning` is true (some
  providers 400 on the unknown field).
- **Verbosity** — per-thread `threads.verbosity`, falling back to
  the profile's `verbosity` default at send-time. Forwarded
  unconditionally as `text.verbosity` (OpenAI-shape: nested under
  the top-level `text` object, not a flat field). No capability
  gate — most providers that don't honor the knob silently ignore
  it, but some model backends (GLM 5.x was the first observed)
  400 the whole request with "Extra inputs are not permitted,
  field: 'text'". Two-layer recovery, both server-side:
  - **Runtime fallback:** a strict-validation 400 naming a
    droppable optional field strips that field from the body in
    place and re-issues (see `DROPPABLE_WIRE_FIELDS` in
    `getStreamingCompletion.ts`), and emits a
    `wire_feature_rejected` signal. Only advisory knobs are in the
    droppable set — semantic fields (`tools`, `messages`) always
    surface as errors.
  - **Persistent memory:** the orchestrator records each discovery
    in the global `model_feature_rejections` table (model_id +
    feature, where feature is the wire FIELD name, `'text'`) and
    strips known-rejected features from the body at turn start
    (`feature-rejections.ts`), so the failing round-trip is paid
    once ever per model+feature, not per turn. Reads/writes are
    best-effort and fail open — the runtime fallback still
    recovers if the table is unreachable. Staleness is accepted
    like the profile capability snapshots: a backend that later
    adds support stays stripped until the row is deleted by hand.

  The browser reads the same table (`app.modelFeatureRejections`,
  hydrated in `refreshSettings` alongside `priceCaps`) to disable
  the matching controls in Settings -> Model profiles; see
  [Settings](./settings.md).
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
- `VeniceClient.streamChat(req): AsyncGenerator<StreamEvent>` -
  the browser-side handle. POSTs to the venice edge function's
  `/stream` route and subscribes to the per-thread Broadcast
  channel; yields the function-published event union. Event
  kinds include text/reasoning deltas, tool_call (fires once
  per call after the function has assembled fragments), usage
  (final), citations, guard_retry, tool_call_response (carries
  ok/error per dispatched tool), `round_committed` (a non-terminal
  round's assistant row was persisted - the round-boundary signal;
  see Gotchas), END (carries `terminalKind` and any conflict reason
  from `commit_assistant_message`), and control-channel events. Used
  only by this main user-facing chat loop - background callers use
  `SupabaseService.complete`.
- `SupabaseService.complete(req): Promise<ChatCompletion>` -
  non-streaming one-shot routed through venice/complete.
  Returns the same fields the streaming path would produce
  (`text`, `reasoning`, `toolCalls`, `usage`, `citations`,
  `finishReason`) as a flat record. Lower latency for headless
  callers (no SSE flush-per-token serialisation), and immune to
  provider-specific stream-only failure modes (e.g. the silent
  "stream completed with no text" condition the web_search tool
  kept hitting on Venice). 429 responses are retried
  transparently in this method (up to 5 attempts, honoring
  Retry-After / x-ratelimit-reset-* when present, falling back
  to a log10-spaced 1s -> 5s schedule otherwise, cancellable
  via `req.signal`); a stuck quota still surfaces as a
  `VeniceError(kind='rate_limit')` after retries exhaust. The
  streaming path has its own retry surface server-side - the
  function emits a `rate_limit_retry` event around the sleep so
  the UI can pulse a banner. Distinct from the 429 loop:
  `veniceComplete` (function-side, in `_shared/venice.ts`) retries
  *transient* upstream failures - an upstream 5xx or a connection
  drop - on a fixed `[500, 1500, 4000]ms` backoff before giving up,
  so a brief Venice hiccup no longer fails the whole non-streaming
  call (auto-title, intuition, context recall, web_search, and the
  summary/topics/bias agents all ride this path). 429 is excluded
  there on purpose - this `SupabaseService.complete` loop already
  owns it. A 502 from `/complete` therefore now means the retry
  schedule was exhausted (sustained outage), and the handler logs
  `kind`/`status`/message to the function logs since the edge
  gateway records only the bare status code.
- `ChatLoopHandlers` - the event surface the UI uses: text
  updates, tool start/done/error, persistence events,
  `onToolboxesEnabledChange` (for the composer toolbox flash
  when `toggle_toolbox` fires), `onGuardRetry` (a
  function-side output guard discarded a junk attempt and is
  re-rolling). Every handler is optional; the loop runs cleanly
  with none of them. (Generated images are NOT delivered through
  a handler: the function attaches them server-side per round and
  `GeneratedImageCard` resolves them by filename - see
  [./attachments.md](./attachments.md).)
- **Output guards** (`supabase/functions/venice/stream-guards.ts`)
  - generic "the completion came back wrong, re-roll it"
  machinery armed inside the function's streaming round. The
  function's SSE consumer (`getStreamingCompletion`) buffers
  the opening events of an attempt until the guards collectively
  `keep` it (then flushes and passes the rest through live) or
  `retry` it (drops the buffer, tears down that attempt, and
  re-issues with the guard's request mutation - typically a
  bumped temperature). A discarded attempt's events never reach
  the broadcast channel, so junk can't reach the browser. Cap
  `MAX_STREAM_GUARD_RETRIES` (4 retries plus the initial
  attempt); exhaustion routes to a terminal `error` END event
  with `kind: 'guard_exhausted'` for the UI to surface with a
  manual-retry button. First consumer: the **special-token-leak**
  guard, armed on models flagged `ModelSpec.leaksSpecialTokens`
  (`deepseek-v4-flash`, `deepseek-v4` today; the flag is also
  mirrored in `LEAKY_MODEL_IDS` function-side). Detection is
  function-side and **anchored to the opening** of the reply:
  it re-rolls when the response STARTS with a `<｜` / `<|`
  delimiter, walking the `RETRY_TEMPERATURE_SCHEDULE`
  (`[0.8, 1.0, 1.2, 1.4]`) so the re-roll samples differently.
  Server-side `stop` would match anywhere in the output and
  truncate a legitimate reply that mentions one of these
  sequences mid-stream (a real case for nak, whose users
  discuss these tokens); anchoring to the opening confines the
  guard to the actual failure mode. Models with no configured
  gotchas get an empty guard list and the wrapper is a
  transparent pass-through. UI side: `onGuardRetry` drops a
  transient "oops, all slop!" notice card
  (`ExchangeSlot.slopNotices`, copy from
  `src/lib/ui/slop-notice.ts`) that CRT-powers-off once the
  replacement persists.
- `MAX_ROUNDS = 24` - guardrail on runaway tool loops, enforced
  function-side in `getStreamingResponse`. When the round loop
  exhausts the budget without the model ever producing a terminal
  text round, the function transitions the assistant row to
  `'error'` and emits an END event with `terminalKind: 'error'`
  and `conflict: 'round_limit'`; the browser maps that onto
  `ChatLoopResult.stoppedByLimit` and surfaces the round-limit
  banner.
- `ChatLoopResult.awaitingUserAnswer` - non-null when the
  function-side round suspended on an `ask_user` tool call. The
  pending tool row is already persisted (carrying the
  `{__ask_user_pending__: true, question, options}` sentinel as
  content) so the wire shape stays valid; the function emits an
  END event with `terminalKind: 'suspended_for_ask_user'`, the
  browser surfaces the question via `AskUserCard`, and on submit
  `Chat.svelte` `UPDATE`s the same row's content to an
  `{__ask_user_answered__: true, answer, via, option_index?}`
  envelope, then re-invokes `runChatLoop` against the post-answer
  history. The substrate stub is skipped on suspend - it fires
  on whichever resumed run actually terminates the turn. The
  `cancelPendingAskUser` helper in `Chat.svelte` writes an
  `abandoned_on_*` answer envelope when the user reloads (mount-
  time scan in `selectThread`) or sends a new message instead of
  picking an option, keeping the wire shape valid in both cases.
  See `src/lib/tools/ask_user.schema.ts` for the sentinel/answer shapes
  and `src/lib/notifications.svelte.ts` for the foreground OS
  notification that fires when the suspension lands while the
  tab is backgrounded.

## Interactions with other features

- **Exchange** — the in-flight chat-turn state machine
  (`ExchangeSlot`, `ExchangeStore`, the cross-device claim)
  lives in `src/lib/exchange/`. `Chat.svelte` owns one
  `ExchangeStore` plus a per-tab `holderId`; every "is this
  thread mid-stream?" UI surface reads through `activeSlot?.X`
  and every chat-loop handler writes through the slot that
  `runExchange` resolved from `ctx.threadId`. See
  `./exchange.md` for the full lifecycle and the
  `respondingElsewhere` / observer-side wiring.
- **Tools** - every main-chat round's `/stream` request body
  carries `tools: buildToolList(thread.toolboxes_enabled)` assembled
  on the browser side. The function-side `performToolCall`
  dispatches each call against its own (ported) tool registry,
  persists results as `role='tool'` rows, and echoes them back into
  the next round's request. See `./tools.md`.
- **Memory (recall)** — `memory_recall` is a tool; the main model
  calls it whenever it judges prior memory context would help. The
  chat loop dispatches it like any other tool. See `./memory.md`.
- **Conversation recall** — same: `conversation_recall` is a tool
  that drops into the same executor path. See
  `./conversation-recall.md`.
- **Wiki / journal recall** — `wiki_recall` and `journal_recall`
  are their per-layer counterparts; same executor path, dedicated
  sub-agents. See `./context-recall.md`.
- **Umbrella `context` tool** — runs the deterministic three-layer
  gather (`gatherContextIndex`) and returns a structured index
  (memory facts verbatim; conversations + wiki by id); the system
  prompt nudges the model to consider this first when it wants broad
  context on the user. Same executor path. See `./context-recall.md`.
- **Summaries / journal** — no direct call; their triggers
  watch for a terminal assistant message newer than
  `last_summarised_msg_id`. The chat loop creates that
  assistant message; the background workers pick it up on
  their next poll. See `./summaries.md`.
- **Reflection** — driven directly from the completed-turn
  tail. `getStreamingResponse` (the streaming orchestrator)
  fires `reflectOneThread` via `EdgeRuntime.waitUntil` after
  the chat response ships, draining one day-gate-eligible
  thread from the reflection queue as background work. The
  chat loop creates the terminal assistant message that makes
  a thread eligible; reflection acts on it on the same turn's
  tail (after at least a calendar day has elapsed). See
  `./memory.md`.
- **Topics** — `Chat.svelte` owns the `selectedTopics` /
  `topicsVocabulary` state for the drawer's topic-filter
  dropdown and threads `selectedTopics` through the three
  bucket fetches + search + window-fetch. The realtime
  `onUpdate` handler refreshes the vocabulary when a row's
  topics column changes. The topics background worker
  populates `threads.topics`; the chat loop has no direct
  call path to it. See `./topics.md`.
- **Settings** — `Chat.svelte` reads `app.modelProfiles` and
  `app.systemPrompts` from the state store. Settings writes
  those values; `app.modelProfiles` feeds `resolveModelProfile` at
  send-time so an edited profile immediately drives the threads on
  it. System prompts configured as `enabledByDefault`
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

- **System prompts are re-assembled every round, browser-side.**
  The baseline tool-framing system message is NOT persisted - it's
  built from the tool registry at request-time by
  `buildSystemPrompt` in `chat/loop.ts`. User-configured prompts
  from Settings ride AFTER the baseline so a custom "you are a
  pirate" prompt still wins on voice while the tool framing stays
  in force. If you add a new tool, the model learns about it on
  the next turn automatically. (The function never edits the
  system preamble; it forwards what the browser sent.)
- **Concrete vs. abstract model ids.** `messages.model` stores
  the *concrete* Venice id captured at send-time, not the profile
  id - a historical record of which model answered the row.
  Nothing reads it back today (the context ring measures against
  the thread's current model, not this column); it's kept as
  provenance. `threads.model` stores the abstract profile id, so
  a profile edit flows through to its threads and a deleted
  profile never orphans a thread (unknown ids resolve to the
  default profile).
- **The trailing `usage` SSE frame is optional.** Not every
  provider sends it, and a cancelled stream may drop it. `usage`
  is nullable in `messages` and the context ring renders nothing
  when usage is missing. The ring's denominator is the thread's
  CURRENT profile's context window (passed into `AssistantBody`),
  not a lookup on `messages.model` - so an old row is measured
  against the model the user is on now, which is the window they
  actually have to manage. There is no retired-model registry.
- **Realtime echo of your own write.** `subscribeToMessages`
  delivers an insert event for every row including your own.
  The dedup-by-id at the append site handles both orderings
  (you resolve the `addMessage` promise before or after the
  realtime echo lands). If you add a second write path that
  doesn't pipe through the same `Message.id`, you get a
  duplicate render.
- **Auto-titling runs server-side, not from `Chat.svelte`.**
  The curation tail in the venice function
  (`supabase/functions/venice/agents/auto_title.ts`) claims
  threads still on the `'New conversation'` placeholder after
  each completed turn and titles them via the fast agent
  model; an hourly sweep catches what the tail missed.
  Surviving page closes / refreshes is the whole point - a
  fire-and-forget call from `Chat.svelte` would lose work
  whenever the user closed the tab before the title call
  resolved. The seed is always the *opening* user message
  (fetched in the same RPC that claims the row), so a retry
  titles the conversation's original topic rather than
  whatever follow-up triggered the retry. See
  [./auto-title.md](./auto-title.md).
- **`toggle_toolbox` is the only tool that mutates the round
  loop's gated-toolbox set in-flight.** The function-side round
  loop inspects each tool's name and, when it sees
  `toggle_toolbox`, applies the new toolbox-enabled set in
  memory (no DB re-read) and emits a `toolboxes_enabled_change`
  broadcast event so the browser can flash the composer
  toolbox button. If you add another tool that also flips
  thread state, it needs similar special-casing or a refetch.
- **The round boundary needs an explicit signal; the browser
  can't derive it.** The round loop runs inside the edge function
  now, so the browser sees only a flat stream of deltas. The live
  streaming buffers (`slot.streamingText` / `streamingReasoning`)
  accumulate `response_text` / `reasoning_text` deltas and reset
  ONLY on `onAssistantPersisted` (plus `stream_retry` / abort).
  The function fires that reset between rounds by publishing an
  `assistant_round_committed` event (carrying the just-persisted
  non-terminal round's row id) right after `persistRoundAssistantRow`;
  `venice.ts` maps it to a `round_committed` `StreamEvent` and the
  chat-loop consumer routes it through the same `onAssistantPersisted`
  hand-off the terminal round gets at END - reset the buffers, hand
  off to the persisted row's card. Without this event the buffers
  never clear between rounds: every round's text/reasoning
  concatenates into one live bubble that duplicates the per-round
  cards arriving over the messages realtime subscription, and
  reasoning interleaves across rounds out of order. The terminal
  round is NOT covered by this event - it commits via
  `commit_assistant_message` and is signaled by END. If you change
  how rounds persist, keep the boundary event paired with the
  non-terminal row insert or the live view silently regresses to
  the concatenation bug.
- **The terminal row's `created_at` is re-stamped at every round
  boundary so it sorts after the tool rows.** The function streams
  into one reused assistant row (`assistantRowId`), created lazily on
  the first `response_text` of the WHOLE turn. When the model narrates
  a preamble before calling tools, that row is born early - before the
  round's tool-result rows - and `commit_assistant_message` reuses the
  same id without touching `created_at`. Since every created_at-ordered
  view (`mergeMessagesById` on thread switch, `listMessages` on refetch)
  sorts ascending, an un-restamped terminal row sorts AHEAD of its own
  tool cards: the live arrival-order view reads `[tool1, tool2, tool3,
  response]`, then the response jumps to the front of the round on the
  first re-sort. The fix lives in `getStreamingResponse.ts` at the
  round-boundary reset (the same UPDATE that wipes the carried row's
  content to ''): it bumps `created_at` to `now()` after the round's
  tool rows are persisted, keeping the eventual terminal commit
  chronologically after them. If you stop reusing the streaming row
  across rounds, or move the commit off that row id, this re-stamp is
  the thing that was holding the card order together.
- **Regenerate's replaced rows are deleted by the commit RPC, not
  the browser.** Regenerate-from-here anchors the new stream on the
  turn's original user message while the replace range - the old
  assistant turn plus every later row, later user turns included -
  stays in the DB so a failed re-roll can un-grey it without data
  loss. Those ids ride the `/stream` request as `supersededIds`
  (`ExchangeContext` -> `runChatLoop` -> `streamCtx` -> the request
  body, uuid-validated in `handleStream`) into
  `commit_assistant_message`, which excludes them from its
  newer-user-message conflict check and deletes them in the same
  transaction that flips the new row to 'complete'. Without the
  exclusion, every mid-thread regenerate false-positives as a
  cross-device race at terminal commit ("This conversation was
  updated on another device...") because the slated-for-delete user
  rows are newer than the anchor. Browser-side, `runExchange`'s
  post-loop block only animates and prunes the view; its branch
  condition (non-empty trimmed text, no conflict) mirrors the RPC's
  own delete guard so the view never drops rows the server kept.
  Synthetic recovery rows never ride `supersededIds` (they have no
  DB row; see `persistedRowIds` in `src/lib/ui/regenerate.ts`) but
  stay in `pendingDeleteIds` for the in-memory prune.
- **Delete-from-here is a DIRECT client delete, not the commit RPC.**
  The trash button on a user message (`deleteFrom` in `Chat.svelte`)
  removes that message and every row after it with no re-run, so there
  is no `/stream` turn to carry `supersededIds`. It calls
  `SupabaseService.deleteMessages(ids)` straight against the table,
  gated by the "messages are self-deletable via thread" RLS policy.
  Correctness rests entirely on the schema's FK contracts, NOT on app
  cleanup: `message_attachments` cascade (their bucket objects are
  reclaimed best-effort, same order as `deleteThread`); every
  `threads.last_*_msg_id` watermark and `bias_observations`
  `evidence_message_id` is `ON DELETE SET NULL`, so the next
  reflection/summary/topics/wiki/evaluation cycle re-runs from a
  cleared mark; `samskara_substrate.user_message_id` and
  `samskara_fires.user_round` are soft pointers (no FK) whose rows
  survive and may go off-by-N, which the samskara design accepts. The
  range is computed by `computeDeleteFromRangeIds`
  (`src/lib/ui/message-delete.ts`) - the inclusive slice from the
  clicked user row to the tail, the mirror of regenerate's
  exclusive-of-the-anchor range. The fade-out/prune animation is the
  shared `fadeOutAndPruneRows` helper both this and regenerate call;
  on a delete failure the rows survived server-side, so the handler
  clears the greying and surfaces the error instead of pruning.
- **Reconnect POLLS the DB row; it does NOT resume the live stream.**
  When `selectThread` finds an in-flight turn no local slot is
  producing (fresh tab, hard reload, a backgrounded mobile PWA that
  got discarded), `reconnectInflightTurn` (`Chat.svelte`) re-attaches by
  POLLING `/stream reconnectOnly` via `awaitStreamSettled`
  (`venice.ts`) until the probe reports `noStreamInFlight`, showing a
  "Reconnecting" throbber (the `ExchangeSlot.reconnecting` flag) over
  the partial-so-far, then re-fetches the thread with `listMessages`
  and renders the committed rows. It deliberately does NOT re-subscribe
  to the Broadcast channel: those events are ephemeral with no replay,
  so a tab that was away missed whatever fired meanwhile - including the
  single END that signals completion. Re-subscribing only ever caught
  events from that point on, which is why the old broadcast-based
  reconnect surfaced a spurious "disconnected" banner (re-subscribe
  timing out on a not-yet-recovered mobile socket) or a wait for an END
  that already fired. The DB row's terminal status is the canonical
  "done" signal; the server-side stale-row janitor guarantees the poll
  always terminates even for a function that died ungracefully.
- **Two in-flight signals arm the reconnect, not one.** The
  `status='streaming'` assistant row only exists from the first
  content delta, so it cannot represent the priming stage
  (samskara / intuition / context recall) or a long reasoning-only
  stretch. The orchestrator therefore stamps
  `threads.stream_started_at` at turn entry (before priming) and
  clears it at terminal; `selectThread` arms the reconnect when
  EITHER a streaming row exists OR the stamp is fresh
  (`streamLikelyInFlight` in `src/lib/ui/stream-inflight.ts`, twin of
  the staleness rule in `resolveStreamContext`). The same freshness
  verdict suppresses the orphan-draft check and the
  `incompleteTurnTail` cut-off banner - before the stamp existed, a
  refresh during the pregame found no streaming row, concluded the
  turn was dead, and offered "response was interrupted" retry banners
  for a turn still running under `waitUntil`. The `/stream` probe
  honors the stamp too (returning an in-flight envelope with
  `assistantRowId: null`), which also extends the duplicate-send
  guard across the priming window. Two operational notes. (1)
  `selectThread` reads the stamp via a `getThreadStreamState` point
  read, NOT via `findThread` - on a cold page load the route effect
  opens the URL's thread before the sidebar buckets have fetched, so
  the local thread copy doesn't exist yet and a bucket-based read
  misses the stamp on exactly the reload this path exists for. (2)
  The whole path emits Logs-drawer breadcrumbs at debug: the browser
  logs thread-open signals, reconnect arming/settling, and every
  recovery-banner transition (with a DOM census that warns if more
  than one banner node ever renders) under the `chat` source; the
  function logs the stamp write/clear and each probe's verdict under
  the `stream` source.
- **A live stream that drops mid-turn hands off to the same poll.**
  The case the `selectThread` reconnect could NOT cover: a tab whose JS
  context SURVIVED a background cycle (or hit a transient network blip)
  keeps draining its ORIGINAL live subscription, which silently went
  dead. Broadcast has no replay, so the terminal END may have fired into
  the dropped socket; the drain would otherwise await it forever (hung
  spinner) or unwind without it (spurious "cut off" banner) even though
  the edge function finished the turn and committed the row. The fix is
  disconnect-driven, not visibility-driven: `setupStreamSubscription`
  (`venice.ts`) keeps listening to the channel's status callback after
  the initial SUBSCRIBED, and a later `CHANNEL_ERROR` / `TIMED_OUT` /
  `CLOSED` that this tab did not initiate flips `disconnected` and closes
  the drain, which then throws `StreamDisconnectedError`. That propagates
  through `chat/loop.ts` to `runExchange`'s catch, which releases the
  slot and calls `reconnectInflightTurn` - the exact poll-the-row path
  above, seeded with the partial the dropped stream had buffered. So a
  mid-turn drop degrades gracefully to the reconnect poll instead of
  lying about the turn's outcome. Tradeoff: a transient blip downgrades
  the REST of that turn from token-by-token live rendering to the ~2.5s
  reconnect-poll cadence; correctness over smoothness, since any gap
  risks a missed END. A caller abort (user Stop) is exempt - the server
  publishes its own END(aborted) and the abort signal suppresses the
  disconnect throw.
- **A cut-off reply's partial is preserved as a card, not dropped.**
  Two coupled pieces make this work, and they break as a pair if you
  touch one without the other. (1) Server: `ensureAssistantRow` fires
  on the first `response_text`, so a turn that streamed only reasoning
  (then errored, or "thought" without answering) would leave
  `assistantRowId` null and persist nothing. The terminal-write block
  in `getStreamingResponse.ts` therefore creates the row at finally
  time: for an `error` terminal only when content or reasoning
  accumulated (an empty error row has nothing to show and renders
  through `threads.last_error` instead), so the partial lands as a
  `status='error'` row carrying the reasoning. An `aborted` terminal
  ALWAYS creates the row even with nothing accumulated - a deliberate
  stop must persist as a `status='aborted'` marker-only row so it is a
  first-class, cross-device-visible record rather than a bare
  user-message tail another device would read as a crashed turn and
  offer to retry. (2) Browser: the live streaming bubble is
  gated on `activeSlot.sending` alone, so it unmounts the instant the
  turn ends - the persisted DB row is the ONLY thing that can show the
  partial afterward. The drain in `venice.ts` no longer `close()`s on
  the `error` broadcast event (END is the sole terminal), and
  `consumeStreamEvents` (`chat/loop.ts`) stashes the terminal error
  instead of throwing immediately, throwing only AFTER the post-loop
  `onAssistantPersisted` hydration has handed the persisted partial to
  its card. Without the deferral the throw races ahead of hydration and
  `runExchange`'s catch clears the buffers into a void; without the
  server-side row there's nothing to hydrate. The retry affordance
  (`displayedError` for a partial-text tail, the cut-off banner for a
  reasoning-only one) then replaces the card on click - see
  `retryIncompleteTurn` and `src/lib/ui/incomplete-turn.ts`.
- **The streaming reasoning panel opens once, then yields - it is
  never re-pinned open.** The first `reasoning_text` delta of a round
  opens the panel (and stamps `slot.reasoningStartedAt`); from there
  the ONLY automatic close paths are (a) it crosses a length/sentence
  boundary mid-thought (`reasoningShouldCollapse` in
  `src/lib/ui/reasoning-panel.ts` - floor 80 / ceiling 600 chars,
  first sentence end past the floor in between), or (b) ~600ms after
  the first answer delta. A short thought that never crosses the
  boundary stays open to the hand-off. Crucially the panel is NOT
  re-opened on every delta - the prior shape did that, which made a
  mid-stream collapse impossible because the next delta snapped it
  back open. A header click sets `slot.reasoningUserToggled`, which
  latches OFF every automatic open/close for the rest of the round
  (the user's choice is law); it resets per round in
  `onAssistantPersisted`. While streaming the header carries two pills
  - elapsed-ms (frozen at `reasoningEndedAt`, the first answer delta)
  and a live char count - driven by the same rAF `nowMs` ticker as the
  tool-duration pills; that ticker's `$effect` gate now also runs while
  reasoning is live, and the outer `finally` freezes
  `reasoningEndedAt` so an abort mid-thought can't spin it forever.
  None of this timing is written to Supabase. At persist time
  `onAssistantPersisted` freezes the final pills into the in-memory
  `reasoningPillsById` map (keyed by message id, active thread only),
  which `AssistantBody` reads so the pills survive the handoff from
  streaming bubble to persisted card and stay on the row for as long as
  the thread is loaded. A cold reopen has no in-memory entry and renders
  the header bare - same elision as the tool-duration pills.
- **Drafts must not enter realtime state.** The draft's in-memory
  id is a freshly-minted UUID; if a draft leaks into `addMessage`
  before being materialized, the realtime `INSERT` handler sees a
  thread it doesn't have, and the list gets out of order. The
  `isDraft` flag gates this; don't remove it.
- **The main chat loop does not ask Venice to auto-inject
  reference material into the user turn.** Both
  `enable_web_scraping` and `enable_web_search` are caller-gated
  in `venice.ts` and neither is set on the main loop's request.
  Live web search flows through the `web_search` tool (see
  `./tools.md`), which runs its own one-shot sub-completion with
  `enable_web_search: 'on'`, `enable_web_citations: true`, and
  `enable_web_scraping: true` (so a research query that quotes
  a URL can pull the page content), and returns
  `{answer, citations}`. The chat loop harvests those citations
  into a turn-scoped list and persists them on the terminal
  assistant row so the `CitationsPanel` and `^N^` superscript
  rendering have data to draw against.

  Historical context: scraping was unconditional on every
  completion, which auto-inlined any URL the user pasted into
  the user turn. The model misread that content as
  user-authored (observed: thanking the user for links they
  never sent, quoting snippets back as their words). The
  mitigation at the time was structural - a system-prompt
  boundary block plus an unconditional `<user_message>` fence
  around the current turn, with a `<datetime>` tag and an
  optional `<system_reminder>` directive riding outside the
  fence. With the URL-scraping flag flipped off, the fence
  came off too: the user message rides bare, datetime and
  title nudges moved into a dedicated per-turn metadata system
  message (see "Wire shape" below).

- **Wire shape (the request the browser ships to `/stream`).**
  `runChatLoop` assembles all four layers once per user turn
  and ships them as the initial request body. The function-side
  round loop appends new assistant / tool rows to the history
  between rounds but does not rebuild the layers; the trailing
  metadata block's wall-clock paragraph is therefore captured
  at send-time and stays static across tool rounds within the
  same turn. Four layers:

  1. **Baseline system prompt** (`buildSystemPrompt`) -
     identity, voice, the uncertainty / anti-fabrication
     protocol (admit the gap or close it with tools before
     answering; never invent citations or specifics to sound
     authoritative), recall framing, journal/wiki framing,
     toolbox framing, activity-narration rule, dynamic
     catalog. Fully stable across rounds *and across toolbox
     toggles* - the catalog is state-free (it lists what
     toolboxes exist, not which are enabled). The volatile
     `(on)`/`(off)` state moved into the trailing metadata
     message (layer 4) so a `toggle_toolbox` flip doesn't
     re-encode the whole prefix; nothing in this layer varies
     per turn.
  2. **User-configured system prompts** - whatever's enabled
     in Settings -> Prompts for this thread, in order.
     `Chat.svelte` ships them at the head of `history`; the
     chat-loop walks the preamble in `splitSystemPreamble`
     and re-emits them right after the baseline.
  3. **Conversation** - the user/assistant/tool rows the chat
     loop is responding to, plus synthetic ephemeral
     `<think>` blocks pushed after the user turn in the
     priming chain: context-recall (stitched four-layer
     note), samskara compound prose, samskara situational
     fire (with parenthetical confidence hedges keyed off
     the score), and intuition synthesis. Each push is
     skipped when its source has nothing to say so we never
     burn tokens on empty `<think>` blocks.
  4. **Per-turn metadata system message** (`buildMetadataSystemMessage`) -
     a single system row composed once per turn, pinned at the
     TAIL of the request (after the conversation), carrying
     identity facts (user name + location when set), a
     wall-clock prose paragraph (local ISO 8601 + IANA zone +
     UTC + a "since your last reply" sentence on mid-thread
     turns), the gated-toolbox `(on)`/`(off)` state block
     (right after the datetime; `buildToolboxStateBlock`), the
     thread-attachments inventory, the emphasis-markdown nudge
     when the toggle is on, and the title nudge (loud nag when
     the title is still the schema placeholder, soft drift hint
     when a model-set title might need refreshing). The opening
     turn is silent on the title - the auto-title worker owns
     naming there. With a reliable worker the loud nag rarely
     fires; it's the safety net for the case where the worker
     hasn't polled the row yet.

  **Why metadata rides at the tail, not before the conversation.**
  Venice (like every OpenAI-compatible backend) can only reuse a
  cached prompt prefix that is byte-identical from token 0. The
  metadata block carries a wall-clock timestamp that changes every
  turn, so positioned ahead of the conversation it shifted the
  first-differing byte to the top of the transcript and forced the
  entire history to be re-encoded on every turn and every tool round -
  the conversation never cached. Pinned after the conversation, the
  stable baseline + user-system + growing history form a cacheable
  prefix; only this small trailing block (plus the regenerated
  `<think>` priming, volatile turn-to-turn regardless) falls outside
  the cache. The tradeoff: the model reads ambient context after its
  `<think>` chain rather than just before the user turn, and the final
  wire row is `role:system` rather than the intuition `<think>`.

  The gated-toolbox `(on)`/`(off)` state rides in this trailing block
  for the same reason. It used to live in the baseline catalog, where a
  mid-conversation `toggle_toolbox` flip shifted the first-differing
  byte back to the top of the baseline and busted the whole prefix -
  the same failure the datetime move fixed, re-introduced by a
  different volatile field. Moving it to the trailing metadata block
  (right after the datetime) and leaving the baseline catalog
  state-free keeps the baseline byte-identical across toggles, so a
  toggle re-encodes only this small block.

  `buildDatetimeParagraph` formats the wall-clock paragraph in
  ISO 8601 at **minute granularity** (local with offset, UTC Z form,
  IANA zone label). Seconds are dropped deliberately so the trailing
  metadata block stays byte-stable across tool rounds inside the same
  minute - a seconds-precision clock would defeat the prefix cache on
  the very block the tail-pinning is meant to keep cacheable.
  The "Your last reply on this thread was ..." sentence rides
  only on mid-thread turns where `lastAssistantTimestamp` is
  set - `Chat.svelte` walks its `messages` array for the
  latest persisted `role==='assistant'` row that isn't in
  `pendingDeleteSet`, and `formatRelativeDuration` buckets the
  wall-clock delta into a coarse human-friendly string. The
  sentence is OMITTED on the opening turn (no prior assistant
  to anchor against) and when the supplied timestamp doesn't
  parse, so a fresh thread never carries a misleading "just
  now". Synthetic ephemeral injections (intuition /
  context-recall / samskara `<think>` blocks) aren't persisted
  and therefore not eligible anchors - the semantic is "how
  long since you last actually replied to the user?", not
  "since any assistant-role row appeared on the wire."

## Where to go next

- `./tools.md` — the tool registry + two executors pattern.
- `./memory.md` — recall is a tool invocation from here; this is
  the other end of that wire.
- `./components.md` — `<Markdown>`, `<ToolCalls>`,
  `<ContextRing>`, `<ReasoningPicker>` are all mounted here.
- `./architecture.md` — the boot flow that gets us to this
  screen.
