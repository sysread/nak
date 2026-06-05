# Architecture

Nak is a Supabase-powered PWA. The browser shell renders the UI and
owns user-triggered single-action work (composer send, rename,
settings change, attachment upload). Long-lived correctness-critical
work - streamed chat turns, tool dispatch, embedding backfill,
attachment expiry - runs server-side in Supabase edge functions, which
hold the project-global Venice key and persist their own writes. Both
halves write to the same Supabase tables; the split is by
production-path ownership, not by which table each side touches (see
"Production-path ownership" below).

This page frames the top-level pieces - the boot flow, the phase
state machine, the data layer, the Venice adapter, the worker model,
and the row-ownership split - so individual feature docs have a
shared vocabulary to refer back to.

## Framework and build

- **Svelte 5 + Vite.** Runes-based reactivity (`$state`, `$derived`,
  `$effect`). Build is Vite 5; there is no SvelteKit router - the
  single-page shell is `src/App.svelte`, which phase-routes to one
  of three screens.
- **vite-plugin-pwa.** Generates the service worker and Web App
  Manifest. Offline caching is automatic for every bundled asset,
  including the user-facing docs imported via `import.meta.glob`.
- **TypeScript strict.** `src/app.d.ts` pulls in `vite/client` types
  so `import.meta.glob` is typed; `tsconfig.json` paths `$lib/*` to
  `src/lib/*`.
- **Entry point:** `src/main.ts` mounts `App.svelte` onto `#app`.

## Phase state machine

`src/lib/state.svelte.ts` owns the single reactive `app` object that
every screen reads. Three phases:

```text
 loading -------- setup       (no stored config)
          \----- unlocked    (config present + Supabase session live)
```

- `loading` - initial paint only, while `App.svelte` runs its
  session-restore check.
- `setup` - no `nak:config:v2` key in localStorage. Renders
  `Setup.svelte` to collect the Supabase URL + publishable key.
- `unlocked` - config is in memory, `SupabaseService` and
  `VeniceClient` are instantiated, background workers are running.
  Renders `Chat.svelte` which gates an internal `<Auth />` screen
  until the Supabase session lands.

`activate(config)` is the load-bearing transition: it stores the
config, news up the services, flips phase to `unlocked`, and starts
the background-worker fleet. Sign-out doesn't leave `unlocked` -
the screen renders `<Auth />` until the next sign-in - so there's
no separate "locked" phase any more. `resetForSignOut()` clears the
in-memory profile/system-prompt state so the previous account's
preferences don't bleed into a sign-in-as-someone-else.

## Session lifecycle

`src/lib/config.ts` owns the `nak:config:v2` localStorage blob -
plaintext JSON with the Supabase URL + publishable key. There is no
master password and no encrypted-at-rest envelope: the publishable
key is RLS-safe (every policy is `auth.uid() = user_id`), the
project URL is not a secret, and the Venice API key is project-
global and held server-side in `app_config`. The browser never
holds the Venice key.

The Supabase auth session itself (the JWT) is owned by
`supabase-js`'s own auth client and persists via its own storage
(`localStorage['sb-<project>-auth-token']`). The browser is signed
in until the user explicitly signs out or the refresh token
expires.

`src/lib/session.ts` keeps a tab-scoped pointer to the
last-active thread in `sessionStorage` so a refresh re-opens the
same conversation. Cleared on sign-out by the `signOut()` handler
in Chat.svelte; the localStorage config stays so signing back in
re-uses it without going through Setup.

The full writeup lives in `./auth-session.md`.

## Data layer — SupabaseService

`src/lib/supabase.ts` is the single class every UI and agent uses to
hit the user's Supabase project. Scope covers:

- Auth (`signIn`, `signUp`, `getSession`, `signOut`).
- Threads (`listThreads`, `createThread`, `renameThread`,
  `setThreadArchived`, realtime subscription).
- Messages (`listMessages`, `insertAssistantMessage`,
  `insertToolMessages`, etc.).
- Memories (`searchMemories`, plus RPC wrappers used by the
  `memory_*` tools).
- Settings (`getSettings`, `updateSettings`, `updateSystemPrompts`) —
  the `profiles.settings` JSONB blob.
- Worker coordination (`acquireWorkerLease`,
  `heartbeatWorkerLease`, `releaseWorkerLease`; per-source claim
  RPCs for memories + threads).

The file is large (~1300 lines). Everything is well-commented; its
size is not complexity, just the number of narrow method wrappers
over the generated Supabase client.

Security posture: the browser connects with the **publishable key**. Every
table has RLS enabled, and every policy is `auth.uid() = user_id`
(or a join via `threads`). The publishable key is safe to ship; the
secret key (service-role-class) never reaches the browser. The same file
comments this at the top — the comment is load-bearing.

