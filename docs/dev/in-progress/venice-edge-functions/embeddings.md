# Embeddings milestone

The first mover in the [Venice edge functions](./README.md)
project. Moves embedding *backfill* from the browser Web Worker
to a `pg_cron`-scheduled edge function, and lands the
shared-config track that every later endpoint reuses.

Chosen first because it is the cleanest: generation is already
a background loop (no UI latency on the critical path), the
database side is already claim-RPC structured, and `/embeddings`
has no streaming or file-upload complications.

## Scope boundary: backfill vs query-time

`VeniceClient.embed` has two distinct caller populations, and
this milestone moves *only the first*:

- **Backfill (in scope).** `src/lib/embeddings/loop.ts` -
  `runOneCycle` claims an `embedding is null` row, embeds its
  text, writes the vector back. Background, latency-tolerant.
  This is what moves server-side and onto a schedule.
- **Query-time (out of scope here).** Nine sites embed a
  *search query* synchronously to run cosine search. These are
  user-facing and latency-sensitive; they belong to phase 4
  (move user-facing callers) and are listed under
  [Surface area](#surface-area) so the inventory is complete.
  One of them - `src/lib/context-recall/gather.ts` - embeds
  three queries in parallel on the live turn's critical path,
  so it is the most latency-sensitive embed in the app and the
  least obvious candidate to proxy.

## Current state

- Generation: `src/lib/embeddings/worker.ts` drives
  `runOneCycle` in a dedicated Web Worker, supervised by
  `src/lib/embeddings/manager.ts` under the cross-tab Web Lock
  `nak:embed-worker`. Cross-device singleton via
  `src/lib/embeddings/lease.ts` + the `worker_leases` table.
- Storage: `vector(2048)` columns on `memories`, `threads`,
  `recipes`, `wiki_articles`, and the samskara substrate table.
  Native model output is 1024-dim (bge-m3), zero-padded to 2048
  for forward compatibility.
- Coordination RPCs (already exist, already concurrency-safe):
  `claim_next_pending_*` (`FOR UPDATE SKIP LOCKED`) and
  `save_*_embedding_if_claimed` (conditional write guarded on
  the claim holder + expiry). DB triggers null the column when
  source text changes, re-queueing the row.
- Key: `app.config.veniceApiKey`, decrypted from localStorage,
  forwarded into the worker's start message.

See [the embeddings feature doc](../../embeddings.md) for the
full current-state detail; this plan does not duplicate it.

## Target state

- A single-row `app_config` table holds the shared Venice key,
  seeded by the config editor in `mise run supabase-init`.
- A `venice` edge function exposes `/embed`, calling Venice with
  the shared key read server-side via the service role.
- A `pg_cron` job invokes the function on a schedule (via
  `pg_net`); the function claims a bounded batch, embeds, and
  saves through the existing RPCs.
- The browser embeddings worker, its lock, and its lease are
  deleted - the server owns backfill.

## The shared-config track

This lands first because the function cannot call Venice
without the key, and the invited-user UX win *is* the shared
key. It is reused by every later endpoint.

### Storage and access

- **Table.** A single-row `app_config` in
  `supabase/schema.sql` (idempotent, like every statement
  there - see the schema header and `docs/dev/build-deploy.md`).
  Project-global, *not* user-keyed: one Venice key shared by all
  members of the project.
- **RLS.** Authenticated members may `SELECT`; only the
  owner/service_role may write. Any member reading the key in
  devtools is acceptable under the trust model (see the
  project README's "Not a zero-knowledge system").
- **Seeding.** `mise run supabase-init` gains a gum-driven
  config step (after schema apply): when `app_config` is empty
  it walks the owner through each field, and once values exist
  it shows a menu of fields - each with its set/unset state and
  a description - and opens the right input for the one picked.
  It upserts the row via the existing `runSql` Management-API
  helper in `scripts/lib/supabase.mjs`. No dashboard clicking.
  The wizard cannot read the browser's encrypted localStorage,
  so the owner supplies the key once - less machinery, not more.
  gum is pinned in `.mise.toml` (aqua backend, alongside the gh
  and supabase CLIs); the field list lives in `CONFIG_FIELDS` in
  `scripts/setup-supabase.mjs`, so adding a shared setting later
  is one entry.

### Client wiring

- The browser fetches the row post-auth into a new
  `app.serverConfig`, kept *distinct* from `app.config` (the
  local encrypted config). Distinctness is what makes consumer
  migration a static check - see below.
- **Sequencing gotcha.** Local config is available
  synchronously at unlock; the server fetch is async,
  post-auth. A migrated consumer can start before
  `serverConfig` has loaded. Decide up front: either
  `activate()` awaits the fetch, or migrated managers gate
  their start on `serverConfig` being present. This is the one
  new failure mode the parallel phase introduces.

### Consumer migration as a static completeness check

Keep both config sources live. Migrate each `veniceApiKey`
consumer to read `serverConfig` one at a time. When the last
one is migrated, delete the `veniceApiKey` field from the local
`AppConfig` type - `svelte-check`/`tsc` then reports every
remaining reader as a compile error. That turns "did we get
them all" into a static enumeration, not a runtime hunt.

For this milestone, migrate **only the embeddings manager**
first, leaving the other eight consumers on local config as
cushioning. If embeddings still generate with the embeddings
path on `serverConfig`, the whole spine is proven (table, RLS,
seeder, fetch, a real consumer) with eight fallbacks intact.

## Steps

1. **`app_config` table + RLS** in `supabase/schema.sql`.
   Idempotent. Apply via `mise run sync`.
2. **Config editor in `mise run supabase-init`** - a gum-driven
   step that upserts the row via `runSql` (menu when values
   exist, walkthrough when empty).
3. **Fetch-on-login** into `app.serverConfig`; resolve the
   start-sequencing gotcha above.
4. **Migrate the embeddings manager** (`manager.ts`) to read
   `serverConfig.veniceApiKey`. Leave the other consumers on
   local config. *Vet point:* embeddings still generate.
5. **Scaffold the `venice` function** with an `/embed` route:
   `supabase/functions/deno.json`, `_shared/venice.ts`
   (duplicated wire-shape), the function entry with internal
   routing, and an offline `deno test` of the request/response
   shaping. Add `mise run functions-test`, `functions-serve`,
   `functions-deploy`. (Done. The Deno island is kept out of the
   app gate by eslint ignore + the tsconfig `include` scope;
   `dev-start` auto-serves the function once `index.ts` exists.)
6. **Convert the backfill caller** so `runOneCycle` calls the
   function's `/embed` rather than Venice directly. Still
   browser-triggered at this stage - behavior unchanged, bugs
   surfaced. (Done. The loop takes an injected `Embedder`
   callback instead of a `VeniceClient`; the worker builds one
   that calls the function via `client.functions.invoke` -
   using the live session token, which the local gateway and
   hosted prod both verify - and falls back to a direct Venice
   call on any function-path failure, so generation keeps
   flowing while the function rolls out and failures surface as
   a worker warn rather than a stalled queue. The fallback
   retires at step 7.)
7. **Schedule it.** A `pg_cron` job (via `pg_net`) invokes the
   function; the function claims a bounded batch and drains via
   the existing RPCs. Then delete the browser embeddings
   worker, its `nak:embed-worker` lock, and its lease usage.
   Flag the now-unused lease/worker plumbing for deletion per
   the dead-code rules. (Done. Several things differed from this
   plan's guesses - captured here because step 8 folds them into
   the siblings:

   - **"Drain via the existing RPCs" did not hold.** Every
     `claim_next_*` / `save_*_if_claimed` RPC was `security
     invoker` and scoped to `auth.uid()`. Cron fires from inside
     Postgres via `pg_net` with no user session, so `auth.uid()`
     is null and those RPCs matched zero rows. The fix: convert
     all ten in place to `security definer` global sweeps (no
     `auth.uid()` filter, runs as the owner) - safe because
     deleting the browser worker left the cron function as their
     only caller. **The EXECUTE grant is the security boundary:**
     `revoke ... from public` + `grant ... to service_role` on
     each, or any signed-in member could call the now-global
     claim and read another member's rows. Every later endpoint
     that moves a user-scoped RPC server-side hits this same wall
     - plan for the definer conversion + grant lockdown up front.
   - **New `/backfill` route, not an overload of `/embed`.**
     `/embed` stays the thin per-call proxy (query-time +
     browser). `/backfill` is the cron target: service-role-only
     (bearer must equal the injected `SUPABASE_SERVICE_ROLE_KEY`),
     runs the claim -> embed -> pad -> save loop server-side
     across all five sources, bounded per invocation (50 rows or
     25s, whichever first; the schedule resumes the drain).
     Orchestration is I/O-free with injected deps so it
     unit-tests under `deno test` with fakes.
   - **Text composition stayed in TS**, ported to
     `_shared/embed-input.ts`. Moving the per-source builders into
     the SQL claim RPCs was tempting but unsafe: JS `String.slice`
     counts UTF-16 units, SQL `left()` counts characters, so an
     emoji on a truncation boundary would make a server-composed
     string diverge from a historical browser one. The claim RPCs
     return raw columns; the function composes.
   - **Cron -> function auth is the fiddly bit.** `pg_net` needs a
     bearer the gateway accepts; the modern opaque `sb_secret_`
     key is not a JWT and the gateway rejects it (same gotcha as
     the local realtime stack rejecting `sb_publishable_`). Use
     the **legacy JWT** service-role key, stored in **Vault**
     (`project_url` + `service_role_key`), seeded once by `mise
     run supabase-init`. The trigger fn uses dynamic SQL so it
     compiles on a DB without pg_net/vault (the local stack) and
     no-ops until seeded.
   - **pgmq was not needed.** The trigger-nulls-the-column requeue
     plus `FOR UPDATE SKIP LOCKED` claims already are the queue; a
     second one would have been over-engineering.
   - **Schema stays local-apply-safe** by gating the extensions +
     `cron.schedule` on `pg_available_extensions` inside a guarded
     `do` block - the local stack ships neither pg_cron nor
     pg_net, so this lets `schema.sql` still apply cleanly there
     (same lesson as the vector-extension ordering fix).
   - **Deleted:** `src/lib/embeddings/{worker,manager,loop,types}.ts`,
     `sources/*`, the ten `SupabaseService` claim/save methods,
     the four browser embeddings vitest files (truncation coverage
     ported to `deno test`), and the `state.svelte.ts` start/stop
     wiring. **Kept:** `embeddings/lease.ts` (the whole agent
     worker fleet imports `LeaseCoordinator` from it - the
     directory name is now a vestige; moving it to a neutral home
     is a separate task).
   - **`app.serverConfig` is now staged, not consumed.** The
     browser fetch remains (the shared-key spine the milestone
     delivered) but has no browser reader now that the embeddings
     manager is gone - the edge function reads `app_config`
     server-side instead. It waits warm for the remaining
     `veniceApiKey` consumers to migrate onto it later.)
8. **Fold lessons into the sibling sub-plans** - see
   [Definition of done](#definition-of-done).

## Surface area

The authoritative inventory, re-verified after the
2026-05 rebase onto main.

**`veniceApiKey` config consumers** (the shared-config
migration target - migrate the embeddings one first, the rest
in later milestones): the manager+worker pairs under
`src/lib/agents/{supervisor,deep-sleep,bias,wiki,rem,
wiki-librarian,samskara}/`, plus `src/lib/embeddings/`,
`src/lib/config.ts`, `src/lib/state.svelte.ts`, and the three
entry screens `src/screens/{Setup,EditConfig,Settings}.svelte`.

**`.embed()` call sites** (10 total; only `embeddings/loop.ts`
is backfill and in scope for this milestone, the rest are
query-time and belong to phase 4):
`src/lib/embeddings/loop.ts` (backfill, *in scope*),
`src/components/RecipeList.svelte`, `src/screens/Chat.svelte`,
`src/lib/wiki.ts`, `src/lib/memories.ts`,
`src/lib/samskara/index.ts`, `src/lib/context-recall/gather.ts`
(critical path), `src/lib/tools/conversation_search.ts`,
`src/lib/agents/deep-sleep/loop.ts`,
`src/lib/agents/samskara/loop.ts`.

## Testing strategy

- **Offline unit tests** of pure handler logic (request
  parsing, Venice payload construction, response shaping) via
  `deno test`. Proven working in-container on Deno 2.8.0; the
  `jsr:@std/assert` dep downloads once then caches, so repeat
  runs need no network. Structure the function as a thin entry
  plus pure functions in `_shared` so the logic is testable
  without a server.
- **Dependency injection for Venice.** `VeniceClient` already
  accepts a `fetchImpl` in its options - reuse that hook (or
  mirror it in the function's wrapper) so handler tests pass a
  fake and never hit the live API.
- **Local integration** via `supabase start` (local Postgres
  in Docker) + `supabase functions serve`. Local only - never
  touches the hosted project - but still hits the real Venice
  API unless the fake is injected.
- The official Supabase "unit test" example is actually an
  integration test (it calls `createClient().from(...)` and
  `functions.invoke`). Do not copy it as the unit-test
  template; it pulls in the network.

## Open questions

Resolved during step 7 - kept here as the answers feed the learning loop.

- **Schedule shape.** *Resolved: bare `pg_cron` sweep, every 5
  minutes.* No pgmq - the trigger-nulls-the-column requeue plus
  `FOR UPDATE SKIP LOCKED` is already the queue. 5 min balances the
  old ~3min browser feel against idle edge-function wakeups.
- **Batch size vs timeouts.** *Resolved: 50 rows or 25s per
  invocation, whichever first.* The 25s budget sits well under the
  edge runtime wall-clock limit - nearly all of it is spent awaiting
  Venice (I/O, not CPU). The claim/save protocol resumes the drain on
  the next tick. Both are tunables in `venice/index.ts`.
- **Service-role key custody.** *Resolved: Vault.* The function reads
  `app_config` server-side via the injected
  `SUPABASE_SERVICE_ROLE_KEY`. The cron *caller* authenticates with a
  separate Vault secret (`service_role_key`, the LEGACY JWT key - the
  modern opaque key is not a JWT and the gateway rejects it). Seeded
  by `mise run supabase-init`.
- **Offline fallback.** *Resolved: fully server-side.* The browser
  embeddings worker is deleted; there is no client-side backfill
  catch-up. If cron breaks, backfill stops with no UI signal -
  acceptable for an owner-controlled project.

## Definition of done

- [x] `app_config` + RLS applied; the `supabase-init` config editor
  seeds it.
- [x] `app.serverConfig` fetched post-auth; start-sequencing
  resolved.
- [x] Embeddings manager reads `serverConfig`; embeddings still
  generate. (Superseded by step 7: the manager is now deleted and
  backfill is server-side. The proof-of-concept consumer served its
  purpose - it validated the whole spine before cron took over.)
- [x] `venice` function with `/embed`, offline `deno test` green,
  the three `mise` function targets wired, and
  `mise run check` still green (Deno island excluded from the
  app tsconfig).
- [x] Backfill driven by `pg_cron`; browser embeddings worker,
  lock, and lease usage deleted. (The cron path runs only on hosted
  Supabase; it could not be exercised from the local CLI - the schema,
  function, and Vault seeding ship for the normal merge -> CI deploy
  to apply. The `/backfill` route is locally testable via
  `supabase functions serve` + a direct service-role POST.)
- [ ] **Sibling sub-plans updated** with lessons learned (step 8):
  [chat-completions](./chat-completions.md),
  [billing-usage](./billing-usage.md),
  [text-parser](./text-parser.md). This step is what makes the
  milestone a *learning* milestone rather than a one-off. The step-7
  "Done" note above is the source material.
