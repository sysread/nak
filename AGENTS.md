# AGENTS.md

Guidance for AI agent sessions working in this repo, whatever the
harness (opencode, Claude Code, Cursor). The scope headers below are
load-bearing - apply the section that matches your environment and
skip the rest:

- **All sessions** - applies to every session, everywhere.
- **Local environment only** - applies when working on the user's
  machine, against the local dev stack.
- **Cloud environment only** - applies when working in the GitHub
  cloud env (Claude Code on the web).

`CLAUDE.md` is the Claude-only file. It carries the full project
guidance - the dev-docs-first rule, commenting style, code quality,
QA use-cases, schema procedure, the local gate - plus the detailed
cloud finishing procedure. Claude sessions: read it too. This file
does not duplicate that guidance; it holds what every harness needs.

## All sessions

### Plans: commit first, then refine before building

Non-trivial work - new features, multi-file changes, anything with
real design decisions - follows a plan-first loop:

1. **Draft the plan as a doc** in `docs/dev/plans/<name>-plan.md`
   (the existing plans there set the format). Every factual premise
   carries a `file:line` citation you personally verified. A premise
   you did not check is a guess wearing a citation; verify it or
   mark it unverified. Record resolved scope decisions in the plan
   itself (a Decisions section) so a future session does not
   re-litigate them.

2. **Commit the plan to the feature branch before writing any
   code.** The plan is the reviewable artifact; refinement edits
   the plan, not scattered code.

3. **Refine the plan before implementing.** Dispatch a
   fresh-context reviewer - a read-only subagent with no stake in
   the plan and no memory of writing it - to verify each premise
   against the code and hunt for gaps by severity. Revise from the
   findings, then dispatch a NEW reviewer: never continue the prior
   reviewer's session, and never show it earlier findings - prior
   findings anchor it into inheriting the last reviewer's blind
   spots instead of finding its own. Consensus is a round with no
   blockers and no unaddressed should-fixes; two rounds is the cap,
   and past that the remaining disagreement goes in front of the
   user. When the host has the `thatch-refine` skills, use them:
   they classify the project and run this loop with the right bar
   for the change type.

4. **Instruct every reviewer to walk the user journeys as a
   narrative and check the plan's sections against each other.**
   Trace each user story end to end (who does what, in what order,
   on which surface) and flag places where the flow contradicts
   another section of the plan, where a decision point was missed
   entirely, or where a UI affordance is referenced before the
   milestone that builds it. This is the highest-yield lens: in its
   first run here it caught a blocker contradiction between two of
   the plan's own sections (a column added for filtering that no
   read surface actually filtered), a missing capture trigger (the
   plan specified how to log, never when), and a wrong premise the
   plan inherited from a stale dev doc. Premise-checking alone
   would have missed all three.

5. **Spot-check cited docs against the code.** The reviewer's
   citation proves the reviewer read the doc, not that the doc is
   true. A stale dev-doc claim gets inherited by the plan, then by
   the code, and nothing fails until runtime.

Incorporate the findings, commit the revised plan, and only then
start on milestone one.

### Plan completion workflow

When finishing planned work (work tracked by a plan file in
`docs/dev/in-progress/`), the final milestone before merging is to
update the docs and use cases to reflect what shipped. Load the
`plan-completion` skill and follow it (repo skill at
`.opencode/skills/plan-completion/` - if your harness has no skill
loader, read its SKILL.md and follow it by hand).

The skill covers: graduating the plan doc into permanent `docs/dev/`
docs, updating Interactions ledgers in coupled feature docs, updating
`docs/user/` for observable behavior changes, auditing QA use cases
for drift (verifying code drift is intentional first), adding new use
cases for new behaviors, and retiring the in-progress plan file.

### Notes about the user

