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
   **Fork**. Then fork the SAME parent a second time from the same
   menu (both forks share the tail fork point). Continue the
   walkthrough in the FIRST fork; the second exists only to verify
   the ordinal.
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

- (2-3) Each fork opens immediately as the active conversation,
  with the full prior transcript visible. Fork titles are the
  parent's title behind the fork marker - the fraktur-f sigil with
  a subscript ordinal: the first fork carries subscript 1, the
  second fork of the same point carries subscript 2. Both fork
  rows also carry the small git-branch glyph before the title. No
  error toast.
- (4) Exactly two fork rows, both `hidden = false`,
  `forked_from_thread_id = <parent-id>`, same `forked_from_msg_id`;
  titles are the parent's behind sigil-subscript-1 and
  sigil-subscript-2; model pin and toolboxes match the parent. The
  fork-point row belongs to the PARENT's segment
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
- (9) The semantic search hit for the shared content points at a
  visible FORK, not at the deleted parent, and opening the hit
  works. With two sibling forks at the same depth the tie resolves
  to the more recently active one - the first fork, which carries
  its own post-fork exchange.

## Cleanup

Delete both forks from the drawer; the next sweep destroys the
forks and the now-unreferenced hidden parent together (leaves
first, then root).

## Results log

| Date | Environment | Commit | Result | Notes |
| ---- | ----------- | ------ | ------ | ----- |
| 2026-08-24 | local (mise run dev-start) | 02f1dc64 | PASS (1-9) | All 9 steps verified. Fork opens immediately with full inherited transcript visible (4 msgs). Drawer shows both threads with same title; fork carries git-branch glyph. DB: fork owns 0 rows, thread_transcript(fork) returns 4 (full inherited prefix). Fork-point row is the parent's last settled assistant (position 4, parent-owned). Independent continuation verified: fork's reply lands in fork only, parent's new exchange lands in parent only, shared prefix shows in both. Worker cursors: checked after fork's first own exchange (timing window missed); cursors point at fork's own rows, not parent's. Delete parent: sweep reports (0, 2) - parent kept (fork depends on it), 2 rows past fork point trimmed. Fork transcript intact (8 rows) after sweep. Semantic search for "flurbnitz" resolves to the fork (only visible carrier), not the deleted parent; opening the hit works. |
| 2026-08-25 | local (mise run dev-start) | 15bb86d4 | PASS (1-9) | Re-run after the fraktur-f sigil + per-point ordinal title change. All 9 steps still pass. The fork title is now the source's title behind the sigil + subscript ordinal: first fork gets sigil-1, second fork from the same point gets sigil-2. The placeholder title passes through unmarked (auto-title still recognizes it). Drawer renders the sigil-prefixed title correctly. The old git-branch glyph img is replaced by the sigil in the title text itself. Ordinal increments correctly across multiple forks from the same fork point. Independent continuation, delete-parent survival, and semantic search resolution all unchanged - no regressions from the title-prefix change. |
