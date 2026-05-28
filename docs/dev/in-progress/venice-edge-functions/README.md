# Venice edge functions

An in-progress, multi-milestone effort to move our Venice.ai
API calls out of the browser and behind a Supabase edge
function, with the shared API key held server-side and
background generation driven by a schedule rather than an open
tab.

This directory is the project's home. This file is the overall
plan shape; each Venice endpoint gets its own sub-plan that
iterates independently. Embeddings is the first milestone and
is fleshed out; the others are skeletons that the embeddings
milestone will inform (see [Learning loop](#learning-loop)).

## Why this exists

Today every Venice call originates in the browser, and the
Venice API key lives *only* in the browser - encrypted in
localStorage under the user's master password, decrypted into
memory on unlock (`src/lib/config.ts`, `src/lib/crypto.ts`).
Three consequences fall out of that:

- **Background work needs an open tab.** Embedding backfill,
  summaries, bias analysis, and the rest run in Web Workers
  that only live while a tab is open. Close the laptop and the
  queue stops draining.
- **Onboarding is per-user key entry.** A project owner who
  invites a friend or family member onto the same Supabase
  project wants them to *just sign up* - not obtain and paste
  their own Venice key. There is no shared-key path today.
- **No server-side scheduling.** Scheduling is the browser's
  `setTimeout` poll loop. There is no cron, no `pg_net`, no
  way to say "generate embeddings once an hour" independent of
  a client.

End state: a project-global Venice config the owner seeds once,
a single `venice` edge function that wraps every Venice
endpoint, and background generation moved to `pg_cron`.

## Not a zero-knowledge system

Worth stating up front because it removes an objection that
looks load-bearing but is not: our tables are plaintext. The
privacy model is "the user owns the backend" (they supply their
own Supabase project), not client-side encryption of stored
data. The encrypted localStorage config is the *only* encrypted
artifact, and it exists because that key had nowhere else to
live. Storing the Venice key server-side in plaintext, readable
by the project's own members, does not betray a security
contract - there isn't one to betray. This is what makes the
shared-config approach acceptable.

## Settled architecture decisions

Recorded so they are not re-litigated each session. Each was
reasoned through; the rationale is in the relevant sub-plan.

- **One fat `venice` function, internal routing.** Supabase
  recommends few large functions over many small ones (each
  function is a separate isolate with its own cold start and
  dep graph). We deploy a single `venice` function that routes
  internally to `/embed`, `/complete`, `/usage`, and
  `/text-parser` handlers. Separation-of-concerns lives at the
  module boundary (each handler is a clean unit in `_shared`),
  not the deployment boundary.
- **Shared config in a singleton table, not env secrets or
  Vault.** A single-row `app_config` table, project-global
  (*not* keyed to a user), RLS: authenticated `SELECT`,
  owner/service_role write. The browser still needs the Venice
  key (query-time embedding plus the other agents), so an
  edge-function env secret will not serve it (write-only from
  the client's view) and Vault's grant model points at
  server-only reads. One table, both consumers, one source of
  truth. Details in [embeddings.md](./embeddings.md).
- **App stays Node/Vite; functions are a Deno island.** The
  app is a mature Svelte 5 + Vite PWA on pnpm/vitest. Edge
  functions must be Deno (no choice). We do *not* migrate the
  app to Deno - the cost/benefit is lopsided. The two
  toolchains coexist by directory: `supabase/functions/` is
  excluded from the app tsconfig and carries its own
  `deno.json`; `deno lint`/`deno fmt` cover it, eslint/knip
  stay scoped to `src/`.
- **Deno pinned in mise.** `.mise.toml` pins `deno` so
  `mise install` provisions it for `deno test` (offline unit
  tests of function logic). `supabase functions serve` uses
  the CLI's bundled runtime + Docker, so the pin is for the
  test/check path specifically.
- **Defer app/function code sharing.** Sharing
  `src/lib/venice.ts` between browser and function is tempting
  (it already takes a `fetchImpl`), but Deno's import
  resolution differs from the Vite side, and coupling the
  toolchains before the function shape settles is premature.
  Duplicate the minimal wire-shape into `_shared/` for now;
  revisit in the consolidation phase.

## Migration shape (strangler fig)

The same five phases apply to each endpoint, though endpoints
move through them on their own timelines:

1. **Build the primitive.** Add the endpoint's handler to the
   `venice` function as a thin proxy to Venice. Useful to
   nothing yet - it is just an API call with an extra hop.
2. **Convert callers.** Point existing callers (workers and
   user-triggered code) at the function instead of Venice
   directly. Behavior is unchanged, so this phase irons out
   the bugs (auth, payload shape, error mapping, streaming)
   while a working fallback still exists.
3. **Schedule the background callers.** Move worker-driven
   generation to `pg_cron`-triggered invocations and
   decommission the browser worker.
4. **Move user-facing callers.** Proxy latency-sensitive,
   user-triggered calls through the function. This is the
   riskiest phase (added hop on the live path) and may not be
   worth it for every endpoint.
5. **Consolidate.** Collapse duplication, revisit code
   sharing, and tidy the function surface based on what the
   real maintenance burden looks like.

## The endpoints

Five Venice endpoints are in scope (the full surface of
`src/lib/venice.ts`):

- [Embeddings](./embeddings.md) - `POST /embeddings` via
  `VeniceClient.embed`. **Milestone 1, fleshed out.** The
  natural first mover: generation is already background, the
  DB side is already claim-RPC structured, and there are no
  streaming or file-upload complications.
- [Chat completions](./chat-completions.md) - `POST
  /chat/completions` via `streamChat` and `completeChat`.
  *Skeleton.* The hard one: streaming SSE through a function
  plus abort semantics.
- [Billing usage](./billing-usage.md) - `GET /billing/usage`
  via `fetchUsage`. *Skeleton.* The simple one: read-only,
  paginated, account-scoped.
- [Text parser](./text-parser.md) - `POST
  /augment/text-parser` via `extractText`. *Skeleton.*
  Multipart file upload from the attachments flow.

## Shared-config track

The shared `app_config` table and the gum-driven config editor
in `mise run supabase-init` underpin every endpoint - the
function cannot call Venice without the key, and the
invited-user UX win is the shared key. This track is sequenced
first inside milestone 1 and lands once, then every later
endpoint reuses it. It is documented in
[embeddings.md](./embeddings.md) rather than duplicated here,
because milestone 1 is what proves it.

Note the migration tactic that makes "did we get every
consumer" a *static* check: keep the local config and a new
`app.serverConfig` as distinct in-memory values, migrate
consumers one at a time, then delete the `veniceApiKey` field
from the local config type. `svelte-check` then enumerates
every remaining reader as a compile error - no runtime hunt.

## Learning loop

Sub-plans stay deliberately thin until their endpoint becomes the
active milestone. We do not waterfall the design ahead of time -
guessing the shape of four endpoints up front mostly produces
churn. Instead **each milestone ends by folding its concrete
learnings back into the remaining sub-plans**, so the next endpoint
starts from earned knowledge rather than this document's best
guesses. That closing step is the standing pattern, not a one-off.

The embeddings milestone set it. Implementing it surfaced how the
function is structured, how `deno test` and `supabase functions
serve` fit the gate, how `pg_cron` + `pg_net` + Vault behave, and -
the big scope-reducer - that the cron / definer / Vault machinery is
specific to *background* jobs and does not transfer to the
user-triggered endpoints. Its final step folded those lessons into
the three remaining sub-plans; see each one's "Lessons from the
embeddings milestone" section and
[embeddings.md](./embeddings.md#definition-of-done).

## Interactions

Existing dev docs this project touches:

- [Embeddings](../../embeddings.md) - the current Web-Worker
  pipeline this milestone migrates.
- [Auth & session](../../auth-session.md) - the
  master-password envelope and config lifecycle the
  shared-config track changes.
- [Settings](../../settings.md) - the key-entry screens
  (`Setup`, `EditConfig`, `Settings`) that collapse once the
  `supabase-init` config editor owns key entry.
- [Chat](../../chat.md) - the completion call sites behind the
  chat-completions sub-plan.
- [Attachments](../../attachments.md) - the text-parser caller
  behind the text-parser sub-plan.
- [Build & deploy](../../build-deploy.md) - the schema sync
  workflow that will apply the `app_config` table, the cron
  jobs, and (eventually) the function deploy.
