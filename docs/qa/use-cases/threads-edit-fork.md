# Threads: edit-forks in a shared region

## Covers

The edit-fork flow ([dev: forking](../../dev/forking.md),
"Edit-forks"): the shared-region tooltip switch, delete-from-here
as fork-and-hide (selection swap, verbatim title, dependent fork
untouched), regenerate as fork-and-hide with the completion running
on the fork against an INHERITED anchor user message, private-tail
edits staying destructive, and the GC collecting the retired
threads.

Baseline discipline: after this case, re-execute
[chat-delete-from-here](./chat-delete-from-here.md) and
[chat-regenerate-from-here](./chat-regenerate-from-here.md) as
written (both are private-tail scenarios - no forks involved) and
confirm the results match their existing baseline rows exactly.
Zero forks means zero behavior change; any deviation is a
regression from this milestone.

## Preconditions

- Local stack up (`mise run dev-start`), signed in as the dev user.
- A disposable thread `Edit fork probe okapi` with three full
  plain exchanges (no tool use needed).
- psql access (`mise run dev-sql`).

## Steps

1. Note the probe thread's id (P) and its message ids/positions:
   `select id, role, position from messages where thread_id = '<P>' order by position;`
2. Using the message-card fork button, fork P at exchange 2's
   assistant reply (creates dependent fork D). Go back to P.
3. Tooltip survey in P (hover, don't click): the delete button on
   exchange 1's and exchange 2's user rows, and the regenerate
   button on exchange 2's reply; then the same buttons on exchange
   3's user row and reply.
4. Click delete-from-here on exchange 2's USER row in P and
   confirm.
5. In psql:
   `select id, title, hidden, forked_from_thread_id, forked_from_msg_id from threads where title ilike '%okapi%';`
   and `select count(*) from messages where thread_id = '<P>';`
6. Open D from the drawer and scroll through it.
7. Back in the conversation the drawer now shows in P's place
   (edit-fork E, same title): it should contain exchange 1 only.
   Click regenerate on its (only) assistant reply and let the new
   response finish.
8. In psql, re-run the step-5 thread query, plus:
   `select role, status, position from messages where thread_id = '<E2>';`
   where E2 is the newest thread row, and
   `select last_error from threads where id = '<E2>';`
9. Open D again and check its transcript top to bottom.
10. Private-tail check: in D (it has no children), send one new
    message, wait for the reply, then delete-from-here on that new
    message. In psql, re-run the step-5 thread query and
    `select count(*) from messages where thread_id = '<D>';`
11. GC: `select * from collect_hidden_threads();` then re-run the
    step-5 thread query.

## Expected

- (3) Exchange 1 and 2 buttons carry the fork copy: delete says
  "Delete this message and everything after it - the conversation
  continues in a new fork"; regenerate says "Regenerate this
  response - the conversation continues in a new fork". Exchange
  3's buttons carry the plain destructive copy (its rows sit after
  D's fork point). Hover previews red-outline the same ranges as
  always.
- (4) The view rolls back to exchange 1 with no error. The drawer
  row keeps the SAME title - no fraktur-f sigil, no ordinal - and
  the conversation list does not grow.
- (5) A new thread row E exists: `forked_from_thread_id = <P>`,
  `forked_from_msg_id` = exchange 1's assistant-reply id, title
  verbatim `Edit fork probe okapi`, hidden = false. P is
  `hidden = true`, and P still owns ALL its original rows (count
  unchanged - nothing was deleted).
- (7) The regenerate behaves like any other: old reply greys/clears
  and a fresh response streams in under exchange 1's user message.
  No error card; the title still carries no fork marker.
- (8) A newer thread row E2 exists: `forked_from_thread_id = <P>`
  (the reparent rule - the anchor user row is P's), and
  `forked_from_msg_id` = exchange 1's USER-row id. E from step 5 is
  now hidden. E2 owns exactly one message row: the new assistant
  reply, `status = 'complete'`, position 1 (positions restart per
  segment). `last_error` is null - the commit accepted the
  inherited anchor.
- (9) D is untouched, both times: full transcript through exchange
  2, exactly as it was before steps 4-7.
- (10) The private-tail delete is destructive, exactly as before
  forks existed: D's new user message and reply are deleted from
  the DB, no new thread row appears, D stays visible and selected.
- (11) The sweep reports `(deleted_threads, trimmed_messages) =
  (1, 2)`: E is deleted (hidden, childless, owns no rows), P is
  kept (hidden, but D and E2 depend on its rows) with exchange 3's
  two rows trimmed - they sit past the latest fork point among P's
  surviving children (D's, at exchange 2's reply). D and E2 still
  render their full transcripts afterward.

## Cleanup

Delete D and E2 from the drawer; the next sweep collapses the
remaining hidden chain (leaves first, then P).

## Results log

| Date | Environment | Commit | Result | Notes |
| ---- | ----------- | ------ | ------ | ----- |
| 2026-08-25 | local (mise run dev-start) | db6d9a19 | PASS (1-11) | All 11 steps verified. Step 2: forked P at ex.2 closing reply creates dependent fork D (0 own rows, transcript=10, fork-point=pos 12 parent-owned, title=𝔣₁ Edit fork probe okapi). Step 3: tooltip survey — ex.1 and ex.2 delete/regenerate buttons carry the shared-region fork copy ("continues in a new fork"); ex.3 buttons carry the plain destructive copy (rows sit past D fork point). Hover previews red-outline the same ranges. Step 4-5: delete-from-here on ex.2 user row in P → fork-and-hide: P hidden=true with all 14 rows kept (nothing deleted), edit-fork E created with same title (no sigil, markTitle=false), forked_from_msg_id=ex.1 assistant-reply id (pos 8), E owns 0 rows, transcript=6 ending at pos 8. Drawer shows E in P place (same title, no extra row). Step 6: D untouched (6 DOM rows, no outlines). Step 7-8: regenerate in E on its only assistant reply → E2 created (forked_from_thread_id=P via reparent, forked_from_msg_id=ex.1 USER-row id pos 1), E now hidden, E2 owns 1 row (assistant reply status=complete position=1, last_error=NULL — the commit accepted the inherited anchor, the M6 RPC fix verified live). Step 9: D still untouched. Step 10: private-tail delete in D (no children) → destructive: D own rows deleted, D stays visible, no new thread. Step 11: GC sweep reports (1,4) — E deleted (hidden, childless), P kept (D and E2 depend on its rows) with 4 rows past fork point trimmed (positions 13-16). D and E2 transcripts intact. M0 baseline smoke: with zero forks, delete tooltip is plain destructive, delete is destructive (0 rows, no new thread) — zero behavior change confirmed. Env note: Venice/Mistral flaky (one stuck stream, one ask_user suspension); think-leak pattern appeared again. All pre-existing, not M6 scope. |
