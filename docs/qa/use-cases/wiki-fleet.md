# Wiki: autonomous sweep, retry, librarian sweep + manual run

## Covers

The autonomous wiki agent's cron sweep and skipped-thread retry,
and the wiki librarian's scheduled sweep and user-triggered manual
run with live progress narration
([dev: wiki](../../dev/wiki.md)).

## Preconditions

- Local stack up, signed in as the dev user; `SR` = service-role
  key, `JWT` = the dev user's access token (password grant against
  `/auth/v1/token`).
- Sweep eligibility: a thread with 2+ user messages whose newest
  message predates today (user tz) and whose wiki pointer is
  stale. Reset one:

  ```sql
  update threads set last_wiki_processed_msg_id = null,
         wiki_claim_holder = null, wiki_claim_expires_at = null,
         wiki_failure_count = 0 where id = '<thread>';
  ```

- Librarian sweep eligibility: 3+ wiki articles on the user and a
  stale cadence stamp:

  ```sql
  update profiles set wiki_librarian_last_run_at = null
   where user_id = '<user>';
  ```

## Steps

1. Autonomous sweep: `curl -s -X POST .../venice/wiki-sweep` with
   the service bearer; watch the drawer's `wiki` source.
2. Retry: pick (or forge) a thread carrying a content-classifier
   skip marker and POST `/wiki-retry` with the user JWT and
   `{"threadId":"<id>"}`.
3. Librarian sweep: `curl -s -X POST .../venice/wiki-librarian-sweep`
   with the service bearer; watch `wiki-librarian`.
4. Librarian manual run: in the Wiki drawer tab, press the
   sparkles button, optionally with instructions; watch the
   progress strip AND the drawer.
5. Cadence gate: immediately re-tick step 3.

## Expected

- (1) `{"accepted":true}` immediately (detached tick); the drawer
  shows `[wiki] picked up -> asking <model> -> finished`; the wiki
  agent updates an existing article over creating a duplicate
  (update-over-create discipline); the thread's pointer advances.
- (2) Result union `{kind:'ok'|'no-op'|'error'}` in the response
  body, never a transport error for agent-level failures; on ok
  the skip marker clears.
- (3) `{"accepted":true}`; one user claimed (most overdue);
  cadence stamp written BEFORE the run; articles consolidated /
  out-of-scope ones deleted per the librarian's workflow.
- (4) The strip renders live steps with model-narrated activity
  text (the explicit withProgressNarration wrapper injects the
  `activity` param on manual runs only); the result card renders
  the final text as Markdown with a tool-count line; a concurrent
  run surfaces the busy message instead of doubling.
- (5) `{"accepted":true}` but the drawer shows no librarian run -
  the 12h cadence stamp from step 3 refuses the claim (slot
  consumed, by design).

## Cleanup

None usually - wiki writes are real but reviewable in the article
changelog. Delete QA-created articles by hand if forged.

## Results log

| Date | Env | Commit | Result | Notes |
| ---- | --- | ------ | ------ | ----- |
| 2026-06-09 | local | 7962dbd | pass (1,2) | concurrent shim+curl ticks claimed different threads; real wiki_update on the Nak article; retry kind=ok |
| 2026-06-09 | local | aef4b0c | pass (3,4,5) | textbook sweep (delete + merge + changelog); manual run exact scoped rename; collision -> busy; gate refused stamped user |
| pending | local | post-A1/A3 | - | re-verify (3)+(4) on the factory route + explicit narration wrapper - both code paths changed today |
