# Embeddings

The pipeline that vectorizes memories, conversation transcripts, recipes,
wiki articles, and samskara substrate so semantic search works.
Backfill (turning `embedding is null` rows into vectors) runs
server-side on a `pg_cron` schedule behind the `venice` edge
function; the browser still embeds *search queries* synchronously at
each call site. This doc covers both halves plus the per-row claim
protocol the backfill drains through.

## Role in the app

A memory that's just been written is `embedding is null`; so is a
thread chunk the rechunk unit just rewrote, and the
same for recipes, wiki articles, and substrate rows. A `pg_cron` job
fires every minute, POSTs to the edge function's `/backfill`
route, and the function claims pending rows across all seven tables,
embeds them with the built-in gte-small model, and writes them
back under a claim guard - all server-side, no open tab required.

Embeddings are produced by `Supabase.ai.Session('gte-small')`, a
native Rust ONNX runtime pre-bundled in the edge-runtime Docker
image. No external API call, no Venice dependency. The model emits
384-dim vectors, zero-extended to the 2048-dim storage column by
`padEmbeddingForStorage`. Cold start (model load) takes ~7s on a
fresh worker; warm inference is ~100-180ms per call. The edge
runtime's 2s CPU-time budget per worker caps the backfill batch at
12 rows per invocation.

Downstream: `memory_search`, `conversation_search`, and the drawer
searches run cosine-similarity against these vectors. Unembedded
rows are covered by ILIKE fallbacks on the search side, so a just-
written memory is never invisible - just semantically under-ranked
until the next sweep catches up (at most ~1 minute).

The other direction - embedding a *search query* to run cosine
search - also goes through the function. `SupabaseService.embed`
calls `venice/embed`, which runs the query through
`Supabase.ai.Session('gte-small')` and returns a single vector
synchronously. Browser callers (`memory_search`,
`conversation_search`, the drawers, context recall) keep the same
`{ model, input } -> { data: [{ embedding }] }` request/response
shape they had against `VeniceClient.embed`; the only change at the
call site is which client handle they hold.

## Files

- `supabase/functions/_shared/local-embed.ts` - the
  `Supabase.ai.Session('gte-small')` wrapper. Module-scoped session
  persists across requests in the warm window. Exports `localEmbed`,
  the `string -> number[]` function all embed callers use.
- `supabase/functions/venice/index.ts` - the edge function.
  `/embed` is the thin per-call proxy (one vector for a query);
  `/backfill` is the cron target that runs the server-side drain.
  Service-role-only on `/backfill`.
- `supabase/functions/_shared/backfill.ts` - `runBackfill`, the
  claim -> embed -> pad -> save orchestration. I/O-free (injected
  deps) so it unit-tests offline. Also holds the ported
  `padEmbeddingForStorage` and the model constant (`EMBEDDING_MODEL`).
- `supabase/functions/_shared/embed-input.ts` - per-source text
  composition (which columns, soft boundary, char caps) plus the
  `EMBED_SOURCES` registry mapping each source to its claim RPC,
  save RPC, and input builder. Ported from the old browser adapters;
  kept in TS so truncation stays byte-identical to historical rows.
- `supabase/schema.sql` - the `claim_next_pending_*` /
  `save_*_embedding_if_claimed` RPCs (now `security definer` global
  sweeps; see below), the `clear_*_embedding_on_change` triggers,
  the `nak_trigger_embed_backfill()` dispatcher, and the `pg_cron` /
  `pg_net` setup block.

## Entry points

- **`pg_cron` -> `nak_trigger_embed_backfill()`** - every minute,
  the job calls the trigger function, which reads the `project_url`
  and `service_role_key` Vault secrets and `pg_net.http_post`s to
  `/functions/v1/venice/backfill`. No-ops if the secrets are
  unseeded, so an un-provisioned project simply doesn't backfill.
  The every-minute cadence (up from every 5) was set when the model
  switched from Venice's bge-m3 to local gte-small inference; once
  the re-embedding drain completes, the cadence can be relaxed.
- **`handleBackfill` in the function** - authenticates the caller as
  the service role by decoding the bearer JWT's `role` claim and
  requiring `role === 'service_role'` (the gateway's verify_jwt has
  already validated the signature). It then drives `runBackfill` over
  the seven sources, bounded by a batch cap (12 rows) and a time budget
  (30s) per invocation. The schedule resumes the drain next tick.
