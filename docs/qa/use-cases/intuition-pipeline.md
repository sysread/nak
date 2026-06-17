# Intuition pipeline: triggers, cache, and think-block injection

## Covers

The subconscious priming layer that seeds the conscious agent's next
completion with a `<think>`-tagged internal monologue
([dev: intuition](../../dev/intuition.md)). Three things prove the
feature works end to end:

- **Trigger evaluation** - `evaluatePreRoundTrigger` in
  `src/lib/intuition/triggers.ts`: cold-start fires
  unconditionally, then a same-round debounce, then a mood-shift
  check (valence band index OR confidence column changed), then the
  staleness fuse. The fuse has two arms, either of which fires
  `'stale'`: `STALE_FUSE_ROUNDS` (8) user-rounds, OR `STALE_FUSE_MS`
  (1h) wall-clock since `computed_at_at` (the resume-after-a-pause
  case the round counter misses). Pre-round is the only live trigger;
  the `'title'` member of `IntuitionTrigger` is legacy-only (the
  mid-turn title trigger died when tool dispatch moved server-side).
- **Injection guard** - `isPayloadFreshForInjection` in
  `src/lib/intuition/triggers.ts`: before `runChatLoop` splices the
  `<think>` block it checks the cached payload is younger than
  `STALE_FUSE_MS`. A stale payload (refresh errored, deduped, or
  feature off) is suppressed, not injected - so a day-old synthesis
  never steers a turn. Same bound as the wall-clock trigger.
- **Cache read/coerce** - `threads.intuition_payload` jsonb is the
  single source of truth. `coerceIntuitionPayload` in
  `src/lib/intuition/types.ts` rejects drift / unknown-version /
  prompt-echo rows as null, which downgrades the next turn to a cold
  fire.
- **Think-block injection** - `buildIntuitionThinkMessage` in
  `src/lib/intuition/ephemeral.ts` projects the cached synthesis into
  `<think>{marker}\n{synthesis}\n</think>` on a synthetic assistant
  message, spliced into the in-memory history by `runChatLoop`
  (`src/lib/chat-loop.ts`). The message is never persisted to
  `messages` - it is rebuilt from the cache every round.

The seven-model-call pipeline itself (perception + 5 drives +
synthesis) runs BROWSER-side via `supabase.complete` (the
venice/complete edge function), not a server-side agent module - so
a live pipeline run needs Venice credentials and is the **[hosted]**
tail below. The samskara cases are the closest siblings
([samskara-formation](./samskara-formation.md),
[samskara-decay](./samskara-decay.md)): a subconscious layer
exercised deterministically by forging its cache via SQL.

Context recall ([dev: context-recall](../../dev/context-recall.md))
rides the SAME trigger evaluator in parallel but writes a separate
column (`context_recall_payload`); it has its own coverage and is
not re-verified here. The on-demand recall TOOLS
([chat-recall-agents](./chat-recall-agents.md)) are a distinct
feature - intuition is the automatic pre-round prior, not a tool.

## Preconditions

- Local stack up (`mise run dev-start`), schema applied, signed in
  as the dev user (`dev@nak.local` / `devpass123`).
- Logs drawer open, level at `Debug` or lower (the
  `pipeline starting` / `pipeline complete` lines are Info; the
  per-stage `perception` / `drive:<name>` / `synthesis` lines are
  Debug). Source-tag filter set to `intuition`.
- The dev user id and a thread to operate on. Any thread the dev
  user owns works; the SQL below targets the most-recently-touched
  one:

  ```sql
  select id from auth.users where email = 'dev@nak.local';
  select id, title, intuition_payload is null as cold
    from public.threads
   where user_id = (select id from auth.users
                    where email = 'dev@nak.local')
   order by updated_at desc limit 5;
  ```

- Inspect the cache shape on any populated thread (confirm the real
  column names before forging - the field is `computed_at_column`,
  NOT the `computed_at_confident` that the `schema.sql` comment
  mislabels):

  ```sql
  select intuition_payload->>'v'                 as v,
         intuition_payload->>'trigger'           as trigger,
         intuition_payload->>'computed_at_round' as round,
         intuition_payload->>'computed_at_band'  as band,
         intuition_payload->>'computed_at_column' as col,
         left(intuition_payload->>'synthesis', 60) as synth_head
    from public.threads where id = '<thread-id>';
  ```

- To force a mood trigger you need the mood pill populated for the
  active thread. Mood state (`moodState.current`) is owned by the
  pill and seeded on thread open from the latest samskara fire, so
  use a thread that has fired samskaras (the long-lived dev corpus
  qualifies). The pill emoji at the bottom-right of the messages
  pane being non-gray confirms a mood is live.

