# Billing usage milestone

*Skeleton - embeddings lessons folded in (step 8); target state
still to define.* Part of the [Venice edge functions](./README.md)
project.

Wraps `GET /billing/usage` (`VeniceClient.fetchUsage`) as a
`/usage` route on the `venice` function.

The simplest endpoint: read-only, no streaming, no upload.
Account-scoped data, which makes it the natural place the
*shared* key matters - usage reflects the one project key, not
a per-user key.

## Why this one is easy

- Read-only `GET`; no mutation, no abort semantics.
- Already paginated with a hard cap (`USAGE_MAX_PAGES`, 20
  pages of 500) in `src/lib/venice.ts` - the paging loop moves
  into the handler unchanged.
- The defensive row coercion (`UsageRow`, see the `fetchUsage`
  comment on why Venice's row shape is read loosely) moves with
  it; a good offline `deno test` target.

## Current state

To document: `fetchUsage` and its caller(s) (the usage display
in settings/logging), the `UsageRow` / `UsageRequestOptions`
contracts, and `USAGE_MAX_PAGES`.

## Target state

To define.

## Open questions

- Is server-side caching worth it (usage changes slowly), or
  does the function proxy each request?

## Lessons from the embeddings milestone

Folded in after embeddings shipped (step 7):

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
- **The paging loop and `UsageRow` coercion are an ideal offline
  `deno test` target.** Embeddings proved the pure-core +
  fetch-injection pattern (`_shared/venice.ts` takes a `fetchImpl`).
  Move the `USAGE_MAX_PAGES` loop and the loose row coercion into a
  pure `_shared` function and test it against a fake multi-page upstream
  - no network.
- **"Server-side caching" now has a concrete cost.** The open question
  below can be answered against real experience: caching usage means
  adopting the scheduled-refresh stack embeddings built - `pg_cron` +
  `pg_net` + the legacy-JWT-in-Vault cron auth (the modern opaque key
  is rejected by the gateway) - plus a cache table. That works, but it
  is the heaviest machinery in the project. For a value that changes
  slowly and is read rarely (a settings panel), a plain proxy - or a
  short in-memory TTL inside the function isolate - is almost certainly
  right; reach for cron only if usage becomes a hot, frequently-polled
  path.