- **`runBackfill(deps, opts)`** - round-robins one claim attempt per
  source per pass; embeds and saves whatever it claims; stops when a
  full pass claims nothing (queue drained), the cap or budget is
  hit, or Venice rate-limits (back off, resume next tick).

## Data model

### Per-row claim

This is the mechanism the backfill drains through, unchanged in shape
from the browser era - only the driver moved. Each source row carries
`embedding_claim_holder` + `embedding_claim_expires`. The
`claim_next_pending_*` RPCs use `for update skip locked` to atomically
pick one row and stamp it with the invocation's holder id + a 120s
claim TTL. The save RPC only commits if the claim still belongs to the
caller (`where claim_holder = $me and claim_expires > now()`). A
trigger nulls the claim columns (and the embedding itself) on user
edits, so an in-flight save can't land a stale vector. The claim TTL
outlives a single invocation, so two overlapping ticks can't both save
the same row.

### Service-definer global sweep

The `claim_next_pending_*` / `save_*_if_claimed` RPCs are
`security definer` and sweep **every member's** pending rows with no
`auth.uid()` filter - cron has no user session, so a user-scoped
`security invoker` RPC (their original shape) would match nothing.
Because they now run as the owner and ignore user scoping, **the
EXECUTE grant is the security boundary**: each is revoked from
`public`/`anon`/`authenticated` and granted only to `service_role`.
Leaving them open to `authenticated` would let any signed-in member
claim and read another member's row text. The edge function (service
role) is their only caller.

### Padding

The gte-small model emits 384 dims; the column is `vector(2048)` for
forward compat. `padEmbeddingForStorage` zero-extends. Cosine
similarity is invariant under zero-extension. The function pads (not
the SQL) so the stored shape is consistent.

### Timing

- Cron cadence: every minute (`* * * * *`).
- Per-invocation bounds: 12 rows or 30s, whichever first. The 12-row
  cap is set by the edge runtime's 2s CPU-time budget: at ~130ms CPU
  per gte-small inference, 12 rows stays safely under the limit with
  headroom for claim/save RPC round-trips.
- Row claim TTL: 120s. No rate-limit back-off (local inference has no
  rate limits); the invocation bails on the time/row budget and the
  next tick resumes.

## Worker-fleet coordination (retired)

The cross-tab Web Lock + Supabase `worker_leases` + heartbeat
model is gone: the browser worker fleet retired, and every
background job coordinates through per-row claims instead (see
[`./architecture.md`](./architecture.md), "Background-job model").
The schema keeps only an idempotent teardown block that drops the
`worker_leases` table and its RPCs on databases that synced the
lease era.

## Contracts

- `EMBED_SOURCES[i]` - per-table descriptor: `name`, `claimRpc`,
  `saveRpc`, and `buildInput(row)`. Adding an embeddable table is one
  registry entry plus its claim/save RPC pair in schema.sql.
- `runBackfill(deps, opts): Promise<BackfillSummary>` - `deps`
  injects `claim(sourceIndex)`, `embed(input)`, and `save(...)`; the
  summary tallies embedded / rejected / no-embedding / errors /
  rate-limited / duration. Never double-saves a claim; treats a
  `false` save as a normal skip.
- `claim_next_pending_*(p_holder_id, p_ttl_seconds)` - returns the
  next claimed row's raw columns or no rows. `save_*_if_claimed(...)`
  - returns true if the write landed (claim still ours), false if we
  lost the row. False is not an error.

## Interactions with other features

- **Memory** - `memories` is one of the seven backfill sources. The
  `clear_memory_embedding_on_change` trigger reselects edited rows.
  `memory_search`'s vector path reads `memories.embedding`; ILIKE
  fallback covers unembedded rows. See `./memory.md`.
- **Summaries** - no longer an embedding input. `threads` used to be
  a source, vectorizing `title + summary`; that column and its
  trigger are gone. Summaries survive as the text a search hit shows
  the model, not as something retrieval ranks on. See
  `./summaries.md`.
