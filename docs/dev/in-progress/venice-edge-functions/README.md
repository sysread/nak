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

The strategic driver behind all of it: on mobile, backgrounding
the page - minimize, app switch, screen lock - lets Chrome
suspend a running tab to save battery, which kills any in-flight
work, including a chat completion the user is waiting on. An
installed PWA gets no exemption. The only durable fix is for the
work to run and persist server-side, independent of whether the
page is still alive. That is the attractor every milestone climbs
toward; see
[Strategic spine](#strategic-spine-climbing-to-streaming-chat).

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

## Supabase key types (current names, and which we use where)

Supabase renamed its API keys, and this work touches both
generations, so the mapping lives here once:

- **Publishable key** (`sb_publishable_...`) - the modern *client*
  key; replaces the legacy **anon** key. Safe to expose; the browser
  app uses it (`config.supabasePublishableKey`).
- **Secret key** (`sb_secret_...`) - the modern *server* key; replaces
  the legacy **service_role** key. Full access, server-only.
- **Legacy JWT keys** (`eyJ...`) - the old **anon** / **service_role**
  keys, still issued for compatibility. Crucially, they are JWTs.

The load-bearing rule: **anywhere a JWT bearer is required, use a
legacy JWT key - the modern `sb_*` keys are opaque, not JWTs, and get
rejected.** Two places this bites:

- **Edge-function gateway** (`verify_jwt`, on by default): the cron ->
  `/backfill` call must send the **legacy service_role JWT** as its
  bearer; an `sb_secret_` key is rejected. So the cron's Vault secret
  (`service_role_key`) is the legacy JWT. The function then authorizes
  by the bearer's `role` claim (`role === 'service_role'`), not by
  string-matching the injected `SUPABASE_SERVICE_ROLE_KEY` - those need
  not be the same string.
- **Local realtime** (CLI bug #4219): the local stack rejects the
  `sb_publishable_` key, so `dev-start` writes the legacy **anon JWT**
  as the local client key. Prod realtime accepts the publishable key.

Where each runs here:

- Browser client, prod: publishable key (`sb_publishable_`).
- Browser client, local dev: legacy anon JWT (the realtime bug above).
- Edge-function admin (reads `app_config`, runs the definer RPCs): the
  injected `SUPABASE_SERVICE_ROLE_KEY`.
- Cron -> `/backfill` bearer: legacy service_role JWT, stored in Vault.

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
`src/lib/venice.ts`). The full caller-level punch list - every
browser call site, worker, and process to migrate, with status -
lives in [migration-inventory.md](./migration-inventory.md):

- [Embeddings](./embeddings.md) - `POST /embeddings` via
  `VeniceClient.embed`. **Milestone 1, fleshed out.** The
  natural first mover: generation is already background, the
  DB side is already claim-RPC structured, and there are no
  streaming or file-upload complications.
- [Chat completions](./chat-completions.md) - `POST
  /chat/completions` via `streamChat` and `completeChat`.
  *Skeleton.* The hard one: streaming SSE through a function
  plus abort semantics.
- [Billing usage](./billing-usage.md) - `GET /billing/usage`.
  **Milestone 2, implemented.** Read-only, paginated,
  account-scoped - and the first browser->function call, so it
  served as the client-invoke canary (session-JWT auth, CORS,
  error mapping) for the driver-B migrations that follow.
- [Text parser](./text-parser.md) - `POST
  /augment/text-parser` via `extractText`. *Skeleton.*
  Multipart file upload from the attachments flow, and now the
  Library document-ingestion flow (a second caller).
- Image generation - `POST /image/generate` via
  `VeniceClient.generateImage`. *No sub-plan yet.* One browser
  caller (the `generate_image` tool); least-used, but still a
  driver-B item while it holds the local Venice key. Tracked in
  [migration-inventory.md](./migration-inventory.md).

## Strategic spine: climbing to streaming chat

The endpoint list above is a *catalog of primitives* - the
wire-level handlers the `venice` function exposes. It does not by
itself say what order to migrate callers in. That order comes from
a second, orthogonal decomposition: the **call tree** of
who-invokes-whom at runtime, with the streaming chat turn at its
root.

The attractor is **the streaming chat completion running entirely
in an edge function** - reading from Venice, persisting the
assistant message to the database itself, while the client
collects the live stream *somehow* (the channel mechanism is the
one open fork; see [chat-completions.md](./chat-completions.md)).
Reaching it solves the strategic driver: a completion that lives
server-side survives the page being backgrounded.

You cannot move the root before its leaves. A streaming turn emits
tool calls; the tools (web search, doc research, image analysis)
and the intuition pipeline are themselves Venice callers - they
need *non-streaming* completions and, in some cases, embeddings.
So the climb is leaf-first:

1. **Non-streaming `/complete` primitive.** The holistic
   `completeChat` path as its own route, beside `/embed`. The leaf
   that intuition and the completion-using tools call. Per-user JWT
   auth like `/embed` - synchronous and user-triggered, so no cron
   and no service-role sweep.
2. **Migrate the tool / intuition callers onto it.** Point web
   search, doc research, image analysis, and the intuition pipeline
   at the primitive instead of calling Venice directly. Behavior
   unchanged; this phase irons out payload and auth.
3. **Move the tools into edge functions.** Each tool becomes a
   server-side handler *composed of* the primitives it needs
   (non-streaming completion, embeddings) by importing the shared
   handler in-process - not by an HTTP hop to a sibling function.
   The fat-function decision applies recursively: composition is
   module calls within one isolate, not a mesh of tiny functions
   phoning each other.
4. **Move streaming chat server-side.** The root. The processing
   loop now only calls edge-function handlers and writes to the
   database; the browser stops owning the Venice call and the
   message write. This is where the durable-persistence machinery
   returns (see the learning-loop note) and where the
   client-stream-collection fork gets resolved.

Two catalogued endpoints sit *off* this spine. **Billing usage**
and **text parser** are real primitives, but nothing on the path
to the streaming attractor composes them - the spine does not
constrain when they move. They are not optional, though: they are
load-bearing for the *other* strategic driver, the
[shared-config track](#shared-config-track) - getting the Venice
key out of the client. The browser holds the key today only
because consumers like the usage display, attachment text
extraction, query-time embedding, and the agents still call Venice
directly; the key cannot leave the client until the *last* such
consumer routes through the function. So usage and text-parser
have to move for the single-source-of-truth goal to complete, even
though they sit off the minimize-recovery spine. Sequence them for
that goal, by convenience - just do not let "billing usage is the
easy next mover" reorder the *spine*.

The load-bearing invariant for step 4, true regardless of how the
client collects the stream: **persistence of the assistant message
moves out of the browser and into the function.** Today the
browser accumulates the stream and writes the row on completion,
so a backgrounded page loses the message. Moving that write
server-side is the change that makes minimize survivable; the
streaming channel is a detail layered on top.

## Shared-config track

The shared `app_config` table and the gum-driven config editor
in `mise run supabase-init` underpin every endpoint - the
function cannot call Venice without the key, and the
invited-user UX win is the shared key. This track is sequenced
first inside milestone 1 and lands once, then every later
endpoint reuses it. It is documented in
[embeddings.md](./embeddings.md) rather than duplicated here,
because milestone 1 is what proves it.

The shared key must be Admin-tier once billing usage is in scope.
Venice's `/billing/usage` rejects a standard inference key with 401
"Admin API key required", so the single `app_config.venice_api_key`
that serves every route has to be admin-capable for the Usage view to
work. That key is also member-readable (the browser GETs it via
`getAppConfig` under an authenticated-read RLS policy), so in a
multi-user project the owner's admin key is exposed to invited members
(a privilege bump over the inference-only key the
[not-a-zero-knowledge system](#not-a-zero-knowledge-system) note
assumed). Fine for a solo project; revisit whether usage should be
shared-key vs owner-only when multi-user matters. See
[billing-usage.md](./billing-usage.md).

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
specific to *background* jobs and does not transfer to *synchronous*
user-triggered calls (the non-streaming completion primitive, billing
usage, text parser). The asterisk: the streaming chat attractor stops
being synchronous the moment it fires-and-forgets - the function
persists the message after the client may have gone away - so that
machinery (service-role write-back, a job row, `waitUntil`, possibly
cron for resume) returns at step 4 of the spine. The reducer holds for
everything below the root, not at it. Its final step folded those
lessons into
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