### Conversation-recovery synthesis on read

`listMessages` runs every result through
`synthesizeRecoveryMessages` (`src/lib/conversation-recovery.ts`)
before returning. This walks the message list and inserts in-memory
recovery rows wherever the wire shape is invalid. Three failure
modes covered:

- Trailing `tool` row with no follow-up assistant, which trips
  "Unexpected role 'user' after role 'tool'" the moment the next
  prompt is appended.
- Trailing `assistant`-with-tool_calls whose results never landed,
  which trips "Not the same number of function calls and responses".
- Mid-conversation partial fan-in - an `asst_with_tool_calls` whose
  tool block is short by one or more results, followed eventually
  by another user/assistant turn. Same fan-in error as above, just
  buried in the transcript instead of at the end. Arises when the
  chat-loop crashed (or the device went offline) between persisting
  some-but-not-all tool rows and persisting the assistant follow-up.

The walk visits every `asst_with_tool_calls`, reads the consecutive
tool block that follows, fills in synthetic rows for any
unanswered `tool_calls[].id`, and inserts a recovery assistant
whenever the resulting tool block runs into a non-assistant message
(or end of conversation). It's naturally idempotent - a previously-
healed conversation walks to fully-resolved tool blocks on every
pass, so no new rows fire.

Synthesized rows carry `synthetic: true` (TS-only - never written
to the DB) and a `RECOVERY_MARKER` HTML comment in their content.
The marker lets the chat-loop's persistence path tell synthetic
rows from real ones; the model treats the comment as scratch
(same trick the intuition-think and opening-recall blocks use).

False-positive posture: the walk only synthesizes when an
`asst_with_tool_calls` has tool_call_ids missing from its
following tool block, OR when a complete tool block runs into a
user turn (which is itself a wire violation). Tool results
matched by id - the walk doesn't care about positional ordering -
so parallel tool fan-outs that complete out-of-order pass through
untouched. The full `tests/conversation-recovery.test.ts` file
pins the false-positive guards as load-bearing.

The chat-loop's send path (in `Chat.svelte`) calls
`persistSyntheticRecovery` ahead of the next user-message insert,
which writes the in-memory recovery rows to the DB so the
conversation heals permanently. Background workers don't write -
they regenerate the synthesis each cycle until the user revisits.

The `summary` agent's `condenseHistory` additionally trims its
head/tail seam via `trimToCompleteTurn` /
`trimToFirstUserOrSystem` from the same module: a long-thread
split can otherwise leave a `tool -> user` boundary mid-array
even on a healthy thread.

## Schema conventions

`supabase/schema.sql` is the single source of truth. It's applied
start-to-finish on every `mise run sync`, so **every statement must
be idempotent** (`create table if not exists`, `drop policy if
exists` + recreate, `do $$` guarded `alter publication`). The rules
at the top of the file are authoritative; the `./build-deploy.md`
page covers how `mise run sync` and the `sync-supabase` CI job
apply it.

Load-bearing patterns the schema uses repeatedly:

- **Columns over migrations.** New per-row state is an
  `add column if not exists`, not a new table. E.g. `threads` has
  grown `toolboxes_enabled`, `archived`, `summary`, `embedding`, plus
  reflection/summary/embedding claim columns — no migrations, just
  idempotent column adds.
- **Claim-RPC pattern.** Any row a background worker might process
  carries `<kind>_claim_holder text` + `<kind>_claim_expires
  timestamptz`. The RPC `claim_next_pending_<kind>` picks the oldest
  unclaimed row via `for update skip locked` and stamps it; the
  save RPC only commits if the claim still belongs to the caller
  (`where claim_holder = $me and claim_expires > now()`). A trigger
  (`clear_*_embedding_on_change`) nulls the claim on user edits so
  a stale in-flight save can't land. This is the concurrency
  primitive the entire worker subsystem relies on.
- **Partial claim indexes.** Each claim column has a partial index
  where the holder is non-null, so the index stays tiny in steady
  state (0 rows claimed is the common case).
- **`worker_leases` table + RPCs.** One row per
  `(user_id, worker_kind)` implements the "at most one device per
  worker kind" singleton. `acquire` / `heartbeat` / `release` RPCs
  are idempotent and `security invoker` so RLS still applies.
  `worker_kind` partitions the three workers so a device can hold
  all three leases concurrently. See `./embeddings.md` for the full
  story.

## Venice adapter

The Venice API key is project-global and held server-side in the
`app_config` table. Every Venice call (streaming chat, one-shot
chat, embeddings, text extraction, image generation, billing usage)
routes through the `venice` edge function, which reads the shared
key, talks to Venice, and relays the response. The browser never
holds the key. The split between the browser-side wire shape and
the function-side wire shape:

