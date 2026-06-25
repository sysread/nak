# Settings: Custom prompts pane (CRUD, autosave, drag reorder)

## Covers

The Custom prompts settings pane and its persistence
([dev: settings](../../dev/settings.md)): the named system-prompt
library (`profiles.settings.systemPrompts`), the debounced wholesale
autosave through `persistSystemPrompts` -> `updateSystemPrompts`, the
drag-and-drop reorder, and the chat composer's prompt toggles that
read the same array order ([dev: chat](../../dev/chat.md)).

## Preconditions

- Local stack up (`mise run dev-start`), signed in as the dev user.
- Settings are reachable from the drawer gear icon.
- Start from a known state: either no custom prompts, or note the
  existing list so the reorder check has a clear before/after.

## Steps

1. Open `Settings` from the drawer gear icon and select the
   `Custom prompts` tab.
2. Confirm the `AI` tab no longer shows a "System prompts" section
   (it now points at the Custom prompts tab in its intro copy).
3. Click `+ Add prompt`. Name it `Alpha`, give it a body
   (e.g. `Be terse.`), and check `Default`.
4. Click `+ Add prompt` again. Name it `Bravo`, give it a distinct
   body. Leave `Default` unchecked.
5. Add a third prompt `Charlie`. Wait ~1s after the last keystroke
   and watch the footer save indicator settle on the check icon.
6. Leave Settings (close the modal), then re-open it on the
   `Custom prompts` tab.
7. Drag `Charlie` by its grip handle (the dotted handle on the left
   of the card) and drop it onto `Alpha` so it lands first.
8. While dragging, observe the card being dragged dims and the
   hovered drop target shows a colored top edge.
9. Wait for the save indicator, leave Settings, and re-open the
   `Custom prompts` tab.
10. Open a new chat and open the composer's system-prompt toggle
    list.
11. Delete `Bravo` from the Custom prompts pane via its trash icon.

## Expected

- (1-2) The `Custom prompts` tab exists in the nav (right after
  `AI`); the `AI` pane has no prompt cards.
- (3-5) Each add/edit autosaves without a Save button; the footer
  indicator transitions to "saving" on edit and to the check on
  completion. `Alpha` shows its `Default` checkbox ticked.
- (6) All three prompts persist across the modal close/reopen in the
  order `Alpha, Bravo, Charlie`.
- (7-8) The drag shows the dragged-card dim state and the drop-target
  edge highlight; on drop the order becomes
  `Charlie, Alpha, Bravo`.
- (9) The reordered order persists across close/reopen (the reorder
  was written to `profiles.settings.systemPrompts`, not just local).
- (10) The composer's prompt toggles list the prompts in the same
  order shown in the pane, with `Alpha` pre-toggled (its `Default`
  flag) for the new conversation.
- (11) Deleting `Bravo` removes its card immediately and the
  deletion persists on reopen.

## Cleanup

- Delete the `Alpha` / `Charlie` test prompts (and `Bravo` if still
  present) so the dev account's prompt library returns to its prior
  state.

## Results log

| Date | Env | Commit | Result | Notes |
| ---- | --- | ------ | ------ | ----- |
