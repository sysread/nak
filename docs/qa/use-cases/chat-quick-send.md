# Quick send: one turn with the priming stage skipped

## Covers

The quick-send button (the lightning bolt right of the send button)
and the per-turn priming skip it drives:

- **The skip itself.** A quick turn ships `skipPriming: true` and
  omits the intuition / context-recall inputs, so the server's
  priming stage runs nothing: no bias appendix, no intents, no
  samskara compound or fire, no intuition, no context recall.
- **What is NOT skipped.** Tools, the tool catalog, user-configured
  system prompts, the per-turn metadata block, and the
  turn-completion tail (auto-title, curation, the samskara substrate
  stub) all run as normal.
- **The button's state machine.** Same idle disable rules as send
  (empty composer, archived, foreign claim); disabled while a turn
  streams (only the send button becomes stop).

Dev refs: [prompt-augmentation](../../dev/prompt-augmentation.md)
("Deliberate full skips"), [chat](../../dev/chat.md) ("Quick send
button" entry point),
[second-thoughts](../../dev/second-thoughts.md) (the sibling caller
of the same skip path).

The refinement turn exercises the same server-side skip with a doubt
probe added; that half is covered by
[chat-second-thoughts](./chat-second-thoughts.md). This case checks
the user-facing button and the nothing-injected contract.

## Preconditions

- Local stack up (`mise run dev-start`), signed in as the dev user
  (`dev@nak.local` / `devpass123`).
- A working Venice key configured for the local stack - both turns
  in this case are live completions.
- A store with recallable content (any populated dev store works).
  The control turn (step 6) must have something to prime FROM;
  a completely empty account primes to empty payloads and weakens
  the contrast.

## Steps

1. Start a NEW conversation. Type a short factual question, e.g.:

   > What can I substitute for buttermilk in pancakes?

   Before sending, hover the lightning-bolt button and read its
   tooltip.

2. Click the lightning bolt (NOT the paper plane). Watch the
   streaming card while the reply forms.

3. After the reply settles, check the bottom-right diagnostics
   pills (Recall and Intuition).

4. Inspect the thread row and the fire log:

   ```sql
   select intuition_payload is null      as intuition_null,
          context_recall_payload is null as recall_null,
          bias_active_at_turn
     from public.threads where id = '<thread-id>';
   select count(*) from public.samskara_fires
    where thread_id = '<thread-id>';
   ```

5. Confirm the turn tail still ran:

   ```sql
   select count(*) from public.samskara_substrate
    where thread_id = '<thread-id>';
   ```

6. **Control.** In the SAME thread, send a follow-up with the normal
   send button (the paper plane). After it settles, re-run the step-4
   thread-row query.

7. **Disabled states.** Clear the composer: both buttons disable.
   Type text and send a normal turn; WHILE it streams, look at the
   pair: send shows the stop square (clickable), the bolt is
   disabled. Hover the disabled bolt and read its tooltip.

## Expected

- (1) The tooltip names the trade: "Quick send - skips preflight
  priming (intuition, recall, samskara) for a faster first token."
- (2) NO pregame / subconscious checklist card appears (no
  `priming_start` events are published on a skipped stage), and no
  recall / intuition / samskara throbber rows render. The reply
  streams normally.
- (3) Recall and Intuition pills read "no data yet" and stay
  disabled - neither pipeline fired.
- (4) `intuition_null` and `recall_null` are both `t`;
  `bias_active_at_turn` is the empty default `{}` (never written);
  `samskara_fires` count is `0`.
- (5) `samskara_substrate` count is `1` - the end-of-turn substrate
  stub is turn-completion bookkeeping, NOT priming, and runs on a
  quick turn by design. Do not read it as a skip leak.
- (6) After the control turn, `intuition_null` and `recall_null` are
  both `f` - the normal path still primes, in the same thread the
  quick turn left un-primed. This pair is the whole proof: skip and
  non-skip diverge only on the priming surfaces.
- (7) Empty composer disables both buttons. While streaming, the
  bolt is disabled with tooltip "Finish or stop the current response
  first" while send is the clickable stop square. The bar layout
  does not shift when send flips shape.

## Cleanup

Delete the test thread (drawer row menu -> delete, or by id). The
priming payload columns live on the thread row and go with it.

## Results log

| Date | Env | Commit | Result | Notes |
| ---- | --- | ------ | ------ | ----- |
| 2026-08-29 | local (`dev-start`, dev@nak.local) | 70f7e57f | Pass | Feature-introduction run, browser-driven (Playwright). Quick turn: no pregame card, pills stayed "no data yet", thread row NULL/NULL, `bias_active_at_turn={}`, 0 samskara_fires, 1 substrate row (expected). Control send in the same thread populated both payloads. Disabled-state pass incl. streaming (bolt disabled, send=stop). Visual pass caught two defects mid-run, fixed in this commit: the composer bar's space-between split the button pair apart (fixed w/ a right-edge wrapper group), and the muted-glyph styling fought the accent fill (switched to the `secondary` outline idiom). |
