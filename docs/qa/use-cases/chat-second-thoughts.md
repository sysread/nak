# Chat: second-thoughts per-message verdict (v1)

## Covers

The second-thoughts reflex (v1: detached, per-message, display-only).
Exercises the reviewer agent
(`supabase/functions/venice/agents/second_thoughts.ts`), its wiring in
the completed-turn tail (`getStreamingResponse.ts`), the
`messages.second_thoughts` column + its realtime UPDATE echo, the
`appendMessage` merge in `Chat.svelte`, and the `SecondThoughtsPanel`
render path through `AssistantBody.svelte`
([dev: second-thoughts](../../dev/in-progress/second-thoughts.md),
[dev: chat](../../dev/chat.md)).

## Preconditions

- Local stack up (`mise run dev-start`), signed in as the dev user.
- The reviewer model id is reachable on the configured Venice key. It
  pins `mistral-small-3-2-24b-instruct` in `second_thoughts.ts` (a fast
  non-reasoning model that reliably honors json_object); if that id is
  not available in the test environment, temporarily repoint
  `SECOND_THOUGHTS_MODEL` to any available fast NON-REASONING chat
  model. Avoid a reasoning model - it leaks chain-of-thought around the
  JSON and the parser drops the verdict (the bug this pin fixes).
- To read a verdict directly:

  ```sql
  select id, role, left(content, 40) as content, second_thoughts
  from messages
  where thread_id = '<thread-id>'
  order by created_at desc
  limit 4;
  ```

## Steps

1. Send an ordinary, uncontentious message (e.g. "What's the capital of
   France?") and wait for the reply to finish streaming. Keep watching
   the message for a few seconds after the text settles.
2. Send a message that invites an overconfident or shaky answer (e.g.
   "Roughly how many moons does Saturn have? Just give me the number.")
   and again watch the finished reply for a few seconds.
3. Expand the **Second thoughts** row on any reply that shows one.
4. Reload the page (or reopen the thread on another device) and look at
   the same replies.
5. Delete the test thread (trash icon in the drawer) and confirm the
   rows are gone (the `second_thoughts` verdict cascades with the
   message).
6. (Negative) In the Logs drawer, filter to the `second-thoughts`
   source while sending a turn.
7. (Refinement) On a turn whose verdict is a doubt (`hedge` /
   `reframe` / `correct`), observe the panel WITHOUT clicking, then
   click the disposition button ("Let me temper that", etc.). Watch the
   transcript and wait for the new turn to finish.
8. (Refinement anchor) After step 7 completes, send a normal follow-up
   message, then inspect the row order and the `second-thoughts`
   source + `stream` source logs for the refinement turn.
9. (Refinement gating) Scroll up to an OLDER answer that carried a
   doubt verdict and look for a button; also confirm the button on the
   latest answer is absent/disabled while a send is in flight.

## Expected

- (1) The reply streams and commits as normal with NO delay or blocking
  from the reviewer (v1 is detached). A beat AFTER the text settles, a
  small **Second thoughts** row appears below the answer, typically
  **Stands by it** (calm/muted) for a clean factual answer. The verdict
  appears without a manual reload - it arrives on the messages UPDATE
  echo.
- (2) Same timing. The verdict may be **Overconfident**, **May have
  misread**, or **Possible error** (red) depending on the model's read;
  any of the four dispositions is a valid pass as long as the row
  renders and its color/label match (`correct` -> red, `hedge`/`reframe`
  -> accent, `conviction` -> muted). The reviewer being low-context, an
  occasional doubt on a fine answer is expected, not a bug.
- (3) The row expands to a short first-person note (or a calm "no
  misgivings" line for a `conviction` with an empty note). The chevron
  rotates; the note is italic with a tone-colored left border.
- (4) After reload the verdict is STILL present (it is persisted on the
  row and `listMessages` selects it). This distinguishes it from the
  reasoning pills, which are in-memory only.
- (5) After delete, the `messages` rows (and their verdicts) are gone -
  the SQL query returns nothing for that thread.
- (6) The `second-thoughts` source logs one line per completed turn -
  either the disposition it wrote (`conviction on <id>`) or a skip/error
  debug line. It never logs on an aborted or errored turn (the tail runs
  only on `terminalKind === 'completed'`).
- (7) A doubt verdict's panel is ALREADY expanded when it lands (no
  click needed) and shows the disposition button. Clicking it starts a
  new streaming turn that APPENDS a fresh answer BELOW the original -
  the original answer stays put, nothing greys or disappears. The new
  answer may revise OR explicitly stand by the original (the injected
  doubt permits rejection). `conviction` verdicts show no button and
  stay collapsed.
- (8) Row order is `[user] -> [original answer + its panel] ->
  [refinement] -> [your follow-up + its answer]`; the refinement sorts
  after the original, not before it. The refined original's panel now
  carries a muted **"refined"** tag, and that tag SURVIVES a reload
  (the `acted` flag persisted via `mark_second_thoughts_acted`). The
  `stream` log shows the refinement ran with no priming lines (no
  samskara/intuition/recall for that turn) - it was a refinement, not a
  fresh user round. The refinement turn itself gets a `second-thoughts`
  verdict too (it is a completed turn); if that verdict is a doubt, the
  refinement - now the latest answer - carries its own button.
  Confirm the connective reaches the model: in the `chat`-source
  "venice request wire" log for your follow-up turn (step 8), the
  refined original assistant message's content ends with a `<think>`
  block voicing the doubt - present ONLY because you acted on it (an
  un-acted doubt never appears in the wire).
- (9) The older answer shows its verdict but NO button (only the latest
  answer is refinable, since a refinement appends at the tail). The
  latest answer's button is absent or disabled while any send is in
  flight.

## Cleanup

- Delete the test thread if you made one.
- If you repointed `SECOND_THOUGHTS_MODEL` in preconditions, revert it.

## Results log

| Date | Env | Commit | Result | Notes |
| ---- | --- | ------ | ------ | ----- |
| 2026-07-01 | - | claude/second-thoughts-feature-nca3sf | not executed | authored alongside the v1 feature; cloud session has no browser - needs a manual run against a local stack for the baseline |
