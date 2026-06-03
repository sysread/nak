# Edge function auth (b-strict client model)

## Synopsis

The streaming chat function (`supabase/functions/venice/getStreamingResponse.ts`)
runs detached from the HTTP request that started it. By the time the
round chain finishes the user's session JWT may have expired - the
whole point of the streaming-root migration is the function outliving
the browser connection. That rules out the user-scoped Supabase client
as a defense-in-depth layer: mid-stream 401s would defeat the design.

The trade-off is explicit and recorded here: **every database access
inside the streaming function goes through the admin (service-role)
client, and ownership is enforced by application discipline, not by
RLS.** This document is the contract for what that discipline looks
like. If you are adding a new edge function that does anything
non-trivial with user data, you are working under this model;
read this end to end before writing the first query.

## Where the model applies

- **`supabase/functions/venice/getStreamingResponse.ts`** -
  the streaming-root orchestrator. Service-role for every DB write
  (assistant row create/update/commit, tool-result inserts) and every
  Realtime publish + subscribe.
- **`supabase/functions/venice/performToolCall.ts`** - the
  function-side tool dispatcher. Tools receive a `ToolContext` with
  an `adminClient: SupabaseClient` (service role) plus the
  authoritative `userId`; every direct query a tool runs must filter
  by that id explicitly.
- **`supabase/functions/venice/index.ts` (/stream route)** - reads
  the bearer JWT via `userIdFromJwt`, runs the ownership probe
  against `threads.user_id`, then invokes the orchestrator with the
  validated userId as a constructor argument.

Routes that do *not* outlive their request - `/embed`, `/usage`,
`/text-parser`, `/image-generate`, `/complete` - stay on the
user-scoped pattern (gateway's `verify_jwt` validates the JWT, the
function reads the shared Venice key with the admin client purely
to access `app_config`, but user-owned data is not touched). Adding
a new b-strict route requires the same discipline below; otherwise
keep the request-scoped shape.

## The trust chain

1. The Supabase gateway's `verify_jwt: true` (on for the venice
   function; see `supabase/config.toml`) validates the bearer
   signature *before* the function code runs. Anything that reaches
   `Deno.serve(...)` arrives with a known-good JWT.

2. The function extracts `userId` from the validated JWT's `sub`
   claim via `userIdFromJwt()`. Same trust assumption as the
   service-role check in `isServiceRole()`: the signature was
   verified by the gateway, so reading the payload is safe. **Never
   re-read userId from the request body** - a forged threadId in
   the body must be caught by the ownership probe, but the user
   identity itself has to come from the JWT.

3. The `/stream` handler runs an ownership probe against the threads
   table: `select user_id from threads where id = body.threadId`.
   Same error shape on missing and on wrong-owner so a probe cannot
   distinguish them. Only after the probe passes does the
   orchestrator start.

4. The orchestrator constructor takes the authoritative `userId` as
   a parameter. The `ToolContext` it builds carries the same id.
   From this point forward, no piece of user input determines who
   the request acts on.

5. The terminal `commit_assistant_message` RPC takes the userId as
   `p_user_id` and verifies it inside the function against the row's
   thread owner. Belt-and-braces against orchestrator state
   corruption: if anything in step 4 went wrong, this catches it
   before the row flips to a terminal status.

## What the discipline looks like in code

### Every direct query carries `// RLS OFF: filter by userId`

Service-role clients bypass RLS unconditionally, so a `.from('messages').
select(...)` with no `.eq('user_id', ...)` clause returns *everyone's*
rows. This is the highest-leverage bug class in b-strict code; the
comment exists so a grep of `RLS OFF` immediately shows every site
that depends on application-level filtering.

```ts
// RLS OFF: filter by userId via the thread relationship enforced
// upstream when /stream resolved the threadId against the JWT's user.
const { data, error } = await adminClient
  .from('messages')
  .insert({
    thread_id: threadId,
    role: 'assistant',
    content: '',
    status: 'streaming',
  })
  .select('id')
  .single();
```

Two ways to be safe at the call site:

- **Filter by `user_id`** when the table carries it directly.
  Example: `.eq('user_id', userId)` on `memories`, `documents`,
  `bias_summary`.
- **Filter by a parent that carries it** when the row is reachable
  via a relationship to a user-scoped table. Example: messages have
  no `user_id` column but reach it via `thread_id -> threads.user_id`.
  The handler's ownership probe validated that relationship before
  the orchestrator started, so the streaming row insert is safe
  *because of an earlier check*. Reference the earlier check in the
  comment.

A `// RLS OFF` line without an adjacent userId filter (direct or via
a parent reference) is a bug. Grep audit:

```sh
# Show every RLS OFF site and a few lines of context so you can
# audit the filter at the same time.
grep -rn -A 4 'RLS OFF' supabase/functions/
```

### Prefer SECURITY DEFINER RPCs

