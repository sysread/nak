# Threads: fork a conversation from the drawer

## Covers

The whole-conversation fork ([dev: forking](../../dev/forking.md)):
the drawer's **Fork** item, open-on-create, the drawer fork
indicator, the shared-prefix data shape (segment sharing, not
copying), independent continuation in both timelines, worker
non-duplication on the fork, delete-parent survival of the shared
prefix, and search's hidden-hit resolution.

## Preconditions

- Local stack up (`mise run dev-start`), signed in as the dev user.
- A disposable thread with at least two full exchanges. Distinctive
  title, e.g. `Fork probe okapi`, and distinctive CONTENT in the
  first exchange (a nonsense token like `flurbnitz` you can search
  for semantically later).
- psql access (`mise run dev-sql`) for the DB-side expectations.

## Steps

1. Note the probe thread's id:
   `select id from threads where title ilike '%okapi%';`
2. In the drawer, open the probe thread's three-dot menu and click
   **Fork**.
3. Observe the drawer and the open conversation.
4. In psql:
   `select id, hidden, forked_from_thread_id, forked_from_msg_id, title, model, toolboxes_enabled from threads where forked_from_thread_id = '<parent-id>';`
   and confirm the fork-point row:
   `select thread_id, role, position from messages where id = (select forked_from_msg_id from threads where forked_from_thread_id = '<parent-id>');`
5. In psql: `select count(*) from messages where thread_id = '<fork-id>';`
   then `select count(*) from thread_transcript('<fork-id>');`
6. Send a new message in the FORK and wait for the reply. Then open
   the PARENT and send a different message there. Check both
   transcripts.
7. In psql, after the workers have had a cycle (or run the worker
   crons ad hoc): check the fork's summary/topics cursors were not
   seeded at creation:
   `select last_summarised_msg_id, last_reflected_msg_id, last_topics_msg_id, last_chunked_msg_id from threads where id = '<fork-id>';`
   (run step 7's check BEFORE the workers process the fork's first
   own exchange if timing allows; afterward they legitimately point
   at the fork's own rows).
8. Delete the PARENT thread from the drawer. Re-open the fork and
   scroll to the top. In psql:
   `select * from collect_hidden_threads();` then
   `select count(*) from messages where thread_id = '<parent-id>';`
9. Search the drawer semantically for the nonsense token from the
   shared first exchange.

## Expected

- (2-3) The fork opens immediately as the active conversation, with
  the full prior transcript visible. The drawer shows two rows with
  the same title; the new one carries a small git-branch glyph
  before the title. No error toast.
- (4) Exactly one fork row: `hidden = false`,
  `forked_from_thread_id = <parent-id>`, `forked_from_msg_id` set;
  title matches the parent verbatim; model pin and toolboxes match
  the parent. The fork-point row belongs to the PARENT's segment
  (`thread_id = <parent-id>`) and is the parent's last user or
  settled assistant row.
- (5) The fork owns ZERO message rows (nothing copied), while
  `thread_transcript('<fork-id>')` returns the full inherited
  transcript.
- (6) The fork's reply lands in the fork only; the parent's new
  exchange lands in the parent only. Neither transcript shows the
  other's post-fork turns; the shared prefix shows in both.
- (7) Every cursor is null at creation (no seeding). Workers claim
  the fork only after its first own terminal reply, and memory /
  wiki extraction from the fork's first cycle produces no duplicates
  of facts already extracted from the parent's prefix (spot-check
  the memories list for a doubled entry).
- (8) The parent vanishes from the drawer instantly. The fork still
  renders its full transcript including the inherited prefix. The
  sweep reports `deleted_threads = 0` and `trimmed_messages >= 0`
  (the parent is hidden but KEPT - the fork depends on it; only
  rows past the fork point are trimmed). The parent's message count
  drops only by rows past the fork point, never below it.
- (9) The semantic search hit for the shared content points at the
  FORK (the only visible carrier of that history), not at the
  deleted parent, and opening the hit works.

## Cleanup

Delete the fork from the drawer; the next sweep destroys the fork
and the now-unreferenced hidden parent together (leaf first, then
root).

## Results log

| Date | Environment | Commit | Result | Notes |
| ---- | ----------- | ------ | ------ | ----- |
