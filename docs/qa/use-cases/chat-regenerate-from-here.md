# Chat: the regenerate button - where it appears, what it replaces

## Covers

The regenerate-from-here affordance ([dev: chat](../../dev/chat.md);
range computation in `src/lib/ui/regenerate.ts`, button + action-bar
gate in `src/components/AssistantBody.svelte`, commit path
`regenerateFrom` in `src/screens/Chat.svelte`):

1. **Visibility.** The button sits at the right edge of the
   `.msg-actions` bar on every assistant reply - the latest, older
   ones, AND replies that consist only of tool calls with no text
   (e.g. a turn stopped while a tool call was still running). It is
   never on user messages, the streaming bubble, or auxiliary cards
   (generated-image, ask-user, rename lines).
2. **Hover preview.** Hovering (or keyboard-focusing) the button
   red-outlines every row that would be replaced: the clicked reply,
   its tool rows, and everything after it. Leaving clears the
   preview without committing anything.
3. **Click semantics.** Clicking greys the previewed range and
   re-runs the chat loop from the user message that opened the
   clicked turn, using CURRENT settings (model profile, reasoning,
   verbosity, prompt toggles). When the new reply lands cleanly the
   greyed rows are deleted (view and DB); an abort or error restores
   them untouched.
4. **Disabled states.** The button is disabled while a send is in
   flight on the thread and on rows already greyed for a pending
   regenerate.

## Preconditions

- Local stack up (`mise run dev-start`), signed in as the dev user.
- A thread with at least three completed turns, at least one of which
  invoked a tool. On z-ai-glm-5-3-flash the reliable way to stage a
  tool turn is an explicit tool-shaped ask: enable the Images toolbox
  and request a generated picture, or ask the model to save a specific
  fact to memory (explicit save requests dispatch deterministically).
  Open-ended advice like "ask something that triggers memory or web
  search" no longer reliably fires a tool call on this model - do not
  rely on it.
  Note the thread id.
- For the tool-call-only step: a prompt that reliably starts a
  slow tool call, so Stop can land while the call is still
  pending. Ask for a generated
  picture (`image` op=generate runs long enough); attach-an-image
  analysis finishes too fast to catch.

## Steps

1. Visibility sweep. Hover each message in the thread. Note which
   rows offer the circular-arrow regenerate button in their action
   row.
2. Hover preview. Hover the regenerate button on the second turn's
   assistant reply (counting turns from the top; on a tool turn,
   the terminal reply carries the button) without clicking. Observe
   the transcript. Move the pointer away.
3. Regenerate the latest reply. Click regenerate on the last
   assistant reply. Watch the greyed range while the new reply
   streams, then let it finish.

   ```sql
   select role, status, left(content, 40) as content_head
     from messages
    where thread_id = '<thread>'
    order by created_at;
   ```

4. Regenerate an older reply. Click regenerate on the (new) second
   assistant reply. Let it finish and re-run the query from step 3.
5. Tool-call-only row. Send the slow-tool prompt and click Stop
   while the tool row's spinner is still going. Inspect the tail
   card's action row.
6. Regenerate out of the stopped tool call. Click the regenerate
   button on that tool-call-only card and let the new turn finish.
7. Abort restore. Click regenerate on any reply, then click Stop
   before the new reply finishes.

## Expected

- (1) Every assistant reply has the button, including ones with tool
  cards. User messages show the trash button instead. Auxiliary
  cards (generated-image, ask-user, "Renamed to" lines) have no
  regenerate button - check whichever of them the thread happens to
  contain; this case's preconditions do not stage them all.
