# Embeddings

The pipeline that vectorizes memories, thread summaries, recipes,
wiki articles, and samskara substrate so semantic search works.
Backfill (turning `embedding is null` rows into vectors) runs
server-side on a `pg_cron` schedule behind the `venice` edge
function; the browser still embeds *search queries* synchronously at
each call site. This doc covers both halves plus the per-row claim
protocol the backfill drains through.

## Role in the app

A memory that's just been written is `embedding is null`; so is a
thread whose title or summary changed (trigger-invalidated), and the
same for recipes, wiki articles, and substrate rows. A `pg_cron` job
fires every 5 minutes, POSTs to the edge function's `/backfill`
route, and the function claims pending rows across all five tables,
asks Venice's `/embeddings` endpoint for vectors, and writes them
back under a claim guard - all server-side, no open tab required.

Downstream: `memory_search`, `conversation_search`, and the drawer
searches run cosine-similarity against these vectors. Unembedded
rows are covered by ILIKE fallbacks on the search side, so a just-
written memory is never invisible - just semantically under-ranked
until the next sweep catches up (at most ~5 minutes).

The other direction - embedding a *search query* to run cosine
search - also goes through the function. `SupabaseService.embed`
calls `venice/embed`, which holds the shared key and relays a single
vector synchronously. Browser callers (`memory_search`,
`conversation_search`, the drawers, context recall) keep the same
`{ model, input } -> { data: [{ embedding }] }` request/response
shape they had against `VeniceClient.embed`; the only change at the
call site is which client handle they hold.

## Files

- `supabase/functions/venice/index.ts` - the edge function.
  `/embed` is the thin per-call proxy (one vector for a query);
  `/backfill` is the cron target that runs the server-side drain.
  Service-role-only on `/backfill`.
- `supabase/functions/_shared/backfill.ts` - `runBackfill`, the
  claim -> embed -> pad -> save orchestration. I/O-free (injected
  deps) so it unit-tests offline. Also holds the ported
  `padEmbeddingForStorage` and the model constant.
- `supabase/functions/_shared/embed-input.ts` - per-source text
  composition (which columns, soft boundary, char caps) plus the
  `EMBED_SOURCES` registry mapping each source to its claim RPC,
  save RPC, and input builder. Ported from the old browser adapters;
  kept in TS so truncation stays byte-identical to historical rows.
- `supabase/functions/_shared/venice.ts` - the Venice `/embeddings`
  wire shape (request/response, error mapping), fetch-injectable.
- `supabase/schema.sql` - the `claim_next_pending_*` /
  `save_*_embedding_if_claimed` RPCs (now `security definer` global
  sweeps; see below), the `clear_*_embedding_on_change` triggers,
  the `nak_trigger_embed_backfill()` dispatcher, and the `pg_cron` /
  `pg_net` setup block.

## Entry points

- **`pg_cron` -> `nak_trigger_embed_backfill()`** - every 5 minutes,
  the job calls the trigger function, which reads the `project_url`
  and `service_role_key` Vault secrets and `pg_net.http_post`s to
  `/functions/v1/venice/backfill`. No-ops if the secrets are
  unseeded, so an un-provisioned project simply doesn't backfill.
- **`handleBackfill` in the function** - authenticates the caller as
  the service role by decoding the bearer JWT's `role` claim and
  requiring `role === 'service_role'` (the gateway's verify_jwt has
  already validated the signature). It then drives `runBackfill` over
  the five sources, bounded by a batch cap (50 rows) and a time budget
  (25s) per invocation. The schedule resumes the drain next tick.
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

Venice's current embedding model emits 1024 dims; the column is
`vector(2048)` for forward compat. `padEmbeddingForStorage` zero-
extends. Cosine similarity is invariant under zero-extension. The
function pads (not the SQL) so the stored shape matches what the
browser worker wrote historically.

### Timing

- Cron cadence: every 5 minutes (`*/5 * * * *`).
- Per-invocation bounds: 50 rows or 25s, whichever first. The 25s
  budget sits well under the edge runtime wall-clock limit - nearly
  all of it is awaiting Venice (I/O, not CPU). Both are tunables in
  `venice/index.ts`.
- Row claim TTL: 120s. Rate-limit back-off: the invocation bails and
  the next tick resumes.

## Worker-fleet coordination (retired)

The cross-tab Web Lock + Supabase `worker_leases` + heartbeat
model has no live tenants: the browser worker fleet is gone, and
every background job coordinates through per-row claims instead
(see [`./architecture.md`](./architecture.md), "Background-job
model"). The `worker_leases` table and its
`acquire`/`heartbeat`/`release` RPCs are still in the schema, plus
their orphaned `SupabaseService` wrappers; removing that surface
is a tracked follow-up of the de-browser-background-jobs
migration.

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

- **Memory** - `memories` is one of the five backfill sources. The
  `clear_memory_embedding_on_change` trigger reselects edited rows.
  `memory_search`'s vector path reads `memories.embedding`; ILIKE
  fallback covers unembedded rows. See `./memory.md`.
- **Summaries** - `threads` is a source; the
  `clear_thread_embedding_on_change` trigger fires when `title` or
  `summary` changes, so a fresh summary reselects the row. The
  summary agent worker writes `threads.summary`; the server-side
  backfill then embeds it. See `./summaries.md`.
- **Conversation recall** - `conversation_search`'s vector path reads
  `threads.embedding`; ILIKE-on-title covers unembedded rows. See
  `./conversation-recall.md`.
- **Cookbook** - `recipes` is a source so the drawer's recipe search
  can rank by meaning; `clear_recipe_embedding_on_change` fires on
  `title | cooklang | source`. See `./cookbook.md`.
- **Wiki / Samskara** - `wiki_articles` and `samskara_substrate` are
  sources; the substrate claim skips unassimilated rows
  (`situation is null`). See `./wiki.md`, `./samskara.md`.
- **Shared config** - the function reads the project-global Venice
  key from `app_config` server-side (service role). Browser callers
  never see the key.
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

## Where to go next

- `./memory.md` - first consumer: memory search + the ILIKE fallback.
- `./summaries.md` - the sibling worker that produces the
  `threads.summary` field this feature then embeds.
- `./conversation-recall.md` - second consumer: thread search.
- `./architecture.md` - the worker model (still used by the agent
  fleet) in context.