## Steps

Run the SQL forging steps inside `begin; ... rollback;` where noted
so the real cache survives. The trigger-arithmetic and coerce checks
(steps 1-4) are fully deterministic and need no Venice. Step 5 is the
live pipeline and is **[hosted]**-flavored (needs Venice creds).

1. **Cold-cache fire.** Null the column on the target thread, reload
   the app on that thread, and send one message:

   ```sql
   update public.threads set intuition_payload = null
    where id = '<thread-id>';
   ```

   Watch the Logs drawer (source `intuition`).

2. **Cache landed + pill + modal.** After step 1's turn completes,
   confirm the cache wrote and read it back:

   ```sql
   select intuition_payload->>'trigger'           as trigger,
          intuition_payload->>'computed_at_round' as round,
          jsonb_object_keys(intuition_payload->'drives') as drive
     from public.threads where id = '<thread-id>';
   ```

   Then click the brain pill (bottom-right of the messages pane,
   above the mood pill) to open the diagnostics modal.

3. **Same-round debounce.** Without sending a new user message,
   trigger any chat-loop re-entry that does not bump the user-round
   count (e.g. a regenerate of the same turn, or simply observe that
   no second `pipeline starting` line appears for the same round).
   Read the cache's `computed_at_round` and compare to the live user
   count. A re-fire in the same round must NOT run the pipeline.

4. **Coerce rejection -> cold downgrade.** Forge a drifted payload
   and confirm the reader treats it as no-cache. The reader runs in
   the browser, so verify behaviorally: write a bad row, reload,
   send a message, and watch for a `cold` fire rather than a reuse.

   ```sql
   begin;
   -- unknown version: coerceIntuitionPayload rejects v != 1
   update public.threads
      set intuition_payload = jsonb_build_object(
            'v', 99, 'perception', 'x', 'synthesis', 'y',
            'computed_at_round', 1, 'computed_at_band', 0,
            'computed_at_column', 'confident',
            'computed_at_at', 0, 'trigger', 'cold')
    where id = '<thread-id>';
   select coalesce(intuition_payload->>'v','<null>') from public.threads
    where id = '<thread-id>';
   rollback;
   ```

5. **[hosted]** Live mood-shift fire. With a populated, non-cold
   cache whose `computed_at_band` / `computed_at_column` you have
   read, change the live mood so the band index or confidence column
   differs, then send a message:

   - open a thread whose mood pill differs from the cached snapshot
     (a different valence cell), OR force a fresh samskara mint so
     the mood pill moves (see
     [samskara-formation](./samskara-formation.md) step 8), then
   - send one user message on the thread whose cache carries the
     OLD snapshot.

   Watch the drawer for a `pipeline starting` line tagged
   `{ trigger: 'mood' }`, the five `drive:<name>` debug lines, the
   `synthesis` debug line, and `pipeline complete` with
   `drivesAvailable`. Then re-read the cache: `trigger` is now
   `'mood'`, `computed_at_round` matches the new user count, and the
   band/column equal the new live mood.

6. **[hosted]** Stale fuse. On a thread with a current cache,
   backdate the cached round so `round - computed_at_round >= 8`,
   reload, and send a message with the live mood UNCHANGED from the
   cache (so mood does not pre-empt the fuse):

   ```sql
   update public.threads
      set intuition_payload =
            jsonb_set(intuition_payload, '{computed_at_round}', '0')
    where id = '<thread-id>'
      and intuition_payload is not null;
   ```

   The fire's `trigger` must be `'stale'`, not `'mood'` or `'cold'`.

7. **[hosted]** Wall-clock stale fuse. On a thread with a current
   cache and the live mood UNCHANGED, leave `computed_at_round` close
   to the live round (so the round arm does NOT trip) but backdate
   the wall-clock stamp past one hour, reload, and send a message:

   ```sql
   update public.threads
      set intuition_payload = jsonb_set(
            intuition_payload,
            '{computed_at_at}',
            to_jsonb((extract(epoch from now()) * 1000)::bigint - 3700000))
    where id = '<thread-id>'
      and intuition_payload is not null;
   ```

   (3,700,000 ms ~ 61.7 min.) The fire's `trigger` must be `'stale'`
   even though only one round elapsed - the wall-clock arm carried it.

