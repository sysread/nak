# Auto-title

Server-side curation unit that gives each thread a topical 3-6 word
title in place of the `'New conversation'` placeholder. Runs in the
venice edge function; there is no browser-side titling code.

## Role in the app

Every thread is created with `title = 'New conversation'`. The
auto-title unit claims a placeholder-titled thread (oldest first,
skipping rows the user manually pinned), asks the small fast model
(`mistral-small-3-2-24b-instruct`, hardcoded in the agent module) for a
title against the first user message, and writes the result back via a
claim-guarded RPC.

Two drivers run it:

- **Chat-turn tail** - `curateOnTurnTail(admin, userId)` fires from
  `getStreamingResponse.ts`'s `waitUntil` tail on every completed
  turn, before the reflection tail. Auto-title is the FIRST unit in
  the curation walk on purpose: title latency on a brand-new
  conversation is user-visible in the sidebar, while every other
  unit's output only surfaces on later interactions. Per-unit drain
  cap is 3 rows per tail.
- **Hourly curation sweep** - the `/curation-sweep` route (pg_cron
  job `nak-curation-sweep`, minute 57) runs `runCurationSweepTick`
  cross-user via the SECURITY DEFINER `*_sweep` claim RPCs, per-queue
  cap 10. Catches rows a failed tail attempt left behind for users
  who stopped conversing.

Double-driving is safe: the per-thread claim columns are the only
mutual exclusion - whichever driver claims first wins and the other
sees an empty queue. There is no worker lease for this unit.

The chat-loop's per-turn metadata system message stays silent about
titles on round 1 (this unit owns naming there) and falls back to
the loud nag from round 2 onward when the title is still the
placeholder. The nag rarely fires; it's the safety net for the case
where the tail hasn't reached the row yet. See `./chat.md` for the
metadata-message details.

## Files

- `supabase/functions/venice/agents/auto_title.ts` - the work unit:
  `titleOneThread` (per-user claim, tail driver), `sweepClaimAndTitle`
  (cross-user claim, sweep driver), the shared run half, the
  title-gen system prompt, and `sanitizeTitle` (first-line split,
  quote/punctuation strip, 80-char cap, first-letter capitalisation).
- `supabase/functions/venice/agents/curation.ts` - the composition
  layer that orders the five units and owns the drain loops
  (`curateOnTurnTail`, `runCurationSweepTick`).
- `src/lib/tools/update_title.ts` - the model-driven rename path the
  round-2+ nag triggers. Its sanitiser applies the same formatting
  rules so manual + automatic + tool-driven renames land identically.
- `supabase/schema.sql` (auto-title sections) - the claim columns,
  `claim_next_thread_for_auto_title`,
  `claim_next_thread_for_auto_title_sweep`,
  `save_thread_title_if_claimed`, `clear_auto_title_claim`.

## Entry points

- **`getStreamingResponse.ts` terminal tail** - on a `completed`
  turn, `curateOnTurnTail` walks the five units; auto-title drains
  first.
- **`/curation-sweep` route in `venice/index.ts`** - the hourly
  cron tick; `runCurationSweepTick` drains each queue cross-user.
- **Outcome vocabulary** - each cycle returns an `AutoTitleOutcome`
  (`empty-queue` / `titled` / `no-title` / `claim-lost` / `error`).
  The drain loops in `curation.ts` keep claiming on `titled`,
  `no-title`, and `claim-lost` (the cycle consumed a row and the
  queue may hold more) and stop on `empty-queue`. `error` is not
  classified here - `drainUnit` steps over an errored row so one
  failing thread cannot wedge the queue head, bailing only after
  `MAX_CONSECUTIVE_ERRORS` (see `../dev/summaries.md` gotchas).

## Data model

- **`threads.title`** - the placeholder `'New conversation'` until
  this unit (or the user, or the model via `update_title`) writes a
  real title.
- **`threads.title_manually_set`** - sticky flag the user's title
  input flips. The claim RPC excludes rows where this is true; the
  save RPC re-checks it so a manual rename mid-flight beats the
  agent silently.
- **`threads.auto_title_claim_holder`** +
  **`threads.auto_title_claim_expires`** - per-row claim, the sole
  mutual exclusion between the two drivers. Same shape as the
  reflection / summary / embedding claim columns; partial index on
  `auto_title_claim_holder is not null` keeps it tiny in steady
  state. Claim TTL is `CURATION_CLAIM_TTL_SECONDS` (120s), shared by
  all five curation units.

## Contracts

- `titleOneThread(admin, userId, log): Promise<AutoTitleOutcome>` -
  one per-user cycle: claim, generate, save-or-clear. Non-throwing;
  every failure path folds into an outcome the drain loop can act on.
- `sweepClaimAndTitle(admin): Promise<AutoTitleOutcome>` - one
  cross-user sweep step. Creates its own edge logger per claim (the
  claim is what tells it whose drawer the lines belong in) and
  flushes before returning.
