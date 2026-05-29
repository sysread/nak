# Billing usage milestone

*Implemented (milestone 2). Code-complete and gate-green; the
browser->function->Venice path wants one manual smoke test against a
deployed (or `dev-start`-served) function before it is called fully
done.* Part of the [Venice edge functions](./README.md) project.

Wraps `GET /billing/usage` as a `/usage` route on the `venice`
function. This was the **first browser->function call** in the project
(the function had only ever been hit by cron, `/backfill`, before), so
it doubles as the canary for the client-invoke path (session-JWT auth
through `verify_jwt`, CORS, error mapping) that every later driver-B
migration reuses.

Read-only, no streaming, no upload. Account-scoped data, which makes it
the natural place the *shared* key matters: usage reflects the one
project key, not a per-user key.

**The shared key must be Admin-tier.** Venice's billing endpoint requires
a Venice Admin API key - a standard inference key gets 401 "Admin API key
required". Since `/usage` reads the single shared `app_config.venice_api_key`
server-side, that one key must be admin-capable: the shared key's required
privilege is the maximum over all routes, and usage pushes it to admin. And
`app_config.venice_api_key` is member-readable (the browser GETs it via
`getAppConfig` under an authenticated-read RLS policy), so in a multi-user
project the owner's admin key is exposed to invited members - a privilege
bump over the inference key the not-zero-knowledge note assumed. Harmless for
a solo project; revisit whether usage should be shared-key vs owner-only when
the multi-user story matters.

## Why this one is easy

- Read-only `GET`; no mutation, no abort semantics.
- The work splits cleanly: a thin authenticated passthrough on the
  function side, and the existing paging + coercion loop on the browser
  side (see [Target state](#target-state) for why the loop stays in the
  browser).

## What shipped

Server side (`supabase/functions/`):

- `/usage` route on the `venice` function (POST, one page per call).
  Same auth model as `/embed`: the gateway's `verify_jwt` gates the
  session JWT; the handler reads the shared key via `readVeniceKey` and
  forwards to Venice. No service-role check, no cron, no Vault.
- `_shared/venice.ts` gained a pure `buildUsageQuery` and a
  fetch-injectable `veniceFetchUsagePage` returning a stable
  `{ data, totalPages }` shape; both are unit-tested offline in
  `supabase/functions/tests/usage.test.ts`.

Browser side (`src/lib/`):

- `src/lib/usage.ts` is the new home of the usage domain - the
  `UsageRow` contract, the loose row coercion, `USAGE_MAX_PAGES`, and a
  transport-injected `collectUsagePages` loop. It graduated out of
  `VeniceClient` because usage is no longer a direct Venice call.
- `SupabaseService.fetchUsage` provides the transport: one page via
  `functions.invoke('venice/usage', ...)` with the session JWT, mapping
  a non-2xx function response back to a `VeniceError`.
- The two callers (`usage-store.refreshUsage` and the custom-range fetch
  in `Settings.svelte`) now call `app.supabase.fetchUsage` instead of
  `app.venice.fetchUsage`. The Usage pane is otherwise unchanged - same
  window logic, same progress indicator, same truncation hint.

## Target state

As built: a **per-page proxy**. The browser keeps the paging loop, the
row coercion, and the `onProgress` callback; only the per-page transport
changed from "GET Venice with the Venice key" to "call the function with
the session JWT." The function relays one Venice page verbatim.

This **overrides the skeleton's earlier instinct** (folded in at step 8)
to move the whole `USAGE_MAX_PAGES` loop and the row coercion into a pure
`_shared` function - i.e. page the entire range server-side and return
all rows in one response. That instinct had a blind spot: a single fat
response cannot drive the per-page progress indicator that both callers
use (each with staleness guards). Keeping the loop browser-side preserves
that UX, and the function stays a thin passthrough with no `UsageRow`
knowledge, so no coercion is duplicated into Deno. The pure-core +
offline-test discipline still holds, just split by runtime:
`buildUsageQuery` / `veniceFetchUsagePage` are deno-tested,
`collectUsagePages` is vitest-tested.

## Resolved questions

- *Server-side caching vs proxy each request?* Plain proxy, no cache.
  Usage is a slow-changing settings panel, read rarely; the per-page
  proxy is enough. Caching would mean adopting the cron + `pg_net` +
  Vault stack (the heaviest machinery in the project) for no real gain.
  Reach for cron only if usage ever becomes a hot, frequently-polled
  path.
- *How do `venice_parameters` survive?* N/A here - that question belongs
  to chat completions; billing usage has no such knobs.

## Lessons from the embeddings milestone

Folded in after embeddings shipped (step 7), refined by building this:

- **No RLS / definer concerns - the skeleton's instinct was right.**
  Usage is account-scoped, not per-user, so none of the
  `security definer` global-sweep / EXECUTE-grant work that dominated
  embeddings applies. `/usage` reads the shared key from `app_config`
  via the service role (`readVeniceKey`) and proxies; that is the whole
  auth story.
- **One route (`/usage`), user JWT, `verify_jwt` on** - same model as
  `/embed`. Any authenticated member seeing project-wide usage is
  consistent with the shared-key trust model (usage reflects the one
  project key anyway).
- **The pure-core + fetch-injection pattern carries over, but the loop
  stays browser-side.** Embeddings proved the pattern
  (`_shared/venice.ts` takes a `fetchImpl`). Here it splits: the
  function's pure bits (`buildUsageQuery`, `veniceFetchUsagePage`) are
  deno-tested, while the `USAGE_MAX_PAGES` loop and the row coercion stay
  in `src/lib/usage.ts` (vitest-tested) so the per-page `onProgress`
  indicator survives. See Target state for why a whole-range server-side
  fetch was rejected.
- **"Server-side caching" had a concrete cost, and we declined it.**
  Caching usage would mean adopting the scheduled-refresh stack
  embeddings built - `pg_cron` + `pg_net` + the legacy-JWT-in-Vault cron
  auth - plus a cache table. For a value that changes slowly and is read
  rarely, the plain proxy is right (see Resolved questions).
