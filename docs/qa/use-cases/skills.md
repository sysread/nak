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

## Hone and capture (multi-conversation)

These steps pin the system prompt's sufficiency, verified live
before the feature merged: the model must HONE an existing skill
from a bare preference statement, USE the honed version in a
fresh thread, and CAPTURE the first skill for an untracked
recurring task unprompted (the skills-vs-memories routing rule -
without it the model routed these to `memory_save`).

1. **Hone.** In a NEW thread send only a preference statement,
   with no instruction to update anything: `Quick note: from now
   on my weekly updates drop the Risks section - just Wins, then
   Next Steps.`
2. **Honed re-use.** In another NEW thread: `Draft my weekly
   update from these notes: fixed the login bug; docs rewrite
   starts Monday.`
3. **Proactive capture.** Wipe the skills table first (so no
   index entry can trigger skill-thinking), then in a NEW thread
   send, with no mention of skills or saving: `When I ask you to
   scale a recipe, I always want the ingredient list rescaled per
   serving, never the whole batch, and metric units only.` If no
   skill was captured, send: `Same deal when I ask you to halve
   one.`

Expected:

- (Hone) The model updates the `qa-weekly-report` skill itself
  (`op=save` with the id or by name) and says so in the reply;
  the DB body and description both reflect the two-section
  format.
- (Honed re-use) The reply follows the NEW format - Wins then
  Next Steps, no Risks - matching the DB body.
- (Capture) The model captures a skill via `op=save` (searching
  for an existing match first is fine) and announces it; no
  memory row is created for the preference; `last_author =
  'assistant'`.

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
| 2026-10-30 | local dev stack | 98fd6142 (merged as e20ab151) | PASS (merge gate) | Full-surface verification before merge. UI: 14/14 (panel CRUD, duplicate refusal, top bar + back, deep link, 55-row seed with sidebar AND panel pagination, depth-preserving realtime refresh, hint gating, realtime DELETE collapse, cancel-after-remote-update, search); 0 console errors. LLM: 5/6 - save/announce/realtime, index verified in the wire dump, op=get + format followed, chat search; the HONE phase passed unprompted (the model updated the skill AND corrected its stale description on its own); the CAPTURE phase initially FAILED (a casually-stated preference routed to memory_save - no routing rule existed). Fixed by the skills-vs-memories routing paragraph in SKILLS_BLOCK; the re-test PASSED on the first message with no memory write (the model searched for an existing skill, then captured). Model-trait residuals accepted: one phantom/missing-param fumble per session on write tools (self-corrects in one round); small-model arithmetic slips are model quality, not feature. Hone/capture steps added to this use-case from the verified script. |