- `claim_next_thread_for_auto_title(holder, ttl, p_user_id)` RPC -
  returns `{thread_id, user_text}` for the oldest eligible thread,
  or no rows when the queue is empty. Stamps the claim atomically.
  Eligible = title is the placeholder, `title_manually_set` is
  false, at least one user message exists, no live claim.
  `p_user_id` is the b-strict escape hatch: the service-role admin
  client has no `auth.uid()`, so the tail passes the thread owner's
  id explicitly.
- `claim_next_thread_for_auto_title_sweep(holder, ttl)` RPC -
  SECURITY DEFINER cross-user variant; same predicate without the
  user filter, returns `user_id` so the agent can attribute drawer
  logs and scope its save.
- `save_thread_title_if_claimed(thread_id, holder, title, p_user_id)`
  RPC - only writes if the claim is ours AND the row is still
  eligible (title still default, `title_manually_set` still false).
  Clears the claim atomically on a winning write. False return means
  a race; the agent drops the work as `claim-lost`.
- `clear_auto_title_claim(thread_id, holder, p_user_id)` RPC -
  releases the claim early when title generation returned null so
  the row re-enters the queue immediately rather than waiting for
  the TTL. Best-effort; the TTL is the authority on stuck claims.

## Interactions with other features

- **Chat** - chat's job is just to write messages; the completed
  turn's tail is what drives this unit. The chat-loop's round-2+
  metadata-message nag (`update_title` tool) is the safety net when
  the tail hasn't yet processed the row. See `./chat.md`.
- **Tools (update_title)** - the model can write a title via
  `update_title` whenever the chat-loop nag fires. The save RPC's
  predicate guards against double-write: if the model lands a title
  while this unit has a row claimed, the save sees a non-default
  title and returns false; the agent drops the work as `claim-lost`.
  See `./tools.md`.
- **Topics** - the thread-topics unit's eligibility predicate
  excludes placeholder-titled threads, so auto-title gets first
  crack at every new row. See `./topics.md`.
- **Embeddings** - the `clear_thread_embedding_on_change` trigger
  nulls `threads.embedding` whenever `threads.title` changes, so
  the embeddings backfill's next run re-embeds the thread with its
  freshly-titled state. See `./embeddings.md`.
- **Logging** - both drivers emit progress and error breadcrumbs
  through `createEdgeLogger(userId, 'auto-title')`, which reach the
  in-app Logs drawer over the `logs:<userId>` Broadcast topic. See
  `./logging.md`.

## Gotchas

- **Title latency is one turn, not one poll.** The tail runs after
  the response ships, so the title typically lands seconds after
  the first assistant reply - there is no polling interval. A
  thread whose tail attempt failed waits for the hourly sweep (or
  its own next turn).
- **`no-title` is not an error.** Title generation returns null on
  any failure (network blip, Venice 4xx, model emitted whitespace).
  The agent releases the per-thread claim so the row re-enters the
  queue immediately. `no-title` still counts as drain-worthy in the
  tail loop (unlike the topics units' `empty-topics`) - an
  immediate retry is the historical behavior for a transient title
  failure, and the drain cap bounds a deterministically failing row.
- **`claim-lost` is not an error.** The save RPC's predicate also
  guards against the user manually renaming the thread mid-flight
  AND against the model calling `update_title` mid-flight. Either
  case returns false from the save; the agent drains to the next
  row. The user-visible state is correct - someone else wrote a
  title, that's the title.
- **The eligibility predicate requires at least one user message.**
  A thread row with no messages (would only happen via direct DB
  write today; the UI always sends with a user message) is never
  claimed. If you ever introduce a "create empty thread" flow, the
  thread won't auto-title until a user message lands.
- **The model id is hardcoded in the agent module.**
  `AUTO_TITLE_MODEL = 'mistral-small-3-2-24b-instruct'` - the same
  cheap, fast, non-reasoning instruct model the other server-side
  curation agents (summary, topics, bias, samskara) use. There is NO
  `autoTitle` role in `AGENT_MODELS`; the curation agents run
  server-side and hold their ids directly (the edge function cannot
  import `src/lib`), so this is a bare string, not a mirror of a
  browser constant. Auto-title only ever sees the first user message,
  and its siblings already run the full thread through the same id, so
  there is no privacy reason to isolate it on a separate (e2ee) model -
  one shared, better-provisioned id also avoids the small-model 429
  overload that the earlier `e2ee-gpt-oss-20b-p` was prone to. The
  sub-call opts into `retryRateLimit` (see `_shared/venice.ts`), so a
  transient 429 is ridden out rather than failing the cycle.
- **`maxTokens` is 2048, not "title-sized."** The model sometimes
  emits a chain-of-thought preamble or ignores the length
  instruction; a tight wire cap truncated titles mid-word. The
  prompt controls answer length; `sanitizeTitle`'s first-line
  split and 80-char slice enforce it on the storage side.

## Where to go next

- `./chat.md` - the round-2+ `update_title` nag and the per-turn
  metadata message that owns it.
- `./tools.md` - `update_title` as a tool the model can call.
- `./summaries.md` - sibling curation unit, same plumbing shape.
- `./architecture.md` - background work in context.
