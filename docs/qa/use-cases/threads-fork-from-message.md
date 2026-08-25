# Threads: fork from a message card

## Covers

The fork-from-message entry point ([dev: forking](../../dev/forking.md)):
the per-message fork button (which rows offer it and which don't),
the hover range preview over the shared regen-preview channel, the
mid-conversation prefix cut (later rows stay behind, untouched),
explicit fork-point recording in the DB, and the reparent rule when
forking a fork at an inherited row - the first UI able to anchor a
fork on a row the current thread does not own.

The whole-conversation drawer fork, worker non-duplication, GC
survival, and search resolution are covered by
[threads-fork](./threads-fork.md); this case does not repeat them.

## Preconditions

- Local stack up (`mise run dev-start`), signed in as the dev user.
- A disposable thread with at least three full exchanges,
  distinctive title (e.g. `Fork card probe okapi`). At least one
  exchange must have used a tool (e.g. ask for a web search) so the
  transcript contains a tool-carrying assistant row and its tool
  rows.
- psql access (`mise run dev-sql`) for the DB-side expectations.

## Steps

1. Note the probe thread's id:
   `select id from threads where title ilike '%okapi%';`
2. Survey the fork buttons: check the action row of (a) a user
   message, (b) a plain settled assistant reply, (c) the
   tool-carrying assistant row inside a tool exchange, and (d) the
   closing assistant reply of that same tool exchange.
3. Hover (without clicking) the fork button on the SECOND
   exchange's assistant reply; then move the pointer away. Also
   hover the fork button on the LAST message in the transcript.
4. Click the fork button on the second exchange's assistant reply.
5. Switch back to the parent conversation and inspect the
   transcript.
6. In psql, confirm the fork-point recording:
   `select forked_from_thread_id, forked_from_msg_id, title from threads where forked_from_thread_id = '<parent-id>';`
   then `select count(*) from messages where thread_id = '<fork-id>';`
   and `select role, position from thread_transcript('<fork-id>') order by position desc limit 1;`
7. Reparent check: in the FORK (no new messages sent), click the
   fork button on the FIRST exchange's user message - an inherited
   row the fork does not own. In psql:
   `select forked_from_thread_id, forked_from_msg_id from threads where id = '<second-fork-id>';`
8. While a reply is streaming in any thread (send a message and
   look during the stream), check the fork buttons on earlier rows
   and the streaming bubble itself.

## Expected

- (2) The fork button (git-branch outline icon, same size and
  weight as the neighboring copy/trash icons) renders on the user
  row and on both settled assistant replies, with tooltip "Fork
  here - later messages stay in this conversation". It does NOT
  render on the tool-carrying assistant row or on tool-result
  cards - within a tool exchange, only the closing reply offers it.
- (3) Hovering red-outlines every row AFTER the hovered message -
  same outline as the regenerate/delete previews - and the hovered
  row itself stays un-outlined. Leaving clears the outline.
  Hovering the last message outlines nothing (a tail fork leaves
  nothing behind). No rows grey out or disappear at any point.
- (4) The fork opens immediately as the active conversation. Its
  transcript ends at the clicked reply - the third exchange is not
  in it. Title is the parent's behind the fraktur-f sigil +
  subscript ordinal; the drawer row carries the git-branch glyph.
- (5) The parent is fully intact: all three exchanges present, no
  outlines, no greying, nothing deleted.
- (6) One fork row with `forked_from_thread_id = <parent-id>` and
  `forked_from_msg_id` equal to the clicked reply's id (NOT the
  parent's tail). The fork owns zero message rows; its resolved
  transcript's last row is the clicked assistant reply.
- (7) The second fork's `forked_from_thread_id` is the ORIGINAL
  parent - the thread that owns the clicked row - not the fork the
  button was clicked in, and `forked_from_msg_id` is the first
  exchange's user-row id. Its transcript ends at that user message.
- (8) While streaming, the fork buttons on settled rows are
  disabled (same as copy/regenerate); the streaming bubble offers
  no fork button. After the turn settles the buttons re-enable.

## Cleanup

Delete the probe thread and both forks from the drawer; the sweep
reclaims them on its next cycle.

## Results log

| Date | Environment | Commit | Result | Notes |
| ---- | ----------- | ------ | ------ | ----- |