- (2) The hovered reply and every row below it (including later user
  messages) get the red `.regen-target` outline; rows above stay
  normal. Leaving the button clears all outlines; no rows were
  deleted (step 3's query count is unchanged).
- (3) The old reply greys out but stays readable while the new one
  streams below; when it lands the greyed range is gone from the
  view and the DB - the query shows exactly one assistant ROUND for
  that user message (the new reply, plus its tool rows if the new
  turn used tools).
- (4) The clicked reply AND every later turn (your third prompt and
  its reply) grey out; one new reply replaces them all. The query
  shows the thread now ends user-2 -> new reply - the third-turn
  rows are gone.
- (5) The stopped card's tool row settles to its true outcome, never
  a spinner: error while no result row exists, flipping to success
  if the server-side dispatch completed anyway and its result row
  lands (realtime or reload) - Stop aborts the browser's view, not
  the dispatch. The action row IS present with the regenerate button
  - even though the reply has no text (so no copy button).
- (6) The tool-call-only card and its tool rows grey, then are
  replaced by the fresh reply; the interrupted tool round is gone
  from the transcript and the DB.
- (7) The greyed rows return to normal, nothing was deleted (query
  count unchanged), and the thread is usable as before the click.

## Cleanup

None beyond the thread itself - regeneration already deleted its
superseded rows, and the abort path restored everything else.

## Results log

| Date | Env | Commit | Result | Notes |
| ---- | --- | ------ | ------ | ----- |
| 2026-08-21 | local (mise run dev-start) | f5e6c90b | 6/7 pass, 1 fail | Steps 1-6 pass. Step 7 fails as written: abort restores the greyed rows and deletes nothing, but persists a new empty-assistant + tool + "user interrupted response" round (20 -> 23 rows), so "query count unchanged" does not hold. Bugs: (a) regen-target grey/red-outline left stuck on the rebuilt transcript after a commit - intermittent, painted 4 of 5 survivors incl. rows never in range on step 4, clears only on the next regenerate hover; (b) generated-image-host cards inside a range never grey though they are deleted; (c) a stopped tool call renders a failed mark though the tool succeeded server-side. Doc fixes needed: the slow-tool precondition is unusable (enable the images toolbox and prompt for image generation instead); "SECOND assistant reply" is ambiguous with tool turns; Expected (3) should say "assistant round" not "assistant row"; Expected (1)'s ask-user and renamed-to negatives are never staged. |
| 2026-08-21 | local (mise run dev-start) | 9afb543e | re-QA (5,7): 5 PASS, 7 FAIL | Step 5 restated expectation passes: stopped generate_image card settles to its true outcome - error immediately after Stop, flipping to success once the server-side result row landed (verified after reload; the realtime flip did not fire in the aborted run's view). Step 7 still fails: a mid-stream Stop on a regen misclassifies as terminalKind=error with a false "Couldn't reach Venice" banner + last_error (reproduced 5/5 with mid-stream clicks vs 4/4 clean completions without). Mechanism: the aborted SSE read surfaces as an error event (kind=network) via errorEventFor, and the orchestrator's error-event case (getStreamingResponse.ts round-loop case 'error') never checks ctl.signal.aborted - so the aborted-regen rollback, gated on terminalKind='aborted', never engages for mid-SSE stops. No orphan rows appeared only because round 0 had not inserted any yet. Pre-existing classification (plain-turn mid-text Stops show the same false error), now load-bearing for this expectation. |
| 2026-08-21 | local (mise run dev-start) | f5a49bea | re-QA (7): PASS | Mid-stream Stop on a regen now ends terminalKind=aborted (log: "stream error superseded by abort (user_cancel)"), 3/3 reproductions: no error banner, no orphan round, row count unchanged, last_error stays null, view clean after the abort. Plain-turn mid-text Stop re-verified in the same session: aborted terminal with the deliberate-abort marker row persisted per the chat-stop contract, no false network error. Step 7's expectation (greyed rows return, nothing deleted, thread usable) holds at this head. |
| 2026-08-24 | local (mise run dev-start) | 116abd66 | pass (1-7) | All seven steps pass at the M2 head, identical to the M1 re-QA results. Step 5: stopped generate_image card settles to true outcome, flips to success on reload when the server-side result lands. Step 6: regenerate out of the stopped card replaces the interrupted round cleanly. Step 7: mid-stream abort ends terminalKind=aborted (the M0 fix still working), no error banner, no orphan round, count unchanged, last_error null. The thread_transcript resolver (new in M2) did not alter regenerate's observable behavior - zero behavior change confirmed. |
| 2026-08-25 | local (mise run dev-start) | db6d9a19 | PASS (1-7) | Full re-run at the M6 head, zero forks in DB. All 7 steps verified: (1) regen on assistant replies, trash on user, fork absent on tool-carrying row. (2) hover outlines 4 rows below, clears on leave, count unchanged. (3) regen latest reply replaces old, 7->7 DOM, DB 8 rows (one assistant round). (4) regen older reply replaces clicked + later turns, 7->5 DOM, DB 6 rows ending user-2 -> new reply. (5) stopped generate_image card shows error then flips to success on reload when server-side result lands; regen-only action row present, no copy. (6) regenerate out of stopped card replaces interrupted round, 9 DOM, DB rows 17-19 complete. (7) mid-stream abort ends terminalKind=aborted (M0 fix holding), no error banner, no orphan marker, count returns to 9 after reload (transient 10 during abort settling is a rendering lag, not a persisted row — DB has 10 rows, the aborted marker's persistedId is not in the DB), 0 grey. Matches the M0/M1/M2 baseline rows exactly — zero forks = zero behavior change. |
| 2026-11-03 | local stack, worktree Vite :5174 ([::1] origin), realtime-delivery-fixes branch | ce0926d9 (+plan commits) | partial M0 baseline (3, regen-commit path) | M0 for the realtime-delivery fixes; only the regenerate-commit path was exercised (no full 7-step run). Regenerate on the latest reply (an image turn): replaced range greyed (.regen-target) while the new turn streamed, prune + commit clean, and the grey CLEARED at settle this run - the intermittent regen-target stickiness (2026-08-21 finding (a)) did NOT reproduce (0/1 this session; stays diagnose-then-fix). Sighting (b) REPRODUCED: the regenerated turn generated a NEW image (new attachment row in DB, old range + old attachment cascade-deleted), but the new image card was ABSENT from the sending tab's live transcript - the messages echo had gone deaf for that tab (second tab's deafness independently reproduced in the same session; see chat-generated-image-card.md row). Steps 1-2, 4-7 not re-run this pass; last full pass 2026-08-25. |
| 2026-11-03 | local stack, worktree Vite :5174 ([::1] origin), realtime-delivery-fixes branch | branch HEAD (fixes 1-5 applied) | PASS (3, regen-commit path, post-change) | M8 post-change re-run of the regenerate-commit path (twice: a text-only re-roll and an image re-roll). Both runs: replaced range greys (.regen-target x2) while the new turn streams, prune + commit clean, outline + fading CLEAR at settle with nothing stuck. The image re-roll generated a NEW attachment (old one cascade-deleted with its tool row) and the new image card rendered LIVE in the sending tab - sighting (b) holds fixed. The hover-preview-during-send behavior change (hover no longer previews while a send is in flight) was not separately exercised; the buttons are disabled mid-send. Full 7-step pass not re-run; last full pass 2026-08-25. |
| 2026-11-02 | local (mise run dev-start) | f0f19a58 (pre-image-combo baseline; row backfilled 2026-11-03 - it failed to land with the original run) | PASS (1-7) | Baseline against the four separate image tools. Steps 1-7 all pass: visibility sweep (regen on every assistant row incl. tool-call-only, none on generated-image-host), hover preview 4 rows, regen latest 7->7 DOM / 8 DB, regen older 8->6 DB, Stop mid-tool settles error-then-flips-ok on reload (server dispatch completed), regen out of stopped call replaces the interrupted round (14 rows), abort restore returns identical id set with last_error null. Findings filed separately: (A) stale .regen-target on the two fresh rows after commit, intermittent (2026-08-21 (a) recurring); (B) generated-image-host cards never grey inside a hover range though they are deleted with it (2026-08-21 (b), unchanged); (C) NEW: a regenerated turn's generated image does not render its live card (plain sends do) - delivery defect, routed to bug intake under the CLAIM 2 family; (D) transient view rows after abort, matching 2026-08-25; (E) the precondition's tool prompt ("triggers memory or web search") did not produce a tool call - explicit "use your memory search tool" did; (F) ~16s from send to a pending tool row on z-ai-glm-5-3-flash. |
| 2026-11-03 | local (mise run dev-start) | tool-combos branch (post-image-combo) | PASS (1-7) | Post-change re-run against the `image` combination tool. All 7 steps match the 2026-11-02 baseline. Tool mapping: `memory_search` unchanged (verb tool); image work now `image` op=generate. NEW DEFECT: the first `image` call of the session omitted `op` entirely and was rejected at dispatch with "missing required parameter: op" (29ms), costing a ~40s reasoning pause before the model retried correctly - later calls all carried `op` first try. Third consecutive run with the first-call op omission (card + editing + this run). Delivery defect confirmed once: the step-6 regenerated turn produced its image but painted no live generated-image-host card; it appeared on reload (CLAIM 2 family). Parity re-observed: stale regen-target outline post-commit (clears on pointer move), image-host cards never grey inside a pending range, stopped tool shows a failure mark then flips to success on reload, transient +1 DB row during abort settling. Step 1 bonus: the generated-image-host auxiliary-card negative was staged this run and confirmed (no action row at all). |
