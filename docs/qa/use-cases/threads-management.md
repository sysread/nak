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
- A second signed-in session for the same user in a DIFFERENT
  browser profile (or a different browser / private window). Two
  tabs on one origin share the same holder id in localStorage, so
  the reply lock never fires between them.
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
6. Select one topic that matches the thread and two topics from
   other active threads (three selected total - the `clear` control
   only renders while 2+ topics are selected).
7. Remove one selected topic with its pill `×`, then click `clear`
   on the remaining two.
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
| 2026-08-24 | local (mise run dev-start) | 8f9e867e | PASS (1-7) | Steps 1-7 verified at the M3 head, identical to the M0 baseline. Auto-title flips after first reply (step 2). Manual rename to "Pinned QA thread" survives the next reply (steps 3-4). Topics dropdown shows checkbox rows with counts (step 5). Selecting 3 topics creates pills + clear button (step 6). Removing one pill with x leaves clear visible (2 selected); clear removes all (step 7). The known step-7 doc issue (clear gated on 2+ selected) is not a regression - the 3-topic workaround still works. Reply-lock steps 8-11: code-verified unchanged (M3 does not touch response_holder_id/response_claim_expires_at; only the delete path changed). The hidden filter on all list/search surfaces is applied at threads.ts lines 67/141/209/285. |
| 2026-08-24 | local (mise run dev-start) | 02f1dc64 | PASS (1-7) | Drawer regression baseline at the M4 head. All drawer-level behaviors unchanged: auto-title, manual rename pin, topics dropdown, topic-filter interactions, and the new Fork menu item (between Rename and Download, disabled for drafts). The Fork item creates and opens a fork correctly (verified in the threads-fork walkthrough). Reply-lock steps 8-11: code-verified unchanged (M4 does not touch the lock mechanism). The git-branch glyph renders before the forked thread's title in the drawer. |
