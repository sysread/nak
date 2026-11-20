# Clarity judge + auto-rewrite (B8)

## Covers

The three-layer clarity feature ([dev: clarity](../../dev/clarity.md),
plan: [the clarity-judge plan](../../dev/plans/clarity-judge-plan.md)):
the settings-gated baseline block (chat + wiki prompts), the
two-question decision call after the terminal round
(`primarily-text` noul + `clarity` score, `clef-api`), the
deterministic mechanical scan, and the auto-rewrite (a NEW assistant
message below the original - the original is never hidden or edited;
a `clarity` jsonb chip on the original carries the notice, delivered
by the messages UPDATE echo). The rewrite's commit reassigns
`assistantRowId`/`persistedId`, so the second-thoughts tail judges
the rewrite with zero sequencing code.

## Preconditions

- Local stack up (`mise run dev-start`), Venice key in `app_config`,
  Logs drawer at `Trace+` (the judge's usage/pair lines ride debug).
- `clearWritingEnabled = true` for the dev profile:
  `update profiles set settings = jsonb_set(settings, '{clearWritingEnabled}', 'true') where user_id = '$UID';`
- `$SR` = the legacy-JWT service-role key from `supabase status -o json`.

## Steps

1. Send a prompt that yields a clean prose answer ("what time is
   it?"). Watch the drawer: one clarity judge call
   (`clarity: text=... score=...` at debug), no chip, the turn ends
   on the original.
2. Bait a hedge-heavy, sycophantic reply ("just briefly remind me -
   I think I asked this before - what does the followups setting
   do? If it's too much detail, whatever"). Watch the live turn.
3. Send a code-only request ("a bash one-liner that strips windows
   returns"). Watch the `primarily-text` answer.
4. Toggle the setting OFF, repeat step 1's prompt.
5. Force a judge failure: delete the Venice key from `app_config`,
   send a prompt, restore the key.

## Expected

- (1) The judge's debug line shows `text=` (high) and a score at or
  above 1.5; NO chip lands; END names the original's row;
  second-thoughts fires on it as always.
- (2) The chip lands on the ORIGINAL message (UPDATE echo; the
  notice renders between the original and the live rewrite), the
  rewrite streams as a SECOND assistant message below, END names the
  rewrite's row, second-thoughts fires on the rewrite, the next
  turn's model sees the clarity connective between the two answers.
  The original is untouched - both messages stay readable.
- (3) `text=` reads low; no rewrite regardless of the prose score.
- (4) No clarity judge call at all; today's pre-B8 behavior;
  second-thoughts unchanged.
- (5) The fail-open info line (`clarity stage failed (fail-open)`)
  in the drawer; the turn ends on the original.

## Cleanup

The QA turns' messages are real feature output and stay (the
analysis-writes-stay policy). Delete the test threads from the drawer
if the transcript matters.

## Results log

| Date | Env | Commit | Result | Notes |
| ---- | --- | ------ | ------ | ----- |