The user is an experienced software developer but has not read a
SINGLE LINE OF CODE IN THIS REPO. They began this project to release
their emotional attachment to personal knowledge of the code and
holding the entire machine in their head themselves. They are using
this project to improve their comfort level with AI-coding and to
experiment with ways of improving the usefulness of AI for personal
matters. The user understands code concepts and workflow shapes, but
only has the most vague understanding of the organization and details
of the code base here. When explaining code, plans, or workflows,
assume the user can understand any coding concept, but explain the
code base by analogy and shape (eg "it's an interval worker polling
the db" or "there is a race between the service worker and the
frontend display"), rather than referencing function names, packages,
or files explicitly.

## Local environment only

Everything in this section assumes the local Supabase stack and the
direnv environment on the user's machine. Cloud sessions have no
local stack; skip this section entirely.

### API keys in direnv

The `.envrc` in this repo (git-ignored) contains a Venice API key.
Use it to seed `app_config.venice_api_key` in the local Supabase
stack when testing chat flows that need real completions.

**Never expose key values in the chat window, tool call arguments,
or tool call output.** Extract only what you need with targeted
grep, and do not paste the value into any command or response that
would be visible in the transcript. The habit matters even for local
dev keys.

To seed the local stack:

```sh
grep -oP 'VENICE[_A-Z]*KEY=\K\S+' .envrc | \
  xargs -I {} psql -h 127.0.0.1 -p 54322 -U postgres -d postgres -c \
  "UPDATE app_config SET venice_api_key = '{}';"
```

The `xargs -I {}` substitution keeps the value out of the shell
history and the visible command line. Do not use `echo` or `cat` to
read the key into a variable that would be printed.

### Local Supabase stack

The local stack runs on `127.0.0.1:54321` (API) and `127.0.0.1:54322`
(Postgres). The dev user is `dev@nak.local`. The edge functions serve
on port 54321 with `--no-verify-jwt`.

`mise run dev-start` starts the full stack (Supabase + Vite).
`supabase start` starts just the backend. `supabase functions serve
--no-verify-jwt` starts just the functions (if the backend is already
up).

### Images in conversation: Venice 64px minimum

Venice's image validator (the error is `Supplied image did not pass
validation checks.`) enforces a minimum dimension of 64px on each
side of any image sent to Venice-hosted models (for example
`z-ai-glm-5-3-flash`). Anthropic-hosted models accept the same
images, so this only bites when the session's model is served by
Venice.

The common trigger is a Playwright element screenshot of a thin UI
strip (such as a toolbar 60px tall). The image is fine at read time,
but once it is in the conversation every subsequent Venice call
fails with Bad Request, and it keeps failing on every turn because
the image stays in context. The conversation is effectively poisoned
until the model is switched.

Rules when doing browser QA on a Venice model:

- Prefer viewport screenshots over element clips.
- If a thin strip is needed, pad the short side to 64px or more
  before reading it. Prefer a transparent border on PNG (keeps
  content pixels and aspect ratio intact) over resizing, which
  distorts. If the image may get flattened to JPEG (which has no
  alpha), pad with the UI's background color instead.
- If the error appears mid-conversation, do not retry the same turn
  expecting a different result. Either pad and re-read the image, or
  switch models to clear the poisoned context.

Verified 2026-08-29: 1416x62 fails, 1416x63 fails, 1416x64 passes.
The exact bytes were replayed with curl, so this is a server-side
validator rule, not an opencode or tool-chain bug.

## Cloud environment only

The cloud env is Claude Code on the web, working directly in the
GitHub repo. The full operating procedure lives in `CLAUDE.md`
("Default finishing procedure per environment" and "Verifying UI
changes"). The short form, for any harness that finds itself there:

- Work on a feature branch. Default end-of-task: commit on the
  branch, push, stop. Merge only on explicit go-ahead, and "merge to
  main" always means merge the PR (GitHub MCP tools; no `gh` CLI in
  that environment).
- After a merge, watch CI through to green (Tests, then the Deploy
  chain off it) before calling the merge done.
- There is no browser and no visible dev server. Run `mise run
  check`, reason carefully about the UI layer, and explicitly flag
  in the summary what was not verified.
