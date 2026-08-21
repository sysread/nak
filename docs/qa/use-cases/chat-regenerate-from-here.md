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
  invoked a tool (ask something that triggers memory or web search).
  Note the thread id.
- For the tool-call-only step: a prompt that reliably starts a
  slow tool call, so Stop can land while the call is still
  pending. Enable the images toolbox and ask for a generated
  picture (`generate_image` runs long enough); attach-an-image
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
