# Auto-title

Background worker that gives each thread a topical 3-6 word title in
place of the `'New conversation'` placeholder. Replaces the
fire-and-forget call site that lived in `Chat.svelte`'s `send()` and
lost work whenever the user closed or refreshed the tab before the
single Venice call resolved.

## Role in the app

Every thread is created with `title = 'New conversation'`. The
auto-title worker polls the `threads` table for rows that are still
on that placeholder (and that the user hasn't manually pinned), claims
the oldest one, asks the small fast model
(`agentModel('autoTitle')` - currently `e2ee-gpt-oss-20b-p` via
Venice's e2ee tier) for a title against the first user message, and
writes the result back via a claim-guarded RPC. The cross-device lease
ensures only one device titles a given thread; the per-thread claim
covers the lease-handover race.

The chat-loop's per-turn metadata system message stays silent about
titles on round 1 (the worker owns naming there) and falls back to
the loud nag from round 2 onward when the title is still the
placeholder. With a reliable worker the nag rarely fires; it's the
safety net for the case where the worker hasn't polled the row yet.
See `./chat.md` for the metadata-message details.

## Files

- `src/lib/title-gen.ts` - `generateThreadTitle(venice, userText,
  signal)`. Single-shot Venice call against the autoTitle agent
  model. Returns the sanitised title or null on any failure
  (network, 4xx, abort, empty completion). Same shape the in-Chat
  trigger used to call; the worker just reuses it.
- `src/lib/agents/auto_title/loop.ts` - `runOneCycle`,
  `napForResult`. State machine factored out of the worker so it's
  unit-testable without a Web Worker runtime.
- `src/lib/agents/auto_title/worker.ts` - the Web Worker entry
  point. Constructs Supabase + Venice clients on the worker side
  (structured-clone won't carry class instances) and drives
  `runOneCycle` until abort.
- `src/lib/agents/auto_title/manager.ts` - main-thread supervisor.
  Cross-tab Web Lock (`nak:auto-title-worker`), starts/stops the
  Worker, passes config via a `StartMessage`.
- `src/lib/tools/update_title.ts` - the model-driven rename path
  the round-2+ nag triggers. Shares `sanitizeTitle` with
  `title-gen.ts` so manual + automatic + tool-driven renames all
  land with identical formatting.
- `supabase/schema.sql` (auto-title section) - the claim columns,
  `claim_next_thread_for_auto_title`,
  `save_thread_title_if_claimed`, `clear_auto_title_claim`.

## Entry points

- **`activate()` in `state.svelte.ts`** - calls
  `autoTitleManager.start({ supabase, config })` fire-and-forget.
  The manager acquires the Web Lock, reads the auth session, and
  posts a `StartMessage` to the Worker.
- **`lock()`** - calls `autoTitleManager.stop()`. Tears down the
  Worker, releases the Web Lock, releases the Supabase lease so
  another tab can take over instantly.
- **Cycle result driver** - inside the Worker, `runOneCycle`
  returns a `CycleResult` (`acquired-lease` / `polling` /
  `empty-queue` / `titled` / `no-title` / `claim-lost` /
  `error`). `napForResult` maps each to a sleep before the next
  cycle.

## Data model

- **`threads.title`** - the placeholder `'New conversation'` until
  the worker (or the user, or the model via `update_title`) writes
  a real title.
- **`threads.title_manually_set`** - sticky flag the user's title
  input flips. The claim RPC excludes rows where this is true; the
  save RPC re-checks it so a manual rename mid-flight beats the
  worker silently.
- **`threads.auto_title_claim_holder`** +
  **`threads.auto_title_claim_expires`** - per-row claim for
  cross-device coordination. Same shape as the
  reflection / summary / embedding claim columns; partial index on
  `auto_title_claim_holder is not null` keeps it tiny in steady
  state.
- **`worker_leases` row** - `worker_kind='auto_title'`. Partitioned
  from the other worker leases so a device can hold all of them
  concurrently.

## Contracts

- `generateThreadTitle(venice, userText, signal): Promise<string |
  null>` - one shot against the autoTitle agent model with
  `disableThinking: true` and `maxTokens: 64`. Null on any failure;
  the worker treats null as `no-title` and releases the per-thread
  claim so the next cycle can retry.
- `runOneCycle(ctx): Promise<CycleResult>` - one observable state
  transition. The Worker's outer loop maps each result to a sleep
  via `napForResult` before the next cycle.
- `claim_next_thread_for_auto_title(holder, ttl)` RPC - returns
  `{thread_id, user_text}` for the oldest eligible thread, or no
  rows when the queue is empty. Stamps the claim atomically. Eligible
  = title is the placeholder, `title_manually_set` is false, at
  least one user message exists, no live claim.
- `save_thread_title_if_claimed(thread_id, holder, title)` RPC -
  only writes if the claim is ours AND the row is still eligible
  (title still default, `title_manually_set` still false). Clears
  the claim atomically on a winning write. False return means a
  race; the worker drops the work as `claim-lost` and the next
  cycle simply skips the row.
- `clear_auto_title_claim(thread_id, holder)` RPC - releases the
  claim early when title-gen returned null so the row re-enters the
  queue immediately rather than waiting for the 60s claim TTL.
  Best-effort; the TTL is the authority on stuck claims.

## Interactions with other features

- **Chat** - chat's job is just to write messages. A first user
  message on a placeholder-titled thread is the auto-title trigger;
  the worker picks it up on its next poll. No direct call path. The
  chat-loop's round-2+ metadata-message nag (`update_title` tool)
  is the safety net when the worker hasn't yet processed the row.
  See `./chat.md`.
- **Tools (update_title)** - the model can write a title via
  `update_title` whenever the chat-loop nag fires. The save RPC's
  predicate guards against double-write: if the model lands a title
  while the worker has a row claimed, the save sees a non-default
  title and returns false; the worker drops the work as `claim-lost`.
  See `./tools.md`.
- **Embeddings** - the `clear_thread_embedding_on_change` trigger
  nulls `threads.embedding` whenever `threads.title` changes, so
  the embeddings backfill's next run re-embeds the thread with its
  freshly-titled state. See `./embeddings.md`.
- **Logging** - the loop driver emits progress and error breadcrumbs
  through `createLogger('auto-title-worker')`. Worker-side entries
  `postMessage` main-thread and surface in the in-app log drawer
  alongside main-thread entries. See `./logging.md`.

## Gotchas

- **Cold-start latency is `idleIntervalMs` at worst.** When the
  worker has just napped on an empty queue and a fresh thread shows
  up, the user waits up to 10s before the title appears. The old
  in-Chat trigger fired immediately, so this is a regression in
  the steady-state hot path - bought back as reliability when the
  page closes mid-flight.
- **`no-title` is not an error.** title-gen returns null on any
  failure (network blip, Venice 4xx, abort, model emitted
  whitespace). The worker releases the per-thread claim so the row
  re-enters the queue immediately. The next cycle will retry; if
  the failure is persistent, the row stays in the queue forever
  and the user keeps seeing the placeholder until something gives.
- **`claim-lost` is not an error.** The save RPC's predicate also
  guards against the user manually renaming the thread mid-flight
  AND against the model calling `update_title` mid-flight. Either
  case returns false from the save; the worker drains to the next
  row. The user-visible state is correct - someone else wrote a
  title, that's the title.
- **The eligibility predicate requires at least one user message.**
  A thread row with no messages (would only happen via direct DB
  write today; the UI always sends with a user message) is never
  claimed. If you ever introduce a "create empty thread" flow, the
  thread won't auto-title until a user message lands.
- **The autoTitle model is hardcoded to the fast tier.** Titling a
  thread with a smart-tier model would be silly; the fast tier is
  always adequate for "3-6 words from the opening message." See
  `agentModel('autoTitle')` in `src/lib/models/index.ts`.
- **Per-thread claim TTL (60s) is generous on purpose.** A single
  non-streaming Venice call against a 64-token cap should resolve
  in well under that, but a slow tier promotion or rate-limit
  retry can push it. If you ever switch the autoTitle model to
  something slower, dial the TTL up to keep margin.

## Where to go next

- `./chat.md` - the round-2+ `update_title` nag and the per-turn
  metadata message that owns it.
- `./tools.md` - `update_title` as a tool the model can call.
- `./summaries.md` - sibling background loop, same plumbing shape.
- `./architecture.md` - the worker model in context.
