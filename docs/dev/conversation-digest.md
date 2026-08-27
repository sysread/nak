# Conversation digest

## Role

Once per (user, local calendar day), after that day has ended in the
user's timezone, a background agent reads every conversation the user
had that day and writes one `conversation_digests` row: a short
overview of the day plus a per-thread `{thread_id, title, summary}`
table. The Daily digest panel on the Chats tab renders those rows as
a changelog-style page (newest day first, "Load more" pagination) and
deep-links each entry back to its conversation.

The panel is deliberately NOT the Chats tab's default surface (unlike
the wiki changelog, which is the Wiki tab's home). The empty
new-conversation view keeps that role for UX ergonomics; the digest
opens from a calendar button next to "New conversation".

## Files

- `supabase/schema.sql` - `conversation_digests` table, the
  `digest_claim_holder` / `digest_claim_expires_at` pair on
  `profiles`, `claim_next_digest_day`, `save_conversation_digest`,
  `nak_trigger_digest_sweep`, and the `nak-conversation-digest-sweep`
  pg_cron job (minute 53).
- `supabase/functions/venice/agents/digest.ts` - the sweep tick:
  claim, fetch the day's messages, one JSON-object completion,
  save-if-claim-held.
- `supabase/functions/venice/index.ts` - the `/digest-sweep` route
  (service-role gated, detached via `sweepHandler`).
- `src/lib/supabase/digests.ts` + `src/lib/supabase/types/digests.ts`
  - read-only data slice (`listConversationDigests`) and row
  coercers; facade method on `SupabaseService`.
- `src/lib/ui/digest-panel.ts` - pure UI primitives (page size, date
  label, count label, exhaustion predicate).
- `src/components/DigestPanel.svelte` - the panel.
- `src/screens/Chat.svelte` - calendar top-bar action, lazy chunk,
  and the `route.digest` branch that swaps the transcript for the
  panel.
- `src/lib/routing.svelte.ts` - the `digest` route key (`?digest=1`).
- `scripts/dev-backfill-cron.mjs` - local stand-in tick for the
  hosted cron job.

## Entry points

- **pg_cron, hourly at minute 53** -> `nak_trigger_digest_sweep()`
  -> `POST /functions/v1/venice/digest-sweep` (service-role bearer
  from Vault) -> `runDigestSweepTick`. Hourly rather than daily
  because eligibility flips at each user's LOCAL midnight; the
  per-user day-gate lives in the claim RPC, the cron just ticks.
- **Browser**: `app.supabase.listConversationDigests({limit,
  before})`, cursor-paged on `digest_date desc`.

## Data model

