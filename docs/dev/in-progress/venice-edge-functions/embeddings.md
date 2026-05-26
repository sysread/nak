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
   `supabase/functions/deno.json`, `config.toml`,
   `_shared/venice.ts` (duplicated wire-shape), the function
   entry with internal routing, and an offline `deno test` of
   the request/response shaping. Add `mise run test:functions`,
   `functions:serve`, `functions:deploy`.
6. **Convert the backfill caller** so `runOneCycle` calls the
   function's `/embed` rather than Venice directly. Still
   browser-triggered at this stage - behavior unchanged, bugs
   surfaced.
7. **Schedule it.** A `pg_cron` job (via `pg_net`) invokes the
   function; the function claims a bounded batch and drains via
   the existing RPCs. Then delete the browser embeddings
   worker, its `nak:embed-worker` lock, and its lease usage.
   Flag the now-unused lease/worker plumbing for deletion per
   the dead-code rules.
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

Resolve during implementation; answers feed the learning loop.

- **Schedule shape.** Bare hourly `pg_cron` sweep, every-minute
  for responsiveness, or the queue pattern from Supabase's
  "Automatic embeddings" guide (trigger -> pgmq -> cron-drained
  function)? Our trigger-nulls-the-column mechanism is already
  a hand-rolled queue, so the pgmq pattern may be a small step
  with retry semantics for free.
- **Batch size vs timeouts.** `pg_net` is fire-and-forget with
  a short timeout and confirms *dispatch*, not *completion*;
  edge functions have their own wall-clock limit. The function
  must process a bounded batch per invocation and rely on the
  claim/save protocol to resume. What batch size?
- **Service-role key custody** in the function environment.
- **Offline fallback.** Keep a browser embed path for when the
  schedule is paused, or fully commit to server-side?

## Definition of done

- `app_config` + RLS applied; the `supabase-init` config editor
  seeds it.
- `app.serverConfig` fetched post-auth; start-sequencing
  resolved.
- Embeddings manager reads `serverConfig`; embeddings still
  generate.
- `venice` function with `/embed`, offline `deno test` green,
  the three `mise` function targets wired, and
  `mise run check` still green (Deno island excluded from the
  app tsconfig).
- Backfill driven by `pg_cron`; browser embeddings worker,
  lock, and lease deleted.
- **Sibling sub-plans updated** with lessons learned:
  [chat-completions](./chat-completions.md),
  [billing-usage](./billing-usage.md),
  [text-parser](./text-parser.md). This step is what makes the
  milestone a *learning* milestone rather than a one-off.