**Browser side** (`src/lib/venice.ts` and `src/lib/supabase.ts`):

- `VeniceClient.streamChat(req)` - async generator yielding
  `StreamEvent`s (`text`, `reasoning`, `tool_call`, `usage`,
  `citations`, `guard_retry`, `tool_call_response`, `END`,
  control events). Internally posts to the venice edge function's
  `/stream` route with a thread + anchor-message context,
  subscribes to the `thread:<id>:stream` Broadcast channel, and
  yields the function-published event union. Used only by the
  main user-facing chat (`chat-loop.ts`).
- `SupabaseService.complete(req)` - non-streaming one-shot,
  routed through the venice/complete route. Used by every
  background path: the intuition / samskara / summary / reflection
  / journal agents, the four recall agents (memory, conversation,
  wiki, journal), and the headless tool loop they share, plus the
  web_search / research_docs / analyze_image sub-tools.
- `SupabaseService.embed(req)` - per-query vector. Routes through
  venice/embed.
- `SupabaseService.extractText(file, filename)` - multipart upload
  to venice/text-parser for the per-attachment text extraction.

All four browser entry points share Venice's wire-body builder via
`buildChatBody(req, streaming)` exported from `venice.ts` - one
source of truth for tools, reasoning_effort, verbosity, web search,
response_format, and the model id. Browser code never sees the
Venice base URL; the function does.

**Function side** (`supabase/functions/venice/`):

- `/stream` - the streaming round chain. Owns tool dispatch, output
  guards, persistence, retry/control-channel fan-out. See
  [Streaming and tool dispatch in the venice edge function](./chat.md).
- `/complete`, `/embed`, `/text-parser`, `/usage`, `/image/generate`
  - one-shot relays.
- `/backfill` - service-role-only, the embedding backfill cron
  target.

See [`../../supabase/functions/README.md`](../../supabase/functions/README.md)
for the function-side layout and the Deno-island duplication stance.

Token-usage reporting still requires `stream_options:
{ include_usage: true }` on the request; the function forwards
Venice's trailing `usage` SSE frame as a typed `usage` event and
stores it on the assistant message row at terminal-commit time. The
browser's context-ring indicator reads it back from
`messages.usage`.

