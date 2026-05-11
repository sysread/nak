# Architecture

Nak is a single-page PWA. Everything runs in the browser: the model
calls go directly to Venice, the persistence goes directly to the
user's Supabase project, and the app ships no server of its own. This
page frames the top-level pieces — the boot flow, the phase state
machine, the data layer, the Venice adapter, and the background
worker model — so individual feature docs have a shared vocabulary
to refer back to.

## Framework and build

- **Svelte 5 + Vite.** Runes-based reactivity (`$state`, `$derived`,
  `$effect`). Build is Vite 5; there is no SvelteKit router — the
  single-page shell is `src/App.svelte`, which phase-routes to one
  of five screens.
- **vite-plugin-pwa.** Generates the service worker and Web App
  Manifest. Offline caching is automatic for every bundled asset,
  including the user-facing docs imported via `import.meta.glob`.
- **TypeScript strict.** `src/app.d.ts` pulls in `vite/client` types
  so `import.meta.glob` is typed; `tsconfig.json` paths `$lib/*` to
  `src/lib/*`.
- **Entry point:** `src/main.ts` mounts `App.svelte` onto `#app`.

## Phase state machine

`src/lib/state.svelte.ts` owns the single reactive `app` object that
every screen reads. Phase transitions:

```text
 loading --------- setup            (no stored config)
          \------- locked           (stored config, no live session)
                     |
                     +--> unlocked  (activate(): master password accepted)
                     +--> edit-config (enterEditConfig(): fix mistyped keys)
 unlocked -------> locked           (lock(): user-initiated or TTL expired)
```

- `loading` — initial paint only, while `App.svelte` runs its
  session-restore check.
- `setup` — no `nak:config:v1` key in localStorage. Renders
  `Setup.svelte`.
- `locked` — encrypted config exists but no live session. Renders
  `Unlock.svelte`.
- `unlocked` — decrypted config is in memory, services are
  instantiated, workers are running. Renders `Chat.svelte`.
- `edit-config` — decrypted config in memory but services not
  instantiated. Renders `EditConfig.svelte`. Used when the user
  wants to fix a mistyped key without going through the chat UI
  first.

`activate(config)` is the load-bearing transition: it stores the
config, news up `SupabaseService` and `VeniceClient`, flips phase to
`unlocked`, persists a session blob, and fires three background
workers. On a session-restore path, `App.svelte` calls
`activate(config, { persist: false })` so the TTL isn’t bumped on
refresh. `lock()` tears all of that down and clears the session. Both
functions live in `state.svelte.ts`.

## Session lifecycle

Three pieces cooperate to keep the user's secrets where they belong:

1. **Encrypted at rest** — `src/lib/config.ts` owns the
   `nak:config:v1` localStorage blob. Contents are the three API
   keys (Supabase URL + anon key + Venice API key), AES-256-GCM
   encrypted under a PBKDF2-SHA256 key derived from the master
   password. Envelope format is versioned (`src/lib/crypto.ts`);
   primitives are Web Crypto, no external libraries.
2. **Decrypted in memory** — while unlocked, `app.config` holds the
   plaintext. No other decrypted copy exists except…
3. **Refresh bridge** — `src/lib/session.ts` mirrors the plaintext
   config to `sessionStorage` (`nak:session:v1`) along with an
   `expiresAt` timestamp. On refresh within the TTL (7d default),
   `App.svelte` skips the master-password prompt and calls
   `activate()` directly. sessionStorage clears when the tab closes;
   `App.svelte` also throttles activity events (keydown / pointerdown
   / scroll / focus) to `touchSession()` and runs a 30-second idle
   check that calls `lock()` on expiry.

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

Security posture: the browser connects with the **anon key**. Every
table has RLS enabled, and every policy is `auth.uid() = user_id`
(or a join via `threads`). The anon key is safe to ship; the
service-role key never reaches the browser. The same file comments
this at the top — the comment is load-bearing.

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

`src/lib/venice.ts` is the browser-side REST client for Venice's
OpenAI-compatible endpoints. Three chat methods matter:

