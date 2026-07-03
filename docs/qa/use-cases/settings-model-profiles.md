# Settings: Model profiles pane (CRUD, default invariants, autosave, reorder)

## Covers

The Model profiles settings pane and its persistence
([dev: settings](../../dev/settings.md)): the user-defined profile
list (`profiles.settings.modelProfiles`), the seeded starter profile
for accounts with none, the exactly-one-default and last-profile
invariants, the unique-name validation gating the debounced wholesale
autosave through `persistModelProfiles`, the catalog-driven capability
re-snapshot on a model pick, and the drag-and-drop reorder. The
chat-side consumption of the same array is
[chat-model-profile-selection](./chat-model-profile-selection.md).

## Preconditions

- Local stack up (`mise run dev-start`), signed in as the dev user.
- Start from the seeded state so the single-profile invariants are
  observable. Clear any stored profiles (and legacy tier keys) first:

  ```sql
  update profiles
     set settings = settings - 'modelProfiles' - 'defaultModel'
                    - 'tierModels' - 'defaultReasoningEffort'
                    - 'defaultVerbosity'
   where user_id = (select id from auth.users
                     where email = 'dev@nak.local');
  ```

  Reload the tab after running it so the app re-reads settings.
- The live Venice model catalog must be reachable (the model
  combobox fetches it on first pane visit).

## Steps

1. Open `Settings` from the drawer gear icon. Confirm the nav shows a
   `Model profiles` tab immediately after `AI`, and that the `AI`
   pane itself has no Models section and no default
   reasoning/verbosity selects.
2. Select the `Model profiles` tab. Inspect the single seeded card.
3. Verify the stored blob is still empty (the seed is in-memory
   only):

   ```sql
   select settings->'modelProfiles' from profiles
    where user_id = (select id from auth.users
                      where email = 'dev@nak.local');
   ```

4. On the seeded card, try the `Default` radio and the trash button.
5. Click `+ Add profile`. Rename the new card to `Fast replies`, set
   its reasoning dropdown to `Off thinking` and verbosity to
   `Low verbosity`. Wait ~1s for the footer save indicator to settle
   on the check icon.
6. Re-run the SQL from step 3.
7. Rename `Fast replies` to `Default` (the seeded card's name) and
   pause typing.
8. Rename it back to `Fast replies`, then blank the name entirely.
9. Restore the name to `Fast replies`.
10. On the `Fast replies` card, open the model combobox, type a
    fragment of another model's name (e.g. `qwen`), and pick a
    vision-capable model from the filtered list.
11. On the `Fast replies` card, click the `Default` radio.
12. Drag `Fast replies` by its grip handle and drop it onto the
    `Default` card so it lands first. Wait for the save indicator,
    close Settings, re-open the `Model profiles` tab.
13. Delete the `Default` card (the non-default one now) via its
    trash button.

## Expected

- (1) The tab order reads `... AI, Model profiles, Custom prompts ...`;
  the AI pane's intro copy points at the Model profiles tab and only
  About you / Image generation / toggles remain on it.
- (2) Exactly one card, named `Default`, model `DeepSeek V4 Flash`,
  reasoning `Medium thinking`, verbosity `Low verbosity`, `Default`
  radio checked. The capability strip shows a Reasoning chip and a
  `1M context` pill.
- (3) The query returns null - the seeded profile is synthesized in
  memory, not written to the blob until the first edit.
- (4) Both controls are disabled on a single-profile list: the radio
  is locked on (tooltip "Your only profile is always the default")
  and the trash is disabled (tooltip "The last profile cannot be
  deleted").
- (5) The new card appears named `New profile`, on DeepSeek V4 Flash
  with medium/low defaults, NOT flagged default. Edits autosave with
  the same saving -> check indicator as the Custom prompts pane.
- (6) The blob now holds a two-element `modelProfiles` array; the
  seeded profile materialized with `"id": "default"` and
  `"isDefault": true`, and the new profile carries a UUID id plus its
  capability snapshot fields.
- (7) An inline error appears - `Profile names must be unique -
  "Default" is used more than once.` - and the save indicator does
  NOT reach the check while the duplicate stands (the invalid draft
  is parked, not persisted).
- (8) Blanking the name swaps the error to `Every profile needs a
  name.`
- (9) Restoring a unique name clears the error and the next autosave
  lands (check icon).
- (10) The pick re-snapshots the card: the capability strip updates
  to the new model's chips (a Vision chip appears), context pill, and
  price pill together. The reasoning/verbosity dropdowns keep their
  values.
- (11) The radio moves: `Fast replies` shows checked, the other card
  unchecks in the same click (exactly one default at all times), and
  both cards' radios + trash buttons are now enabled.
- (12) The order `Fast replies, Default` survives the modal
  close/reopen (persisted, not just local). Drag shows the same
  dim/edge-highlight affordances as the prompts pane.
- (13) The card disappears; `Fast replies` remains alone, its radio
  re-locks as the default, and its trash disables again. The blob's
  array is down to one entry with `isDefault: true`.

## Cleanup

- Re-run the Preconditions SQL and reload to drop the test profiles
  and return the dev account to the seeded state.

## Results log

| Date | Env | Commit | Result | Notes |
| ---- | --- | ------ | ------ | ----- |
| 2026-07-03 | hosted | a3e9c93 | pass | Feature-level verification in production by the project owner at merge time; walkthrough steps not yet executed individually. |
