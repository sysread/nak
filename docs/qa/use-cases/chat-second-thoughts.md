# Chat: second-thoughts per-message verdict (v1)

## Covers

The second-thoughts reflex (v1: detached, per-message, display-only).
Exercises the reviewer agent
(`supabase/functions/venice/agents/second_thoughts.ts`), its wiring in
the completed-turn tail (`getStreamingResponse.ts`), the
`messages.second_thoughts` column + its realtime UPDATE echo, the
`appendMessage` merge in `Chat.svelte`, and the `SecondThoughtsPanel`
render path through `AssistantBody.svelte`
([dev: second-thoughts](../../dev/second-thoughts.md),
[dev: chat](../../dev/chat.md)).

## Preconditions

- Local stack up (`mise run dev-start`), signed in as the dev user.
- The reviewer model id is reachable on the configured Venice key. It
  pins `z-ai-glm-5-3-flash` in `second_thoughts.ts` with the thinking
  pass disabled at the call; if that id is not available in the test
  environment, temporarily repoint `SECOND_THOUGHTS_MODEL` to any
  available fast chat model and keep the disable pin. An unsuppressed
  thinking pass leaks chain-of-thought around the JSON and the parser
  drops the verdict (the bug the pin fixes).
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
10. (Background window) In a fresh thread, establish a detail in topic
    A ("I keep three beehives on the north field"), then pivot: ask two
    or three unrelated questions about topic B (say, sourdough). Now
    ask something in topic B whose answer naturally calls the topic-A
    detail back ("would any of this interfere with what else I have
    going on out there?"). Wait for the reply, then read that row's
    `second_thoughts` with the SQL above.
11. (Citation provenance) Ask something that forces a web search and
    invites quotation ("search for the latest NOAA guidance on X and
    quote the part that matters"). Wait for the reply, confirm it
    actually quotes and cites, then read that row's `second_thoughts`.
12. (Cross-turn citation) Immediately after step 11, WITHOUT searching
    again, ask a follow-up that leans on the same source ("does that
    guidance cover Y too?"). Read that row's `second_thoughts`.

## Expected

- (1) The reply streams and commits as normal with NO delay or blocking
  from the reviewer (v1 is detached). A beat AFTER the text settles, a
  small **Second thoughts** row appears below the answer, typically
  **Stands by it** (calm/muted) for a clean factual answer. The verdict
  reply commits and streams as normal. Then - and this is the key
  change - a clean answer shows **NO panel at all**: conviction is
  display-suppressed. Confirm via the SQL query that a `conviction`
  verdict WAS written to the row (the reviewer ran; it just renders
  nothing). A missing panel means "reviewed, no doubt", not "not
  reviewed".
- (2) A doubt turn DOES render a **Second thoughts** panel a beat after
  the answer settles (via the messages UPDATE echo, no manual reload):
  **Overconfident** / **May have misread** (accent) or **Possible
  error** (red). Only the three doubt dispositions ever show a panel;
  `conviction` never does.
- (3) The doubt panel is already expanded and shows a short first-person
  note (italic, tone-colored left border) plus the disposition button.
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
  doubt permits rejection). `conviction` verdicts render no panel at
  all, so there is nothing to click.
- (8) Row order is `[user] -> [original answer + its panel] ->
  [refinement] -> [your follow-up + its answer]`; the refinement sorts
  after the original, not before it. The refined original's panel now
  carries a muted **"refined"** tag, and that tag SURVIVES a reload
  (the `acted` flag persisted via `mark_second_thoughts_acted`). The
  refinement turn runs NO intuition/recall/bias priming (not a fresh
  user round), but the `samskara` source DOES log the doubt-keyed
  refinement probe ("refinement probe: spliced" when patterns fired,
  or "refinement probe: nothing fired" on a cold corpus) - and no new
  `samskara_fires` cohort appears for that turn (the probe is
  read-only; verify with
  `select count(*) from samskara_fires where thread_id = '<thread-id>'`
  before/after the refinement). The refinement turn itself gets a `second-thoughts`
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
- (10) The verdict is `conviction` (no panel). The reviewer is shown a
  `<conversation_so_far>` block covering the last six user/assistant
  messages, so the bee detail is on the visible record and a callback
  to it is grounded, not projection. A doubt whose note says the
  assistant referenced something the user never mentioned - when the
  user demonstrably did, within the window - is the regression this
  step guards. Note the window is six messages: pushing the topic-A
  detail further back than that legitimately puts it out of view.
- (11) The verdict is `conviction`. A doubt whose note questions
  whether a quoted passage or a cited URL is real is the regression -
  the transcript hands the reviewer a "source URLs this tool returned"
  line and a "quotations confirmed verbatim" line covering exactly that
  material, and the prompt tells it both are settled. Worth checking in
  the `chat`-source wire log that the quoted passage really did come
  from past the 4k truncation point, or the step proved nothing.
- (12) The verdict is `conviction`. The tool result from step 11 is not
  in this turn's slice at all; its URLs reach the reviewer through the
  `<conversation_so_far>` block's "source URLs tools returned earlier"
  line. A fabricated-citation doubt here means that line is missing or
  the window slid past the searching turn.

## Cleanup

- Delete the test thread if you made one.
- If you repointed `SECOND_THOUGHTS_MODEL` in preconditions, revert it.

## Results log

| Date | Env | Commit | Result | Notes |
| ---- | --- | ------ | ------ | ----- |
| 2026-07-01 | - | claude/second-thoughts-feature-nca3sf | not executed | authored alongside the v1 feature; cloud session has no browser - needs a manual run against a local stack for the baseline |
| 2026-07-05 | - | claude/samskara-second-thoughts-lnuuge | not executed | step-8 expectations updated for the refinement's doubt-keyed samskara probe (read-only, logged under the samskara source); cloud session has no browser - baseline for the v1 refinement flow was never run either |
| 2026-08-10 | - | claude/second-thoughts-effectiveness-7a3dyh | not executed | step 10 added for the reviewer's background window (the topic-pivot false-positive class); cloud session has no browser, and no pre-change baseline exists for any step in this file |
| 2026-08-10 | - | claude/second-thoughts-effectiveness-7a3dyh | not executed | steps 11-12 added for citation provenance (quotes past the tool-result truncation, and citations whose search ran in an earlier turn); cloud session has no browser |
