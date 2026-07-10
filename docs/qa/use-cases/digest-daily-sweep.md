# Daily conversation digest - sweep, claim, and panel

## Covers

- Conversation digest end to end: the `claim_next_digest_day`
  timezone day-gate, the `/digest-sweep` agent run, the
  `conversation_digests` row shape, and the Daily digest panel on
  the Chats tab. See
  [`docs/dev/conversation-digest.md`](../../dev/conversation-digest.md).

## Preconditions

- Local stack running (`mise run dev-start`), signed in as the dev
  login (`dev@nak.local` / `devpass123`).
- The cron shim running in a second terminal:
  `node scripts/dev-backfill-cron.mjs 30`.
- A Venice key seeded (any chat turn working proves this).
- At least one conversation with a few user/assistant exchanges whose
  messages are dated YESTERDAY in the profile's timezone. Natural
  state takes a day to occur; to fabricate it, backdate an existing
  thread's messages via `mise run dev-sql`:

  ```sql
  update messages set created_at = created_at - interval '1 day'
   where thread_id = '<thread-id>';
  ```

- No digest row for that day yet:

  ```sql
  delete from conversation_digests
   where digest_date = (now() at time zone 'UTC')::date - 1;
  ```

  (Substitute the profile's `displayTimezone` if set.)

## Steps

1. Watch the cron shim output for a `digest-sweep` tick (fires every
   base interval).
2. In the app, open the Logs drawer and look for the `digest` source.
3. Check the row landed: `select digest_date, summary,
   jsonb_array_length(threads) from conversation_digests;` via
   `mise run dev-sql`.
4. On the Chats tab, click the calendar button (next to "New
   conversation") in the top bar.
5. Click a conversation title inside the digest table.
6. Click the calendar button again, then press the browser Back
   button.
7. Run the sweep again (wait for the next shim tick).

## Expected

- (1-2) The Logs drawer shows `digesting <yesterday>` followed by
  `wrote digest for <yesterday> (N conversations)` under the
  `digest` source.
- (3) Exactly one row for yesterday; `summary` is non-empty prose;
  `threads` length matches the number of conversations that had
  traffic that day.
- (4) The main panel swaps to "Daily digest": one card per day with
  a date heading, an overview paragraph, and a Conversation/Summary
  table. The top-bar title reads "Daily digest". The URL carries
  `digest=1`.
- (5) The app navigates into that conversation's transcript and the
  digest panel closes (`digest` gone from the URL).
- (6) The calendar button reopens the panel; Back closes it and
  returns to the conversation (routed history entry).
- (7) No duplicate row appears (unique `(user_id, digest_date)` +
  the day-gate now sees a digest and claims nothing); the shim tick
  is quiet for `digest`.

## Cleanup

- Restore any backdated messages if the thread matters:

  ```sql
  update messages set created_at = created_at + interval '1 day'
   where thread_id = '<thread-id>';
  ```

- Optionally `delete from conversation_digests;` to reset the panel.

## Results log

| Date | Environment | Commit | Result | Notes |
| ---- | ----------- | ------ | ------ | ----- |
| 2026-07-10 | n/a (cloud session, no runnable stack) | pending | not run | Authored with the feature; needs a first local execution. |
