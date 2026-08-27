# Chat: model-profile selection and per-thread resolution

## Covers

The chat-side consumption of model profiles
([dev: chat](../../dev/chat.md)): the composer's profile picker
pinning a profile id to `threads.model` (null = track the default),
the send-path resolution of model id + reasoning + verbosity through
the profile (`resolveModelProfile` / `thinkingWireForProfile`), the
reasoning/verbosity pickers badging the profile's defaults (including
an Off reasoning default), the fallback that maps deleted-profile
and legacy tier-name pins to the default profile, and the server-side
strict-validation fallback that keeps a mid-conversation switch to a
model whose backend rejects optional wire knobs from erroring the
turn. Verified rejection facts (probed live 2026-08-27): GLM 5.2
rejected `text.verbosity` (recorded in `model_feature_rejections`);
GLM 5.3 and 5.3 Flash both ACCEPT it. GLM 5.3 non-flash instead
rejects `venice_parameters.disable_thinking` ("Reasoning is
mandatory") - a different error shape the strip-and-retry fallback
does NOT catch, so an Off-thinking pick on that model hard-fails the
turn rather than degrading. Authoring the profiles
themselves is
[settings-model-profiles](./settings-model-profiles.md).

## Preconditions

- Local stack up (`mise run dev-start`), signed in as the dev user.
- Two profiles configured in Settings -> Model profiles (see the
  sibling case for the mechanics):
  - `Everyday` - DeepSeek V4 Flash, `Medium thinking`,
    `Low verbosity`, flagged **Default**.
  - `Fast replies` - DeepSeek V4 Flash, `Off thinking`,
    `High verbosity`, not default.
- Logs drawer available (document-glyph button, top bar) with its
  level filter set to `debug` - the wire check reads the
  `chat-loop` source's `venice request wire` line.

## Steps

1. Open a fresh conversation (no thread selected). In the composer
   bar, hover the CPU-icon picker button and note its tooltip, then
   click it.
2. Pick `Fast replies` from the menu, then check the thread list.
3. Open the reasoning (lightbulb) and verbosity (speech-balloon)
   pickers without changing anything.
4. Send a short message (e.g. `say hi`). After the reply lands, find
   the `venice request wire` line in the Logs drawer (source
   `chat-loop`, level debug) and inspect the thread row:

   ```sql
   select model, reasoning_effort, verbosity from threads
    order by updated_at desc limit 1;
   ```

5. From the reasoning picker, choose `Medium`. Send another message
   and re-check the wire line and the SQL from step 4.
6. From the profile picker, choose `Everyday` (the default), then
   re-run the SQL from step 4.
7. Expand an assistant reply's context ring (the usage indicator in
   the message action bar).
8. In Settings -> Model profiles, delete `Fast replies`. Back in
   chat, pin a NEW conversation to a legacy tier name to simulate a
   pre-profile row:

   ```sql
   update threads set model = 'balanced'
    where id = '<thread id from step 4>';
   ```

   Reload the tab and open that conversation.

9. Create a third profile pointed at a GLM 5.x model from the live
   catalog (e.g. `zai-org-glm-5-2`; any model whose backend rejects
   the `text.verbosity` knob works). In a conversation with a few
   deepseek turns already in it, switch the profile picker to the
   GLM profile and send another message.

## Expected

- (1) The picker renders even with no active thread; the tooltip
  reads `Model profile: Everyday (deepseek-v4-flash)`. The menu is
  headed `Model profile for this conversation`, lists `Everyday`
  then `Fast replies` (Settings order), shows each profile's model
  id as a subtitle, and badges `Everyday` with `default`.
- (2) Picking on a fresh session auto-creates a draft (a new thread
  appears in the drawer) and the menu now marks `Fast replies`
  selected.
- (3) The reasoning picker shows `Off` selected with the `default`
  badge on the Off row (the profile's Off default is a badgeable
  position, not a hidden state); the verbosity picker shows `High`
  selected and badged.
- (4) The wire line reports `model: deepseek-v4-flash`. The thread
  row has `model` = the `Fast replies` profile UUID (not a tier
  name), `reasoning_effort` null, `verbosity` null - profile
  defaults ride resolution, not the row.
- (5) The reply now streams a visible reasoning panel (thinking was
  off before, so this is the observable flip) and the row has
  `reasoning_effort = 'medium'` - an explicit override pins, while
  the untouched verbosity stays null.
- (6) Re-selecting the default profile CLEARS the pin:
  `threads.model` is null, so the thread tracks future default
  changes. The composer button tooltip flips back to `Everyday`.
- (7) The ring's detail measures the turn against the current
  profile's context window (1M for the DeepSeek profiles - shown as
  the denominator/summary), not against any historical value.
- (8) Both orphan shapes resolve to the default profile: the
  conversation opens with the picker showing `Everyday`, sends keep
  working, and no error surfaces. (`'balanced'` stays in the column
  until the user re-picks - resolution, not migration, handles it.)
- (9) The turn completes normally - no
  `Venice HTTP 400: Extra inputs are not permitted, field: 'text'`
  error surfaces. On the FIRST-EVER turn against this model the edge
  function's log shows one
  `[withRateLimitRetry] model backend rejected optional field 'text'`
  line (the strip-and-retry) and the discovery is recorded:

  ```sql
  select * from model_feature_rejections;
  -- expect a (<glm model id>, 'text') row
  ```

  Later turns on the same model show no strip line - the orchestrator
  strips the field preemptively from the recorded rejection. After a
  settings refresh (reload the tab), the verbosity controls for the
  GLM model render disabled with the tooltip "This model doesn't
  support the verbosity setting": the GLM profile's dropdown in
  Settings -> Model profiles, and the composer's speech-balloon
  picker on a conversation using the GLM profile. Both stay enabled
  for the deepseek profiles.

## Cleanup

- Delete the test conversations from the drawer.
- Remove the test profiles per the sibling case's cleanup SQL if the
  dev account should return to the seeded state.
- `delete from model_feature_rejections;` so the next run of step 9
  exercises the discovery path again (the table is global and
  persists across runs).

## Results log

| Date | Env | Commit | Result | Notes |
| ---- | --- | ------ | ------ | ----- |
| 2026-07-03 | hosted | a3e9c93 | pass | Feature-level verification in production by the project owner at merge time; walkthrough steps not yet executed individually. |