Web-search is configured via `venice_parameters.enable_web_search`.
The main chat loop maps the user's `webSearchEnabled` boolean to
`'on'` or `'off'` (not `'auto'` - `'auto'` leaves too many "I can't
access the internet" refusals on the table). Background agents
hardcode `undefined` on their requests so recall never inflates
search costs.

## Worker model

Background Web Workers run while the app is unlocked. The
browser-side workers are the agent fleet (embedding backfill is
server-side via `pg_cron` and the `venice` edge function - see
`./embeddings.md`). Two representative ones:

- `src/lib/agents/summary/worker.ts` — finds threads with a
  terminal assistant message newer than `last_summarised_msg_id`,
  runs the summary agent (fast model), writes `threads.summary`.
  Covered in `./summaries.md`.
- `src/lib/agents/reflection/worker.ts` — same trigger as summary,
  different outcome: reads the thread transcript and calls the
  memory tools via a headless tool loop to update long-term
  memory. Covered in `./memory.md`.

Each worker has a **manager** on the main thread
(`agents/*/manager.ts`) that handles
boot, cross-tab `navigator.locks` coordination, and Supabase
lease acquisition. The `activate()` path fires all three
`manager.start()` calls fire-and-forget; `lock()` calls the
matching `manager.stop()` which releases both the local Web Lock
and the Supabase `worker_leases` row so another tab can pick up
instantly.

Two layers of singleton enforcement:

1. **`navigator.locks.request('nak:<kind>-worker')`** — cross-tab,
   device-local. Queues competing tabs; only one holds the lock at
   a time.
2. **`worker_leases` RPC** — cross-device. Partitioned by
   `worker_kind`; a device may only process rows while it holds
   the lease, and a lapsed-lease worker stops mid-cycle rather
   than racing.

These two layers are independent. Either one alone prevents the
common case (two tabs in the same browser, two browsers on the
same account); the combination handles the edge case (the lapsed-
Web-Lock-while-holding-the-Supabase-lease race).

## Production-path ownership (browser vs edge function)

Both halves of nak are first-class writers to Supabase - the browser
calls `addMessage`, the venice edge function calls
`commit_assistant_message` and the tool-result inserts. The split
between them is **not** "which side touches the database." It's
**which side owns the lifecycle of the work that produces the row**.

Three categories of work:

1. **User-triggered single-action work — browser owns.** Composer
   send, thread rename, recipe edit, settings change, manual
   attachment upload. The production path is one click → one
   INSERT/UPDATE. A tab crash mid-click is "user retypes"; there
   is no state machine to recover, so the work doesn't need a
   runtime that outlives the trigger.

2. **Work that must survive the tab closing — function owns.** A
   streamed turn that may take 30+ seconds while the user closes
   the tab or background-suspends the PWA. The embedding
   backfill chewing through thousands of rows. Image generation.
   `EdgeRuntime.waitUntil` is the runtime contract these depend
   on - work registered with it survives the request that
   triggered it.

3. **Background derivation the user controls in-session — browser
   owns today.** Reflection, wiki, intuition, samskara, memory
   librarian, journaling, auto-title. Run while the app is
   unlocked; the user toggles them via settings. Losing them on
   tab close isn't a correctness problem, just a "work resumes
   next session." Long-term candidates for the function side as
   the cron + waitUntil pattern matures.

Each row in the database has exactly **one writer-of-record**, set
by which production path birthed it. The shared table is fine
because the granularity at which ownership is unambiguous is the
*row*, not the table. Inventory of who writes what during a chat
turn:

| Row | Writer | Production path |
| --- | --- | --- |
| `messages` (role=`user`) | Browser | Composer send |
| `messages` (role=`assistant`) | Function | Venice stream completion via `commit_assistant_message` |
| `messages` (role=`tool`) | Function | Tool dispatch in `performToolCall` |
| `messages` (role=`system`, recovery rows) | Function | Wire-shape repair during a turn |
| `tool_calls` | Function | Round loop in `getStreamingResponse` |
| `attachments` (user upload) | Browser | File picker / paste / drag |
| `attachments` (generated image) | Function | Per-round `attachGeneratedImages` |
| `threads` (insert) | Browser | New-thread button |
| `threads.title` (manual rename) | Browser | Inline-rename UI |
| `threads.title` (auto-title) | Browser (auto-title worker) | Background derivation, will likely migrate function-side |
| `threads.status` / streaming row state | Function | Round loop terminal kinds |
| `threads.last_error` | Function | Terminal-error path in `getStreamingResponse` |
| `topics`, recipe edits, memory rows, settings | Browser | Direct user action UIs |
| `topic_*` derivations | Function (cron) | Background pipelines |
| Embedding rows | Function | `pg_cron` + venice `/embed-backfill` |
| Worker-lease rows | Browser | Background agent managers |

The auto-title case is the test of the frame: the same
`threads.title` column has two writers, but they write for
different reasons in different production paths. The function
would write auto-title if it owned the streamed-turn lifecycle
end-to-end (the auto-title worker is the lingering browser-side
piece). The browser writes manual-rename because it owns the
inline-rename UI. Writer-of-record is a property of the
production event, not the column.

**Heuristic for new work.** Ask "could a tab close lose this and
that be a correctness problem?" If yes, it belongs function-side.
If no, browser is fine.

See `supabase/functions/README.md` for the function-side
perspective (which functions exist, what each one owns, the
"Deno island" pattern with respect to `src/lib`).

## Where state lives

| Scope | Where | What |
| --- | --- | --- |
| Reactive, in-memory | `app` rune in `state.svelte.ts` | Phase, services, user defaults, theme, system prompts, web-search toggle |
| Ephemeral per-tab | `sessionStorage` (last-active thread id) | The id the next refresh re-opens; cleared on sign-out |
| Auth session | `localStorage['sb-<project>-auth-token']` | Supabase JWT + refresh token; owned by supabase-js |
| Persistent per-origin | `localStorage['nak:config:v2']` | Plaintext Supabase URL + publishable key (no Venice key) |
| Persistent per-origin | `localStorage['nak:theme:v1']` | Cached theme (non-secret; used by the pre-paint boot script in `index.html`) |
| Per-account, remote | Supabase tables | Threads, messages, memories, profile settings, worker leases, embeddings - the data plane |
| Per-account, remote | Supabase Storage buckets | User file bytes - chat attachments, Library documents, recipe photos. Tables hold only a `storage_path` pointer; see [File storage](./file-storage.md). |
| Project-global, remote | `app_config` table | Venice API key, read server-side by the venice edge function. Browser never reads it. |

A new per-user setting lands in `profiles.settings` (JSONB) without
a schema change. A new per-thread flag lands via `alter table
threads add column if not exists`. A new worker-coordinated table
follows the claim-RPC pattern.

## Where to go next

- `./frontend-organization.md` — the UI-primitives /
  Svelte-composition split. How to decide which layer a
  change belongs in.
- `./components.md` — the Svelte components `Chat.svelte` and
  friends compose.
- `./chat.md` — the chat loop and the UI that drives it.
- `./auth-session.md` — the full session lifecycle picture.
- `./embeddings.md` — the canonical worker example; reflection and
  summaries follow the same shape.
