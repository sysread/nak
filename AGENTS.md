# AGENTS.md

Guidance for AI agent sessions working in this repo, whatever the
harness (opencode, Claude Code, Cursor). `CLAUDE.md` carries the full
project guidance - the dev-docs-first rule, commenting style, git
rules, QA use-cases, schema procedure, the local gate - and applies
to every session regardless of harness. Read it first. This file
holds agent-workflow rules that layer on top.

## Plans: commit first, then refine before building

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
