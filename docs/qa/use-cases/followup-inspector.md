# Follow-up inspector: the always-present pill and the shared modal

## Covers

The read-only surfacing of follow-ups
([dev: followups](../../dev/followups.md)): the always-present
seedling pill (`src/lib/ui/diagnostic-pills.ts` - presence no
longer gated on `app.intentsEnabled`; only the copy switches), the
follow-ups section of the shared inspector modal
(`Intents.svelte`, route `modal: 'intents'`) fed by
`listFollowups()`, and the grouping / status-chip / title
primitives in `src/lib/ui/followups-inspector.ts`. Proves a user
who never enabled intents can still see what Nak is waiting to
hear about, and that the epistemic states read honestly ("ready
to ask" vs "asking after <date>" vs "when it comes up").

The intents half of the shared modal is covered by
[intent-inspector](./intent-inspector.md).

## Preconditions

- Local stack up (`mise run dev-start`), signed in as the dev
  user. `$UID` is the signed-in user.
- Intents OFF (the default; this case exercises the intents-off
  shape):

  ```sql
  update profiles set settings = settings - 'intentsEnabled'
   where user_id = '$UID';
  ```

- A representative spread of follow-ups, forged directly:

  ```sql
  insert into followups (user_id, question, context, status, relevant_after, resolution)
  values
    ('$UID', 'Ask how the lasagna turned out', 'Planned a ricotta lasagna for Saturday', 'open', now() - interval '1 day', null),
    ('$UID', 'Ask about the half-marathon',    'Race is next month',                     'open', now() + interval '20 days', null),
    ('$UID', 'Ask how the manager talk went',  'Scope-change conversation, no date',     'open', null, null),
    ('$UID', 'Ask how the interview went',     '',                                       'answered', now() - interval '10 days', 'Got the offer; negotiating start date'),
    ('$UID', 'Ask about the diet experiment',  '',                                       'dismissed', null, null);
  ```

## Steps

1. **Pill present with intents off.** Reload the chat view; hover
   the seedling pill at the bottom of the bottom-right column.
2. **Open the inspector.** Click the pill.
3. **Read the groups and chips.** Confirm the sections and each
   open card's status chip.
4. **Empty state.** Delete the forged rows
   (`delete from followups where user_id = '$UID';`), reopen the
   inspector.

## Expected

- (1) The seedling pill renders despite intents being off; tooltip
  reads "View follow-ups - questions Nak saved to ask you later".
  On mobile (<=720px) the column is hidden and the pill lives only
  as the diagnostics-menu tile, same rule as every pill.
- (2) The modal opens titled "Follow-ups" (no "Working intentions"
  in the title, no intentions section anywhere) with the read-only
  blurb. There are NO edit/close/dismiss controls - lifecycle is
  conversation-only.
- (3) Headline reads "Nak is waiting to hear about 3 things".
  Three groups render:
  - **Waiting to ask**: the lasagna card chip reads "ready to ask"
    (date passed); the half-marathon chip reads "asking after
    <short date ~20 days out>"; the manager-talk chip reads "when
    it comes up" (undated). Question bold, seeding context italic.
  - **Answered**: the interview card, dimmed, with "Outcome: Got
    the offer; negotiating start date".
  - **Let go**: the diet card, dimmed, no outcome line.
- (4) With no rows, the follow-ups section shows its empty copy
  ("No follow-ups yet..."), not an error or a blank panel.

## Cleanup

```sql
delete from followups where user_id = '$UID';
```

## Results log

| Date | Env | Commit | Result | Notes |
| ---- | --- | ------ | ------ | ----- |
| - | - | - | - | Authored with the inspector; first execution pending a live stack + browser. Grouping/chip/title logic is unit-covered in `tests/followups-inspector.test.ts`; this case proves the render, the always-present pill, and the intents-off modal shape, which units cannot reach. |