8. **Injection guard suppression.** Backdate the wall-clock stamp
   past one hour AND set `computed_at_round` to the live round so the
   same-round debounce blocks any refresh this turn (forcing the
   "refresh could not run" path). Reload, open the Logs drawer at
   `Debug` with source filter `chat-loop`, and send a message:

   ```sql
   update public.threads
      set intuition_payload = jsonb_set(
            jsonb_set(intuition_payload, '{computed_at_at}',
              to_jsonb((extract(epoch from now()) * 1000)::bigint - 3700000)),
            '{computed_at_round}',
            -- set to the CURRENT live user-round count for this thread
            '<live-round>')
    where id = '<thread-id>'
      and intuition_payload is not null;
   ```

   Read the `venice request wire` debug line's `messages` array. The
   stale intuition `<think>` block must be ABSENT from the wire.

## Expected

- (1) A single `pipeline starting` Info line with
  `{ trigger: 'cold', round: 1 }` (round 1 on a fresh thread; the
  live user-message count otherwise), source `intuition`. On a cold
  cache the trigger is ALWAYS `cold` - it never waits for a title
  call (the dead `'title'` trigger does not fire here).
- (2) The row carries `v = 1`, `trigger = cold`, `computed_at_round`
  equal to the user-message count at the turn, and up to five
  `drives` keys (`attunement`, `candor`, `curiosity`, `pragmatism`,
  `standing`). Fewer than five means a drive call failed and was
  omitted - the synthesis still ran. The brain pill is enabled (not
  gray); the modal shows the synthesis text, the perception (leading
  `Classification: <category>`), and one panel per drive (a
  failed/omitted drive renders an "unavailable" placeholder). The
  synthesis shown in the modal is byte-identical to the
  `<think>` content injected into the completion - cache is the one
  source, modal and ephemeral message are two projections of it.
- (3) No second `pipeline starting` line for the same
  `computed_at_round`. The same-round debounce (`computed_at_round
  >= round`) is the only duplicate-run guard; a re-entry within the
  round is a no-op regardless of mood.
- (4) The bad row reads back as no-cache behaviorally: the next turn
  fires `cold` (a fresh pipeline) rather than reusing the drifted
  payload. `coerceIntuitionPayload` rejects on `v != 1`, empty
  perception/synthesis, a synthesis containing
  `You are the Subconsciousness` (the prompt-echo guard), a
  non-finite round, or an out-of-enum `computed_at_column`.
- (5) **[hosted]** The mood fire runs the full seven calls
  (1 perception + 5 parallel drives + 1 synthesis), visible as the
  staged Debug lines under source `intuition`, and the rewritten
  cache carries `trigger = mood` with `computed_at_band` /
  `computed_at_column` matching the NEW live mood. The transcript
  shows NO rendered `<think>` block - the injection is invisible in
  the message list by design (the marker exists for a UI that is not
  built); the proof of injection is the cache contents plus the
  conscious response having run after the pipeline completed.
- (6) **[hosted]** The fuse fire carries `trigger = stale`. Order of
  checks in the evaluator means mood is tested before the fuse, so
  this only reads `stale` when the live mood matches the cached
  snapshot; if mood differs you will see `mood` instead - that is
  correct, re-run with the mood held steady.
- (7) **[hosted]** The fire carries `trigger = stale` driven by the
  wall-clock arm alone (one round elapsed, mood unchanged). This is
  the regression guard for the resume-after-a-pause bug: a payload
  computed the night before must re-perceive on the next-day turn
  rather than inject yesterday's pulse.
- (8) The `chat-loop` `venice request wire` debug line shows the
  `messages` array with NO stale intuition `<think>` block: the
  same-round debounce blocked the refresh, so the guard suppressed
  the day-old payload rather than steering the turn with it. (The
  conscious response still runs; it just runs un-primed this turn,
  which is correct - better un-primed than mis-primed.)

## Cleanup

- Steps that wrap in `begin; ... rollback;` (the coerce-rejection
  forge in step 4) change nothing.
- Step 1 nulls the cache deliberately; the cold fire repopulates it,
  so no manual restore is needed once the turn completes. If you
  abort before the turn runs, the thread is simply cold until its
  next trigger - acceptable, not a corrupted state.
- Step 6 backdates `computed_at_round`; the stale fire overwrites the
  whole payload, so the backdate does not persist. If you abort
  before the fire, run step 1's null + a fresh turn to get a clean
  payload back, or leave it - the next mood/stale trigger self-heals.
- Steps 7-8 backdate `computed_at_at` (and step 8 `computed_at_round`).
  Step 7's stale fire overwrites the payload; step 8 deliberately
  suppresses the refresh, so its backdated stamp persists - the next
  trigger (a later round or the 1h fuse) self-heals it. Run step 1's
  null + a fresh turn if you want an immediately clean payload.
- The cache holds only the most recent payload (no history table),
  so there is nothing else to undo.

## Results log

| Date | Env | Commit | Result | Notes |
| ---- | --- | ------ | ------ | ----- |
