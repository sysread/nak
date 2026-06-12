# Chat: ask_user suspend and resume

## Covers

The `ask_user` tool's full lifecycle: the model calls it, the turn
suspends (`terminalKind: 'suspended_for_ask_user'`), the
AskUserCard renders the question and options (pre-populated from
the in-flight tool_call event via `extractAskUserPrompt` in
`src/lib/ask-user.ts`), and the user's answer resumes the turn
([dev: chat](../../dev/chat.md), [dev: tools](../../dev/tools.md)).

## Preconditions

- Local stack up, signed in as the dev user. No special data -
  ask_user is always-on.

## Steps

1. Send a message that forces the tool, e.g. "Use the ask_user
   tool to ask me whether I prefer cast iron or stainless steel,
   with one option for each."
2. When the card renders, inspect it BEFORE answering: question
   text and option labels/descriptions present.
3. Answer by clicking an option.
4. Let the resumed turn complete.
5. Repeat once answering via free text instead of an option.

## Expected

- (1) The turn suspends instead of completing: the card appears in
  the transcript with the model's question and the two options;
  the composer is still usable. The drawer's `stream` source shows
  the dispatch and an `end terminalKind=suspended_for_ask_user`
  line.
- (2) The card's question/options match what the model asked -
  this is the `extractAskUserPrompt` path (junk options are
  dropped rather than failing the card; free-form answering covers
  the remainder).
- (3-4) The answer resumes the turn; the model's follow-up
  references the chosen option; the persisted tool-result row
  carries the answered content shape (`__ask_user_answered__`,
  `via: 'option'`, the option index).
- (5) Same, with `via: 'free_form'` and the typed answer.

## Cleanup

None.

## Results log

| Date | Env | Commit | Result | Notes |
| ---- | --- | ------ | ------ | ----- |
| 2026-06-10 | local | 31c36d0 | pass (1-4) | post-A8 backfill run: card rendered question + both options w/ descriptions + free-form affordance (extractAskUserPrompt path); option answer resumed the turn; answered row carried `{"__ask_user_answered__":true,"answer":"Cast iron","via":"option","option_index":0}`; follow-up referenced the choice |
| 2026-06-10 | local | 31c36d0 | not run (5) | free-form variant left for a future pass - the via='free_form' shape is unit-covered in ask-user tests |
