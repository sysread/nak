# Threads: titles, topic filters, and reply locks

## Covers

Thread title generation and pinning ([dev: chat](../../dev/chat.md),
[dev: summaries](../../dev/summaries.md)), topic tagging surfaces
([dev: topics](../../dev/topics.md)), and the per-thread multi-device
reply lock ([dev: auth-session](../../dev/auth-session.md),
[dev: chat](../../dev/chat.md)).

## Preconditions

- Local stack up (`mise run dev-start`), signed in as the dev user in one
  browser.
- A second signed-in session for the same user in another tab or browser.
- Two threads available: one new thread with no manual rename yet, and
  one other thread to switch to during the lock check.

## Steps

1. In the new thread, confirm the drawer title is `New conversation`.
2. Send `Please answer in one short sentence about thread titles.` and
   wait for the reply to settle.
3. In the thread header, click the title and rename it to `Pinned QA
   thread`.
4. Send `Now answer about a completely different topic.` and wait for the
   reply to settle.
5. Open the thread drawer `Topics` filter and note any topic pills that
   now appear for the thread.
6. Select one topic that matches the thread and one topic from another
   active thread.
7. Remove one selected topic with its pill `×`, then click `clear`.
8. In session A, start a new reply in `Pinned QA thread` and leave it
   streaming.
9. In session B, open `Pinned QA thread`.
10. In session B, switch to the other thread and focus its composer.
11. Stop or let the reply in session A finish, then return to `Pinned QA
    thread` in session B.

## Expected

- (1-2) The placeholder title starts as `New conversation` and flips to a
  generated title after the first completed assistant reply.
- (3-4) The manual rename to `Pinned QA thread` persists after the next
  reply; the assistant does not overwrite the pinned title.
- (5-7) The `Topics` picker shows checkbox rows with counts, selection
  creates pills, multiple selected topics broaden the result set, each
  pill `×` removes only that topic, and `clear` removes all active topic
  filters.
- (8-9) While session A is replying in `Pinned QA thread`, session B
  shows `Responding on another device` and disables the composer for that
  thread only.
- (10) Session B can still type in the other thread; the reply lock is
  per-thread, not global.
- (11) After the reply ends, session B regains the composer in `Pinned QA
  thread` without reloading the whole app.

## Cleanup

- Clear any topic filters left active in either session.
- Delete the QA threads if they are not otherwise useful.

## Results log

| Date | Env | Commit | Result | Notes |
| ---- | --- | ------ | ------ | ----- |
| 2026-08-21 | local (mise run dev-start) | f5e6c90b | PARTIAL | 10/11 steps pass. Step 7 not executable as written: `clear` is gated on 2+ selected topics (TopicsFilter.svelte), so it is absent after removing one of two pills; verified by re-selecting then clearing. Reply-lock steps (8-11) verified only after giving session B a distinct nak:holder:id - two tabs on one origin share the holder and the lock never fires, so Preconditions need a different origin/profile. Unrelated observation: MCP tool names (mcp:<uuid>:<tool>) 400 at Venice and break topics/summary curation. |
