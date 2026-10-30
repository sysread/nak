# Skills: panel CRUD, chat-driven writes, and the per-turn index

## Covers

The Skills drawer tab, the `skills` combination tool, the realtime
relay that delivers a model-written skill to an open panel, and
the per-turn skills index section in the metadata message
([dev: skills](../../dev/skills.md);
[dev: tools](../../dev/tools.md), "The write toolboxes";
[dev: prompt augmentation](../../dev/prompt-augmentation.md), the
metadata block's section contract). Neither the Chat.svelte
drawer wiring nor the loop.ts index fetch has automated coverage,
so this case is their only regression net.

## Preconditions

- Local stack up (`mise run dev-start`), signed in as the dev user.
- A Venice key seeded in `app_config` (the chat-driven steps call
  Venice).
- No pre-existing skills required: step 1 creates the one the
  duplicate-name check needs. Execute the steps in order.

## Steps

1. **Panel create.** Open the `Skills` tab, click `New skill`, and
   fill the form: name `qa-release-notes`, description
   `How I draft release notes; use for any release-notes ask.`,
   and a Markdown body that opens with a `## Format` heading and
   ends with an instruction to always close with a `## Changelog`
   section. Click `Create`.
2. Confirm the row and who wrote it:

   ```sql
   select name, last_author from skills
    where name = 'qa-release-notes';
   ```

3. **Panel edit.** With the skill open, confirm the body renders
   as Markdown (the heading renders, no literal `##`). Click
   `Edit`, confirm the live char counters beside the name,
   description, and body fields, change the description, and
   click `Save`.
4. **Sidebar search.** Type `release` into the sidebar search box;
   then clear it.
5. **Deep link.** Copy the browser URL with the skill open (it
   reads `?drawer=skills&skill=<id>`), open a new tab, and paste
   it.
6. **Duplicate-name refusal.** Click `New skill` (on the list
   surface - the top-bar `All skills` action clears an open detail
   to get there), enter the name `QA-RELEASE-NOTES` (differs from
   step 1's skill only in case) with any description and body,
   click `Create`, read the status line, then `Cancel`.
7. **Chat-driven save.** With the Skills tab open (the sidebar
   visible), send in a chat thread:
   `Save a skill called qa-weekly-report: it's how I write my
   weekly status report - a bullet list of project updates, then
   risks, then next steps.` Watch the reply, then the Skills tab.
8. Confirm the model-written row:

   ```sql
   select name, last_author from skills
    where name = 'qa-weekly-report';
   ```

9. **Matching task (index + get).** In a NEW thread, send: `Draft
   my weekly status report from these notes: launcher v2 shipped;
   the flaky scheduler test still fails; next week is the pricing
   change.`. Use a fresh thread, not the one from step 7: a fresh
   context means the saved body is not already in the transcript,
   which is what makes the model fetch it. Open the Logs drawer
   (top-bar document glyph), set Minimum level to `Debug+`, filter
   the source tag to `chat-loop`, and find this turn's
   `venice request wire` dump.
10. **Chat search.** Send: `Search my skills for anything about
    reports.`
11. **Panel delete.** Back on the Skills tab, open each QA skill
    (`qa-release-notes`, `qa-weekly-report`), click `Delete`, and
    confirm the strip.

## Expected

- (1) The form closes and the new skill's detail opens: name,
  description, the body rendered as Markdown, and a
  `Last edited by you` stamp. The sidebar shows the row in
  alphabetical position.
- (2) One row, `name = 'qa-release-notes'`,
  `last_author = 'user'`.
- (3) The edit form shows the three live counters (caps 64 / 300
  / 32000); `Save` returns to the rendered detail with the new
  description, and the sidebar row updates without a refetch.
- (4) A non-empty query filters the sidebar to text matches over
  name / description / body; clearing the box returns the full
  alphabetical browse list.
- (5) The pasted URL lands on the Skills tab with that skill's
  detail open (the `skill` param only renders inside
  `?drawer=skills`, never bare).
- (6) Save is refused with the named duplicate status ("A skill
  with that name already exists. Names match case-insensitively.
  "); the form stays open; no second row lands.
- (7) The tool-call panel shows a `skills` call with `op=save`;
  the reply announces the save; the new row appears in the open
  Skills sidebar WITHOUT a manual refresh (the realtime relay);
  opening it shows `Last edited by Nak`.
- (8) One row, `last_author = 'assistant'`.
- (9) HARD: the `venice request wire` dump for this turn - the
  first user message after the save - contains the skills index
  section listing `qa-weekly-report` (the index is built once per
  turn, so a mid-turn save lands on the following turn).
- (9) Expected in a fresh thread, but skippable: the tool-call
  panel shows a `skills` call with `op=get` (by name or id)
  before the answer - legitimately skipped when the body is
  already in context.
- (9) The drafted report follows the saved body's guidance:
  project updates, then risks, then next steps.
- (10) A `skills` call with `op=search` and the reports query.
- (11) `Delete` shows the inline confirm strip ("Really delete
  ...? This cannot be undone."); confirming removes the row from
  the sidebar, clears the `skill` URL param, and lands back on
  the list surface.

## Cleanup

- Delete any leftover QA skills:

  ```sql
  delete from skills
   where name in ('qa-release-notes', 'QA-RELEASE-NOTES',
                  'qa-weekly-report');
  ```

- Remove the QA chat thread.

## Results log

| Date | Env | Commit | Result | Notes |
| ---- | --- | ------ | ------ | ----- |
| 2026-10-29 | local dev stack | a70faf94 | PARTIAL PASS | 10/11 steps pass, 0 console errors, table + threads cleaned. Step 9 PARTIAL: skills index verified in the wire dump; op=get legitimately skipped in-thread (body already in context) - a fresh-thread probe verified the index -> get -> follow-body path end to end; use-case reworded (fresh thread, supplied notes, op=get demoted to expected-not-required). Findings fixed after the run: the skills tab fell through to the Library top bar (wrong title + upload button) and skill detail had no back-to-list affordance (step 6 needed a URL workaround) - both fixed by the skills top-bar branch. Log-drawer instructions corrected (Debug+ level, chat-loop source). Realtime relay verified (model save appeared in the parked panel with no refresh); latency not measured. |
| 2026-10-29 | local dev stack | 95cb853d | PASS (targeted re-check) | The two fixed surfaces re-verified: top bar reads Skills with no Upload-document button while a detail is open; the All-skills action clears the skill param and lands on the browse list; create/delete round trip clean; 0 console errors; skills table 0 rows after cleanup. Non-blocking notes: All-skills renders on the list surface too (documented no-op, the Library upload button's shape); the action carries the new-thread-mini sizing class like its Library sibling. |
