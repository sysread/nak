# Embeddings

The Web-Worker pipeline that vectorizes memories and thread
summaries so semantic search works. This doc also covers the
cross-tab Web Lock and the Supabase `worker_leases` /
per-row-claim pattern, because the embeddings worker is the
canonical example — reflection and summaries mirror the same
shape.

## Role in the app

A memory that's just been written is `embedding is null`; so is
a thread whose title or summary was just updated (trigger-
invalidated). The embeddings worker polls for rows in that
state, claims one, asks Venice's `/embeddings` endpoint for a
vector, and writes it back under a claim guard.

Downstream: `memory_search` and `conversation_search` run
cosine-similarity against these vectors. Unembedded rows are
covered by ILIKE fallbacks on the search side, so a just-
written memory is never invisible — just semantically
under-ranked until the worker catches up.

## Files

- `src/lib/embeddings/worker.ts` — Web Worker entry point.
  Constructs Supabase + Venice clients on this side of the
  structured-clone boundary (class instances don't clone) and
  drives `runOneCycle` until abort.
- `src/lib/embeddings/loop.ts` — `runOneCycle`,
  `napForResult`. State machine factored out of the worker for
  unit tests.
- `src/lib/embeddings/lease.ts` — `LeaseCoordinator`: wraps
  the three Supabase lease RPCs (`acquire_worker_lease`,
  `heartbeat_worker_lease`, `release_worker_lease`) plus the
  heartbeat interval. Owns the top rail of cross-device
  coordination. Reflection and summary workers also import
  this.
- `src/lib/embeddings/manager.ts` — main-thread supervisor.
  Cross-tab Web Lock (`nak:embed-worker`), starts/stops the
  Worker, passes config via a `StartMessage`.
- `src/lib/embeddings/types.ts` — `EmbeddingSource` interface
  and shared constants.
- `src/lib/embeddings/sources/memories.ts`,
  `sources/threads.ts`, `sources/journal.ts`,
  `sources/wiki.ts`, `sources/samskara-substrate.ts`,
  `sources/recipes.ts` — per-table adapters. Each knows how
  to claim one pending row, build the input string for
  Venice, and save the result under a guard.
- `supabase/schema.sql` — `worker_leases` table, lease RPCs,
  `claim_next_pending_memory` /
  `claim_next_pending_thread_embedding`,
  `save_memory_embedding_if_claimed` /
  `save_thread_embedding_if_claimed`, and the
  `clear_*_embedding_on_change` triggers.

## Entry points

- **`activate()` in `state.svelte.ts`** — calls
  `embeddingManager.start({ supabase, config })`. The manager
  acquires the cross-tab Web Lock, reads the auth session, and
  posts a `StartMessage` to the Worker with the access/refresh
  tokens so the worker can construct its own Supabase client.
- **`lock()`** — calls `embeddingManager.stop()`. Settles the
  Web Lock resolver (releases the lock), aborts the Worker,
  calls `release_worker_lease` so another device can take over
  instantly rather than waiting for the TTL.
- **Cycle driver** — `runOneCycle(ctx)` returns a `CycleResult`
  (`acquired-lease` / `polling` / `empty-queue` / `embedded` /
  `save-rejected` / `no-embedding` / `rate-limited` /
  `error`). `napForResult` maps each to a sleep before the
  next cycle.

## Data model

### Two layers of singleton enforcement

1. **`navigator.locks.request('nak:embed-worker')`** —
   cross-tab, device-local. Web Locks queue natively; we don't
   spin. The lock request returns a Promise that stays pending
   while we hold it; `stop()` settles that Promise, which
   releases the lock.
2. **`worker_leases` row** — cross-device. Keyed on
   `(user_id, worker_kind='embedding')`. `acquire_worker_lease`
   is atomic via `on conflict do update where ...`: the update
   only fires when the existing lease is ours (harmless
   refresh) or expired. `heartbeat_worker_lease` returns false
   if our lease lapsed and someone else took over — the
   coordinator stops the worker immediately rather than racing.

These layers are independent. Either one alone prevents the
common case; the combination handles the edge case (local Web
Lock released, Supabase lease still held — happens during a
crash-and-restart within the TTL).

### Per-row claim

Each source row carries `embedding_claim_holder` +
`embedding_claim_expires`. The `claim_next_pending_*` RPCs use
`for update skip locked` to atomically pick one row and stamp
it. The save RPC only commits if the claim still belongs to
the caller (`where claim_holder = $me and claim_expires >
now()`). A trigger nulls the claim columns (and the embedding
itself) on user edits, so an in-flight worker save can't land
a stale vector.

### Padding

Venice's current embedding model emits 1024 dims; the column is
`vector(2048)` for forward compat. `padEmbeddingForStorage`
zero-extends. Cosine similarity is invariant under zero-
extension.

### Timing

- `leaseTtlSeconds = 45`, `leaseHeartbeatMs = 20_000` — two
  beats per expiry window; a single missed beat stays inside
  the margin. Reflection and summary managers use the same
  numbers.
- Rate-limit back-off is 30s, error back-off is short (~5s),
  idle poll is ~20s. Timings live in `napForResult`.

## Contracts

- `EmbeddingSource` — per-table adapter:
  - `claim(holderId, ttlSeconds): Promise<PendingItem | null>`
    — returns one claimed row's `{id, input}` or null if the
    queue is empty.
  - `save(id, holderId, embedding, embeddingModel):
    Promise<boolean>` — true if the write landed (claim still
    ours), false if we lost the row (not an error).
- `PendingItem` — `{id, input}`; input is already prepared
  (truncated, composed). The worker does not know anything
  about the source's shape beyond these two fields.
- `runOneCycle(ctx): Promise<CycleResult>` — one observable
  state transition. Contract: never hold the lease after a
  `false` heartbeat, never double-save a claim, never retry a
  save that returned false.
- `LeaseCoordinator.isHolding` — the invariant every cycle
  checks before attempting work.

## Interactions with other features

- **Memory** — `memories` is one of the two registered sources.
  The `clear_memory_embedding_on_change` trigger ensures every
  edit reselects the row. See `./memory.md`.
- **Summaries** — `threads` is the other source. The
  `clear_thread_embedding_on_change` trigger fires when
  `title` or `summary` changes, so a fresh summary
  automatically reselects the row for re-embedding. See
  `./summaries.md`.
- **Memory recall** — `memory_search` vector path reads
  `memories.embedding`. ILIKE fallback covers unembedded rows.
  See `./memory.md`.
- **Conversation recall** — `conversation_search` vector path
  reads `threads.embedding`. ILIKE-on-title fallback covers
  unembedded rows. See `./conversation-recall.md`.
- **Reflection / summary / wiki workers** — share the
  `lease.ts` coordinator and the worker-leases table.
  Separate `worker_kind` values (`'reflection'`,
  `'summary'`, `'embedding'`, `'wiki'`,
  `'attachment_expiry'`, `'samskara'`) so a device can
  hold every lease concurrently. See `./memory.md`,
  `./summaries.md`, `./wiki.md`.
- **Cookbook** — `recipes` joined the registered-source list
  so the drawer's recipe search can rank by meaning. The
  `clear_recipe_embedding_on_change` trigger fires when
  `title | cooklang | source` change. The LLM-facing
  `recipe_list` tool still runs ILIKE-on-title only - the
  embedding pipeline is for the human drawer search. See
  `./cookbook.md`.
- **Auth-session** — worker startup is gated on an active
  Supabase session; `manager.start()` pulls the session from
  the Supabase client and passes tokens to the Worker. A
  lack of session exits the worker cleanly; the next
  `activate()` call will spin it up again. See
  `./auth-session.md`.
- **Logging** - the loop driver emits progress and error
  breadcrumbs through `createLogger('embed-worker')`.
  Worker-context entries postMessage to the main thread
  as `{type: 'nak-log'}` and appear in the in-app log
  drawer indistinguishably from main-thread entries with
  the same source tag. See `./logging.md`.

## Gotchas

- **Class instances don't structured-clone.** The manager
  passes primitives (Supabase URL, anon key, access token,
  refresh token, Venice key) via `postMessage`; the Worker
  reconstructs `VeniceClient` + `SupabaseClient` on its side.
  Handing a live service across the boundary looks fine and
  silently fails with opaque errors.
- **Two copies of the auth token.** The worker has its own
  Supabase client with its own copy of the session tokens.
  When the main-thread session refreshes, the worker's copy
  goes stale. The current design accepts that for simplicity
  — a lapsed worker token just fails the next RPC, the
  lease is released on error, and the main-thread manager
  will restart the worker on the next `activate()`. If you
  find yourself wiring token-refresh across the boundary,
  the simpler fix is "stop and restart the worker."
- **`save-rejected` is not an error.** The row was edited,
  the TTL lapsed, or the user deleted the memory. Drain to
  the next row; do not retry, do not log as error.
  Distinguishing this from a true save failure is why the
  save RPC returns boolean rather than throwing.
- **`no-embedding` shouldn't happen but does.** Venice
  occasionally returns an empty array for a non-empty input.
  Loop treats it as `save-rejected` (skip, move on) rather
  than a hard error — there's no useful recovery and a retry
  usually gets the same answer.
- **Rate-limit back-off is long on purpose.** 30s, not 5s.
  If Venice 429s us once, it's probably 429-ing every tab
  the user has open; backing off for half a minute lets the
  rate-limit window clear rather than hammering.
- **Heartbeat errors are recoverable; `false` return is
  decisive.** A thrown error just means "couldn't check, try
  again"; the server-side TTL catches any truly-dead worker.
  A `false` return means "your lease expired and someone
  else took over" — the coordinator stops the worker
  immediately, no more rows touched.
- **`LeaseCoordinator` is the worker's view of the lease,
  not the lease itself.** The Supabase row is authoritative.
  If the coordinator thinks it holds the lease but the
  server disagrees (clock skew past the TTL margin), the
  next heartbeat returns false and the worker stops. Don't
  add an "optimistic" path that skips the server check.

## Where to go next

- `./memory.md` — first consumer: memory search + the
  ILIKE fallback.
- `./summaries.md` — the sibling worker that produces the
  `threads.summary` field this feature then embeds.
- `./conversation-recall.md` — second consumer: thread
  search + recall.
- `./architecture.md` — the worker model in context.
