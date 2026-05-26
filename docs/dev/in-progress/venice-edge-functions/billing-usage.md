# Billing usage milestone

*Skeleton.* To be fleshed out after the
[embeddings milestone](./embeddings.md) and informed by its
lessons. Part of the [Venice edge functions](./README.md)
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

To be filled in when embeddings completes.
