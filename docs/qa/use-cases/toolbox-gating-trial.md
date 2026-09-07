# Toolbox gating trial: writes work with no toggle

## Covers

The `TOOLBOX_GATING = false` trial ([dev: tools](../../dev/tools.md),
"TRIAL: toolbox gating is OFF"): every tool is declared on every
request, `toggle_toolbox` is withdrawn from the wire and the prompt,
the composer toolbox button is hidden, and a write to a previously
gated toolbox runs on the first try. The failure this replaces is the
backend dropping a call to an undeclared tool (see
[chat-cutoff-banner](./chat-cutoff-banner.md) case 8).

## Preconditions

- Local stack up, signed in as the dev user. A thread whose
  `toolboxes_enabled` is empty (any fresh thread).
- Log drawer open on the `stream` and `chat-loop` sources.

## Steps

1. Look at the composer toolbar. Note which pickers are present.
2. Send: "Save a recipe called Test Toast: toast one slice of bread."
3. In the drawer, open the `venice request wire` entry for that turn.
   Count the entries in the request's `tools` array and search the
   system prompt text for `toggle_toolbox` and `(off)`.
4. Send: "Add a follow-up to ask me tomorrow how the toast was."
5. Open Cookbook and Follow-ups.

## Expected

- (1) No toolbox button between the prompts button and the model
  picker. Attach, prompts, model, reasoning, verbosity remain.
- (2) The turn calls `recipe_save` directly: no `toggle_toolbox` call
  precedes it, no "oops, all thinking!" notice, no empty-completion
  warn line in the drawer. The reply confirms the save.
- (3) The `tools` array holds every tool in the catalog (61 today)
  and none of them is `toggle_toolbox`. The system prompt contains
  neither `toggle_toolbox` nor a `(on)`/`(off)` state block, and the
  catalog heading reads "all available every turn".
- (4) `followup_create` runs directly, same as (2).
- (5) Both the recipe and the follow-up exist.

## Cleanup

Delete the Test Toast recipe and the follow-up.

## Results log

| Date | Env | Commit | Result | Notes |
| ---- | --- | ------ | ------ | ----- |
| 2026-09-07 | cloud | (this change) | not run | cloud session has no browser; buildToolList / buildSystemPrompt / state-block shapes are unit-covered under both gating modes (tests/tools.test.ts, tests/system-prompt.test.ts). Wants a local pass, and a prompt_tokens reading from the usage epilogue for the cost question |
