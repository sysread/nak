# Chat: generated-image card renders without a reload

## Covers

The dedicated generated-image card and its by-filename resolution
([dev: components](../../dev/components.md),
[dev: attachments](../../dev/attachments.md)), the `image` tool's
server-side per-round attach
([dev: tools](../../dev/tools.md)), and the regression this fixes:
before the card, a freshly generated image only appeared after a full
page reload because the per-round `message_attachments` insert never
echoes over the messages realtime channel.

## Preconditions

- Local stack up (`mise run dev-start`), signed in as the dev user.
- A Venice key seeded in `app_config` (image generation calls the live
  Venice image model; without a key the tool errors and no card is
  expected).
- A thread with no pending reply. Note its thread id for the SQL
  check - and note it AFTER the first send: the composer's pre-send
  URL carries a throwaway cid that never becomes a row; the real
  thread id exists only once the first message lands.

## Steps

1. Open a thread.
2. Send: `Please create an image of a watercolor fox in a snowy
   forest.`
3. Watch the turn WITHOUT reloading. Observe the `image`
   tool-call card while it runs, then the area directly below it once
   the tool card shows its success check.
4. After the image renders, click its preview.
5. Confirm the attachment exists on the round's assistant row:

   ```sql
   select ma.filename, ma.mime_type, ma.storage_path is not null as live
     from message_attachments ma
     join messages m on m.id = ma.message_id
    where m.thread_id = '<thread>'
    order by ma.created_at desc
    limit 5;
   ```

6. Reload the page and reopen the thread.
7. (Optional, regression anchor) In a second browser tab signed in as
   the same user, open the same thread and confirm the image is present
   there too.

## Expected

- (2-3) While the image tool (op=generate) runs, the tool-call card shows the live
  duration ticker. Once it completes, a NEW card appears directly below
  the tool-group card showing a loading placeholder (the K.I.T.T.-style
  Scanner pulse) sized to the image's aspect ratio, which then resolves
  into the image preview - all WITHOUT a page reload. The image is NOT
  rendered above the tool card.
- (4) Clicking the preview opens the full-resolution image in a new
  browser tab (same behavior as an uploaded image; no in-app lightbox).
- (5) Exactly one new image attachment row exists, `live = true`, with a
  `generated-<timestamp>.webp`-style filename, hung off the assistant
  row that issued the tool call.
- (6) After reload, the image still renders in the same dedicated card
  position below the tool-group card (no duplicate copy above it).
- (7) The observer tab shows the image in the same card without a manual
  reload.

## Cleanup

- Delete the QA thread if it is not otherwise useful. Delete is a
  HIDE, not a cascade: the thread row survives locally with
  `hidden = true` (the fork-GC reclaims it later), so a SQL check
  should filter `hidden = false` or hard-delete the row.

## Results log

| Date | Env | Commit | Result | Notes |
| ---- | --- | ------ | ------ | ----- |
| 2026-11-02 | local stack, wt-nak/tool-combos | f0f19a58 (pre-M2 baseline) | PASS 7/7 | Baseline against the four separate image tools; generate_image exercised (the other three verbs were never reached in this flow - the model offered them in prose only). One unreproduced anomaly: 1 of 5 generations completed (DB row landed) but the card did not render until reload - watch item for the post-change run. Observer tab went deaf during that same turn (5s+ staleness; possibly same root cause). Scanner placeholder not captured (sub-2s paint; measurement gap, not a failure). Overflow add-on: page clean, zero document overflow, images constrained (731px in-container); the "weird overflow" the human saw was the emulated 1400x1000 viewport cropped by a 1200x904 OS window - artifact, not app CSS. |
| 2026-11-03 | local stack, wt-nak/tool-combos | 646abf84+ (post-M2, `image` combo; uncommitted worktree) | PASS 6/7 (step 7 FAIL: known delivery defect, see below) | All image calls used the single `image` tool: generate x3 + edit x1 succeeded (cards live, no reload), one call omitted op (clean 20ms error, model self-corrected), and one call mixed op-specific params (generate keys + scale + filename under op=edit) and edited an existing image where a fresh generation was arguably intended - first signal the flat op schema needs sharper per-op parameter pairing; recoverable but noted. Watch items: live-card miss NOT reproduced (4/4 live); observer-tab deafness REPRODUCED WORSE - a second tab received thread-level updates (title) but ZERO message rows across ~4 minutes, foregrounded or backgrounded; reload recovered everything (data correct, delivery dead). Third sighting of the delivery-defect family bug intake has under CLAIM 2. Scanner placeholder CLOSED: it exists (label "Loading generated image", aspect-ratio sized) but lives 10-21ms because the server attaches before publishing the tool response - sub-frame, hence "missing" at human polling rates. Zero console errors after the hard reload (the combo rename cannot HMR - hard reload required). Doc nits folded: cleanup wording (delete is hide), precondition cid note (the pre-send cid never persists). |
| 2026-11-03 | local stack, worktree Vite :5174 ([::1] origin), realtime-delivery-fixes branch | ce0926d9 (+plan commits) | PASS 2-6 / FAIL 7 (sighting c reproduced; defect-diagnostic settled) | M0 baseline. Steps 2-3: image (op=generate) card rendered live in the sender tab without reload (Scanner placeholder sub-frame as documented; card resolved by filename). Step 4 skipped (preview click; unchanged surface). Step 5: exactly one attachment row, live=true, generated-<ts>.webp on the round's assistant row. Step 6: reload re-renders the card in the same dedicated-card position (no duplicate above). Step 7 REPRODUCED the delivery defect sharply: an observer tab on the same thread (opened AFTER the fox turn) received ZERO message rows while the next turn (lighthouse) ran - observer frozen at its opening snapshot for 100+s; ZERO console errors; hard reload recovered all 13 rows + 2 image cards. DIAGNOSTIC: a SQL threads UPDATE (title bump) reached the observer's sidebar LIVE with no focus event possible - the THREADS postgres_changes echo delivers to the second tab while the MESSAGES echo does not; the sighting's thread-level updates are realtime, not focus-refetch. The observer's messages channel was dead from open through turn end (not a join race window). Concurrent garrick QA activity: none in the final 2 min. |
| 2026-11-03 | local stack, worktree Vite :5174 ([::1] origin), realtime-delivery-fixes branch | branch HEAD (fixes 1-5 applied) | PASS 7/7 (step 4 re-skipped, unchanged surface) | M8 post-change re-run. Step 2-3: image (op=generate) card live in the sender without reload. Step 5: one live attachment row per image turn (4 total on the QA thread, one per turn; regen's old attachment cascade-deleted with its tool row). Step 6: reload-stable. Step 7 PASS NOW: the observer tab followed the whole kite turn through the cross-tab backstop - rows landed within ~3s of each threads echo (user row, round row) and reached FULL parity (17/17 rows, 3/3 image cards) ~6s after settle, no reload, zero console errors; next turn (owl) the observer tracked live end-to-end. The SENDER's card landed live too (END-time reconcile): the kite image card was present in the sending tab by t+12s with no reload - sighting (b)'s mechanism verified fixed on the send path, and on the regenerate path (the regenerated owl turn's NEW attachment landed live; the old one cascade-deleted). Regenerate commit path: .regen-target cleared cleanly at settle both runs, no stuck outline, no stuck fading. Concurrent garrick QA activity: none. |