`conversation_digests`: `id`, `user_id` (cascade), `digest_date date`
(the USER'S calendar day, not a UTC bucket), `summary text`,
`threads jsonb` (array of `{thread_id, title, summary}` snapshots),
`created_at`, unique `(user_id, digest_date)`, index
`(user_id, digest_date desc)`.

RLS is select-only for the owner. There are no insert/update/delete
policies at all: every write comes from the sweep agent under the
service role (which bypasses RLS), so the browser cannot forge or
edit history.

Titles inside `threads` are snapshots taken at digest time - same
rationale as `wiki_changelog.title_at_change` - so a digest stays
readable after the source conversation is deleted. `thread_id` is
kept for deep-linking; a deleted thread's link lands on an empty
transcript, which is accepted.

## Contracts

- **Eligibility** (all inside `claim_next_digest_day`): the user's
  timezone comes from `profiles.settings.displayTimezone` via
  `nak_safe_timezone` (UTC fallback); a day is due when it is
  strictly before today in that timezone, has at least one non-empty
  user/assistant message, and has no digest row. There is **no
  backfill floor**: the sweep drains the user's entire history
  oldest-first, a few user-days per hourly tick, until every past
  day is digested.
- **Opt-out**: `profiles.settings.conversationDigestEnabled` gates
  the claim - only the literal string `'false'` disables (string
  compare, not a boolean cast, so one malformed value cannot wedge
  the global sweep; same guard as `wikiAutomaticEnabled`). There is
  no Settings UI toggle yet; the key is honored if set.
- **Claim discipline**: per-user claim pair on `profiles` with a
  600s TTL, plus a consecutive-failure pair (`digest_failing_date`,
  `digest_failure_count`). A failed run (bad JSON, truncated
  completion, transport error) reports through
  `record_digest_failure`, which releases the claim for an hourly
  retry; after 3 consecutive failures on the same day it writes a
  placeholder row and advances the queue. The cap is load-bearing:
  the claim always serves the OLDEST undigested day, so an
  uncapped poison day would pin every day behind it forever.
  Success (`save_conversation_digest`) resets the failure pair.
- **Save**: `save_conversation_digest` releases the claim and inserts
  in one call, returns false if the claim was lost (the loser's
  result is dropped), and inserts `on conflict do nothing` so a raced
  duplicate is a no-op.
- **Completion shape**: one `completeJsonObjectWithMeta` call,
  `z-ai-glm-5-3-flash` (model id held in `digest.ts` directly - edge
  modules cannot import `src/lib`), `maxTokens: 65536` (a reasoning
  pass can run chatty and scales with the whole-day input; the
  model is cheap, so the budget is sized so only a runaway hits it),
  `reasoningEffort: 'low'`, fail-closed on
  `finish_reason === 'length'` (see CLAUDE.md, "Venice
  sub-completions on reasoning models"). Thread ids in the reply are
  validated against the fetched set - hallucinated ids are dropped
  rather than persisted as dead links.
- **Routing**: `?digest=1` is a presence flag. Opening a thread
  (sidebar click or a digest deep-link, both via `selectThread`)
  clears it in the same `navigate` patch, so a (cid-change + digest
  open) history entry can never exist. `selectThread`'s equal-id
  early return also clears the flag, so clicking the already-active
  sidebar row exits the digest instead of doing nothing.
- **Exits**: while the panel is open, the top-bar "New conversation"
  button stays enabled even on an empty thread and acts as "back to
  the conversation" (`newThreadButtonState` in
  `src/lib/ui/chat-screen.ts`). The transcript-view gating (disabled
  on an empty thread) would otherwise read as "you cannot leave the
  digest".

## Interactions

- **Chat / threads** (`docs/dev/chat.md`) - reads `messages` joined
  through `threads` for ownership; the panel deep-links via
  `selectThread`. Deleting a thread leaves digests intact (snapshot
  titles).
- **Background-job model** (`docs/dev/architecture.md`) - claim-RPC
  pattern, Vault-secret cron trigger, detached `sweepHandler` route,
  and the shared cron minute ladder (digest owns minute 53).
- **Settings** (`docs/dev/settings.md`, if present) - reads
  `displayTimezone` and `conversationDigestEnabled` off
  `profiles.settings` server-side; no browser coupling.
- **Wiki** (`docs/dev/wiki.md`) - no runtime coupling, but the
  changelog-panel UI shape and the timezone day-gate are deliberate
  clones of the wiki's; if the wiki's day-gate semantics change,
  consider whether the digest gate should follow.

## Gotchas

- `digest_date` is a plain date in the user's timezone.
  `formatDigestDate` parses it field-by-field into a LOCAL `Date` -
  `new Date('YYYY-MM-DD')` parses as UTC midnight and renders the
  previous day for hosts west of Greenwich.
- The claim RPC returns `day_start` / `day_end` as UTC instants
  computed in SQL (`date::timestamp at time zone tz`). The edge
  agent must not re-derive day boundaries in JS - IANA timezone math
  in Deno would just duplicate the DB's, with DST bugs.
- A day whose messages were all deleted between claim and fetch gets
  a placeholder row ("No conversations on this day.", empty threads)
  - persisting nothing would re-claim the same day every tick.
- The sweep only fires locally via `scripts/dev-backfill-cron.mjs`
  (the local stack ships neither pg_cron nor pg_net). If a new day
  never digests in dev, the shim isn't running.
- The hourly cadence plus `DEFAULT_SWEEP_MAX_USERS = 3` means a
  backlog larger than 3 user-days drains across ticks, not in one -
  a deep history backfills at ~72 days/day.
- The day-picking lateral scans every message the user owns on each
  claim call (min over the whole history with a per-day not-exists).
  Fine at single-user scale; if it ever shows up in pg load, the fix
  is a floor keyed to the oldest undigested day, not a calendar
  window.
