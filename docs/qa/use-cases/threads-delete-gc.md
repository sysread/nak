# Threads: delete-as-hide and the fork GC sweep

## Covers

Whole-thread deletion via the hidden flag and the hourly fork GC
([dev: forking](../../dev/forking.md)), the hidden filters on list,
search, and worker-claim surfaces, and the deferred storage
reclamation handoff to attachment-gc
([dev: file-storage](../../dev/file-storage.md)). The end state
after a sweep must match what the old destructive delete produced
immediately.

## Preconditions

- Local stack up (`mise run dev-start`), signed in as the dev user.
- A disposable thread with at least one full exchange AND one image
  attachment (attach any small image to a user message before
  sending). Note its title; it should be distinctive enough to
  search for, e.g. `GC probe zebra`.
- psql access to the local DB (`mise run dev-sql`) for the DB-side
  expectations and for invoking the sweep ad hoc.
- Capture the thread's id before deleting:
  `select id from threads where title ilike '%zebra%';`

## Steps

1. Send a message in the probe thread and wait for the reply to
   settle. Attach an image on the user message.
2. In the drawer, open the probe thread's three-dot menu and click
   **Delete**.
3. Immediately search the drawer for the probe title, and check the
   drawer lists (including Archive).
4. In psql: `select hidden from threads where id = '<id>';` and
   `select count(*) from messages where thread_id = '<id>';`
5. In psql, run the sweep ad hoc:
   `select * from collect_hidden_threads();`
6. In psql:
   `select count(*) from threads where id = '<id>';` and
   `select count(*) from messages where thread_id = '<id>';`
7. Run the sweep a second time:
   `select * from collect_hidden_threads();`
8. In a second signed-in session (different browser profile) left
   open on the drawer during step 2: confirm the probe thread
   vanished from its drawer without a refresh.

## Expected

- (2-3) The thread disappears from the drawer instantly and does
  not match drawer search (neither by title nor semantically).
  Opening another conversation and coming back does not resurrect
  it.
- (4) `hidden = true`; message rows still present (destruction is
  deferred to the sweep - the UI hides, the GC destroys).
- (5) The sweep reports `deleted_threads >= 1` (the probe;
  more if other hidden threads were pending) and
  `trimmed_messages = 0` (no forks exist yet).
- (6) Both counts are 0 - thread row and message rows gone, exactly
  the old destructive delete's end state. Attachment rows are gone
  via cascade; the bucket object may linger until the daily
  attachment-gc, which is expected (deferred reclamation).
- (7) Second sweep reports `(0, 0)` - idempotent.
- (8) The other device's drawer dropped the thread on the realtime
  echo (the delete arrives as an UPDATE with hidden = true, not a
  DELETE event).

## Cleanup

None - the case destroys its own probe thread. The orphaned bucket
object is reclaimed by the next daily attachment-gc pass.

## Results log

| Date | Environment | Commit | Result | Notes |
| ---- | ----------- | ------ | ------ | ----- |
| 2026-08-24 | local (mise run dev-start) | 8f9e867e | PASS (1-7) | All 7 steps verified. Steps 2-3: thread vanishes from drawer instantly on delete, does not match title search. Step 4: hidden=true, 4 message rows still present (destruction deferred). Step 5: collect_hidden_threads() reports (1, 0) - one thread deleted, zero trimmed (no forks). Step 6: thread row + message rows + attachment rows all gone (cascade), matching old destructive delete end state. Step 7: second sweep reports (0, 0) - idempotent. Step 8 (cross-device realtime): code-verified - the delete arrives as UPDATE with hidden=true, and the realtime thread-UPDATE handler treats hidden=true as the delete signal (the list queries filter hidden=false). The orphaned bucket object is left for the daily attachment-gc (deferred reclamation by design). |
| 2026-08-24 | local (mise run dev-start) | 02f1dc64 | PASS (1-7, fork coexistence) | Re-run with a live fork. Deleting the PARENT of a fork: sweep reports (0, 2) - deleted_threads=0 (parent KEPT, fork depends on it), trimmed_messages=2 (parent rows past fork point at positions 5-6 trimmed). Parent messages: 6 to 4 (only past-fork-point rows removed). Fork transcript intact (8 rows) after sweep. The sweep's keep-set includes the fork's ancestors, so the parent is retained, not destroyed. This is the M4 contract: deleting a parent of a live fork preserves the shared prefix. |
