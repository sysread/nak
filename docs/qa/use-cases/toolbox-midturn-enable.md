# Toolbox gating: mid-turn enable arms the write tools in the same turn

> Backfilled alongside the mid-turn rearm fix. The pre-fix baseline
> is the production incident this case reproduces (thread "Baking
> Mishap with Joy's Loaf", 2026-08-01): eight `followup_list` calls
> whose activity text said "Creating a follow-up...", after two
> successful toggles. Not yet executed against the fixed code - run
> it and start the results log.

## Covers

The toggle-then-write flow inside a single assistant turn
([dev: tools](../../dev/tools.md), "Enablement is request-shape
only" gotcha; [dev: chat](../../dev/chat.md), the `toggle_toolbox`
gotcha):

- **Mid-turn rearm** - when the model calls `toggle_toolbox` and
  then a write tool in the SAME turn, the orchestrator rebuilds the
  wire `tools` array from the envelope's `toolCatalog`
  (`supabase/functions/venice/tool_catalog.ts`), so the write is
  declared to the model on the very next round.
- **Cross-model robustness** - the flow must not depend on the
  serving backend accepting calls to undeclared tools. A strict
  backend is the case that exposed the gap.

## Preconditions

- Local stack up (`mise run dev-start`), signed in as the dev user
  (`dev@nak.local` / `devpass123`).
- A fresh thread with EVERY gated toolbox off (composer toolbox
  popover shows none enabled) - the point is to force the model
  through the toggle.
- Logs drawer open at Info, source filter on `stream` - the rearm
  logs a line per rebuild.
- If reproducing the original incident shape, pick a model known to
  hold to the declared tool list (the incident model was
  `deepseek-v4-flash-0731`); any model exercises the rearm path
  itself.

## Steps

1. Send a message that makes a follow-up save the obvious next
   move, e.g.: "I'm baking a loaf for a friend tomorrow - remind me
   later to tell you how it went."
2. Watch the tool-call cards on the assistant turn as they land.
3. In the Logs drawer (source `stream`), find the round lines for
   this turn.
4. Check the row landed:

   ```sql
   select question, status, relevant_after
     from public.followups
    where user_id = (select id from auth.users
                      where email = 'dev@nak.local')
    order by created_at desc limit 3;
   ```

5. Repeat the shape with a different gated box in the same style,
   e.g. "Save this recipe: ..." with `cooking` off, and confirm the
   same single-turn toggle-then-write pattern.

## Expected

- Step 2: the turn shows a `toggle_toolbox` call (activity names
  the enable) followed IN THE SAME TURN by a `followup_create`
  call - not `followup_list` repurposed with a "creating" activity
  line, and not a stall. A preliminary `followup_list` dedup check
  before the create is fine.
- Step 3: after the round with the successful toggle, a
  `rearmed tools for [followups]` line with a def count larger
  than the turn's opening `toolsLen`.
- Step 4: exactly one new open follow-up row for the loaf.
- Step 5: same shape for the other box (`toggle_toolbox` ->
  `recipe_save`, one new recipe row).

## Cleanup

```sql
delete from public.followups
 where user_id = (select id from auth.users
                   where email = 'dev@nak.local');
```

Delete any test recipe from the Cookbook screen, and the test
threads from the drawer.

## Results log

| Date | Env | Commit | Result | Notes |
|---|---|---|---|---|
| - | - | - | - | Fix landed with this case; no runs yet. |