- **Conversation recall** - `thread_chunks` is the source behind
  every conversation search: the transcript sliced into
  embedding-sized pieces, ranked per chunk and aggregated to threads
  by best match. Unlike every other source it is fed by a curation
  unit (rechunk) rather than by a column trigger, because its input
  is the thread's MESSAGES rather than any column on `threads`. See
  `./conversation-recall.md`.
- **Cookbook** - `recipes` is a source so the drawer's recipe search
  can rank by meaning; `clear_recipe_embedding_on_change` fires on
  `title | cooklang | source`. See `./cookbook.md`.
- **Wiki / Samskara** - `wiki_articles` and `samskara_substrate` are
  sources; the substrate claim skips unassimilated rows
  (`situation is null`). See `./wiki.md`, `./samskara.md`.
- **Shared config** - embeddings no longer need the Venice key. The
  function uses `Supabase.ai.Session('gte-small')`, a model pre-bundled
  in the edge runtime. The Venice key in `app_config` is still used by
  the chat, image generation, and text extraction routes.
- **Build & deploy** - the `pg_cron`/`pg_net` block and the converted
  RPCs ship in `schema.sql`, and the `venice` function is deployed,
  both by the deploy's `sync-supabase` job (the function via a
  `supabase functions deploy` step). The Vault secrets that
  authenticate the cron call are seeded once by `mise run
  supabase-init`. See `./build-deploy.md`.
- **Edge functions** - `/backfill` is one route on the fat `venice`
  function; `/embed` is its sibling. See
  [`../../supabase/functions/README.md`](../../supabase/functions/README.md).

## Gotchas

- **The EXECUTE grant is load-bearing, not boilerplate.** The
  claim/save RPCs are `security definer` with no user filter, so the
  `revoke ... from public, anon, authenticated` + `grant to
  service_role` is what stops a signed-in member from reading another
  member's rows through them. The `anon, authenticated` is not
  optional: Supabase grants EXECUTE on public functions to those roles
  *explicitly*, so `revoke from public` alone leaves the function wide
  open (`has_function_privilege('authenticated', oid, 'execute')`
  stays true). Verify with exactly that query after any change; don't
  "tidy" the grants away.
- **Cron auth needs the LEGACY JWT key.** The function gateway
  validates the bearer as a JWT; the modern opaque `sb_secret_` key
  is not one and gets rejected (same gotcha as the local realtime
  stack rejecting `sb_publishable_`). The Vault `service_role_key`
  secret must be the legacy key.
- **Text composition stays in TS.** Moving the per-source builders
  into the SQL claim RPCs would diverge from historical vectors: JS
  `String.slice` counts UTF-16 units, SQL `left()` counts characters,
  so an emoji on a truncation boundary changes the string. Compose in
  `_shared/embed-input.ts`.
- **The schema must apply on a DB without pg_cron/pg_net.** The local
  dev stack ships neither, so the extension + `cron.schedule` setup is
  gated on `pg_available_extensions` inside a guarded `do` block, and
  the trigger function uses dynamic SQL so it compiles regardless. It
  all no-ops locally; cron is a hosted-only concern.
- **`save`-false is not an error.** The row was edited, the TTL
  lapsed, or the row was deleted. The summary counts it as `rejected`
  and moves on; that's why the save RPC returns boolean.
- **`pg_net` confirms dispatch, not completion.** A tick fires the
  HTTP call and returns; it does not wait for the backfill to finish.
  That's why each invocation self-bounds and the claim protocol
  resumes the drain - never assume one tick drains the whole queue.
- **CPU time, not I/O, is the binding constraint.** The Venice-era
  backfill was I/O-bound (most of the 25s budget was awaiting Venice
  HTTP responses). Local inference is CPU-bound: each `session.run()`
  call uses ~130ms of the worker's 2s CPU-time budget. The 12-row
  batch cap is sized for this. Bumping it risks the edge runtime
  killing the worker mid-batch.

## Where to go next

- `./memory.md` - first consumer: memory search + the ILIKE fallback.
- `./summaries.md` - the sibling worker that produces the
  `threads.summary` field search hits carry, though nothing
  embeds it any more.
- `./conversation-recall.md` - second consumer: thread search.
- `./architecture.md` - the worker model (still used by the agent
  fleet) in context.