- `streamChat(req)` — async generator yielding `StreamEvent`s
  (`text`, `reasoning`, `tool_call`, `usage`, `citations`).
  Implemented as a POST with SSE framing; we parse frames by
  splitting on `\n\n` because the browser's `EventSource` API is
  GET-only and can't set the `Authorization` header. Used ONLY by
  the main user-facing chat loop, where token-by-token rendering
  makes the app feel alive.
- `completeChat(req)` — non-streaming POST returning a single
  `ChatCompletion` record with the same fields as the streaming
  events would produce. Used by every background path: the
  intuition / samskara / summary / reflection / journal agents,
  the four recall agents (memory, conversation, wiki, journal),
  and the headless tool loop they share, plus the web_search /
  research_docs / analyze_image sub-tools.
  Background callers don't have a UI surface to render
  token-by-token into, and SSE costs measurable per-chunk latency
  the user can't see; non-streaming also sidesteps provider-
  specific stream-only failure modes (e.g. the silent
  "stream completed with no text" condition Venice's web-search
  flow used to throw on).
- `embed(req)` — synchronous `fetch` against `/embeddings`.

Both chat methods share their wire body builder via a private
`buildChatBody(req, streaming)` helper — toggling the `stream`
flag is the only difference, so a wire-shape change can't drift
between them.

Token-usage reporting requires `stream_options:
{ include_usage: true }` on the request; Venice emits a final SSE
frame with an empty `choices` array and a populated `usage` block
once the stream is done. The main chat loop stores that verbatim on
the assistant message row (`messages.usage`); the context-ring
indicator reads it back.

Web-search is configured via `venice_parameters.enable_web_search`.
The main chat loop maps the user's `webSearchEnabled` boolean to
`'on'` or `'off'` (not `'auto'` — `'auto'` leaves too many "I can't
access the internet" refusals on the table). Background agents
hardcode `undefined` on their requests so recall never inflates
search costs.

## Worker model

Three Web Workers run while the app is unlocked:

- `src/lib/embeddings/worker.ts` — polls memories and threads with
  null embeddings, claims one, calls Venice's `/embeddings`,
  writes the vector back via a claim-guarded RPC. Covered in
  `./embeddings.md`.
- `src/lib/agents/summary/worker.ts` — finds threads with a
  terminal assistant message newer than `last_summarised_msg_id`,
  runs the summary agent (fast model), writes `threads.summary`.
  Covered in `./summaries.md`.
- `src/lib/agents/reflection/worker.ts` — same trigger as summary,
  different outcome: reads the thread transcript and calls the
  memory tools via a headless tool loop to update long-term
  memory. Covered in `./memory.md`.

Each worker has a **manager** on the main thread
(`embeddings/manager.ts`, `agents/*/manager.ts`) that handles
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

## Where state lives

| Scope | Where | What |
| --- | --- | --- |
| Reactive, in-memory | `app` rune in `state.svelte.ts` | Phase, services, user defaults, theme, system prompts, web-search toggle |
| Ephemeral per-tab | `sessionStorage['nak:session:v1']` | Decrypted config + TTL + last active thread id |
| Persistent per-origin | `localStorage['nak:config:v1']` | Encrypted config blob |
| Persistent per-origin | `localStorage['nak:theme:v1']` | Cached theme (non-secret; used by the pre-paint boot script in `index.html`) |
| Per-account, remote | Supabase tables | Everything else (threads, messages, memories, profile settings, worker leases) |

A new per-user setting lands in `profiles.settings` (JSONB) without
a schema change. A new per-thread flag lands via `alter table
threads add column if not exists`. A new worker-coordinated table
follows the claim-RPC pattern.

## Where to go next

- `./components.md` — the Svelte components `Chat.svelte` and
  friends compose.
- `./chat.md` — the chat loop and the UI that drives it.
- `./auth-session.md` — the full session lifecycle picture.
- `./embeddings.md` — the canonical worker example; reflection and
  summaries follow the same shape.