`commit_assistant_message`, `add_assistant_message`, the embeddings
claim/save pairs - the project's existing RPCs that take user-scope
parameters and do the integrity check internally - are the safer
path. The RPC's `WHERE` clause runs inside the database with a
single source of truth for the relationship; the function code can
just hand off and trust the result.

Adding a new RPC for a new b-strict operation is encouraged.

### Tool implementations

Tools registered via `registerTool()` receive a `ToolContext` with:

- `adminClient: SupabaseClient` - service role.
- `userId: string` - authoritative; do not re-read from args.
- `threadId: string` - already validated upstream.
- `signal: AbortSignal` - tear down on cancel/wall-deadline.

Every direct query a tool runs falls under the same discipline.
Ported tools whose browser-side implementation used
`ctx.supabase.someHelper()` (a SupabaseService method that wrapped
the user-scoped client) need their queries rewritten to
`ctx.adminClient.from(...)...` with explicit user filtering. The
external contract (`execute(args, ctx)` signature) stays identical,
which is why the wire shape and the model don't notice the move.

### Tool-call result encoding

Tools' return values become tool-result rows via the orchestrator's
`encodeToolContent` helper, which mirrors the browser's wire shape
(`{ok, value} | {error}`). The model sees the same payload on
either path; do not deviate from this shape in new tools.

## What can go wrong

- **Forgetting `// RLS OFF`** on a new query. The query works (it
  bypasses RLS) but the next reader has no signal that filtering
  is the caller's responsibility. Add the comment; a grep audit
  is cheap and the comment is the audit's foothold.
- **Reading userId from the request body**. The body is
  attacker-controlled. The JWT's `sub` is gateway-verified. Use
  the JWT; never the body.
- **Passing userId from one async boundary to another without a
  re-check**. The orchestrator's `ToolContext` is constructed
  ONCE at /stream entry; the tool dispatcher trusts it because
  the construction site already validated. If a future code path
  reconstructs a ToolContext mid-stream (e.g. for a sub-agent),
  it must re-run the ownership check against current state, not
  trust a stale userId.
- **Treating service-role results as user-scoped by mistake**.
  When tests stub the adminClient with a user-scoped client (so
  RLS applies during the test), behavior diverges from production.
  Don't rely on RLS in tests against b-strict code; assert the
  filter is on the query.

## Why this trade-off

The b-strict model was picked over keeping the user-scoped client
specifically because the function outlives the session JWT. Two
alternatives were evaluated and rejected:

- **Hybrid: user-scoped while the JWT is valid, admin afterwards.**
  Doubles the number of code paths through every DB call; the
  switch point is non-obvious; mid-stream 401s would leak through
  on JWTs that expire seconds after the cutoff. The compounding
  cost in the orchestrator's already-complex round loop made this
  the harder choice in practice.
- **Per-row session refresh.** Asking the function to re-validate
  user context on each query (via a fresh service-role SELECT
  against threads.user_id, say) buys nothing the upfront
  ownership probe doesn't already buy, at the cost of one
  round-trip per query. Net regression.

The chosen model trades RLS as a safety net for a function that
survives session expiry. The discipline above is what makes the
trade a net win.

## Interactions

- **`docs/dev/in-progress/venice-edge-functions/streaming-root.md`** -
  the migration plan that introduced this model. Sections 2.4 and
  2.8 trace the lifecycle the model serves.
- **`docs/dev/in-progress/venice-edge-functions/cross-device-race-ui.md`** -
  v1+ polish where competing user sends become an explicit
  conflict. Same b-strict shape; the `commit_assistant_message`
  RPC's conflict-reason payload is what the loser-UI keys off.
- **`docs/dev/architecture.md`** - the top-level architectural
  overview. b-strict is a per-function decision, not a project-wide
  one; sibling functions stay on the request-scoped pattern unless
  they have the same outlives-the-request reason.
- **`supabase/schema.sql`** - houses the SECURITY DEFINER RPCs the
  function calls (`commit_assistant_message`,
  `add_assistant_message`, claim/save pairs), the Realtime
  Broadcast authorization policies on `realtime.messages` for the
  thread:<id>:stream and thread:<id>:control channels, and the
  `realtime_topic_thread_id` helper the policies use to extract
  the uuid from the topic string.

## Gotchas

- `realtime_topic_thread_id` returns `null` on a non-matching
  topic. Policies use `EXISTS (SELECT 1 FROM threads WHERE
  id = realtime_topic_thread_id(...))` so a null id silently
  excludes the row rather than throwing. Keep that pattern when
  adding new channels.
- The Realtime auth model requires the BROWSER to subscribe with
  `private: true` for the policies to engage. The function side
  (service_role) bypasses regardless. If a future browser channel
  subscriber omits the flag by accident, the policies don't fire
  and the channel becomes a public broadcast room whose name is
  treated as unguessable but isn't formally authorized.
- `verify_jwt: true` is project-wide in `supabase/config.toml`
  unless a per-function override exists. The venice function does
  NOT override it. If a future function wants to skip JWT
  verification, the `userIdFromJwt` trust assumption breaks; do
  not relax it on the streaming routes.
