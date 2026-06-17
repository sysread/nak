# CLAUDE.md

Guidance for Claude Code / Claude sessions working in this repo. See
`README.md` for the project-level overview, `docs/user/README.md` for
the end-user manual (also rendered in-app via the **Help** button),
and `docs/dev/README.md` for architecture + per-feature dev notes.

## Start with the dev docs

`docs/dev/` is the architecture-and-conventions tree: one overview
plus one doc per feature, each with a "Gotchas" section and an
"Interactions" ledger naming the other features it couples to.
[`docs/dev/README.md`](docs/dev/README.md) is the index;
[`docs/dev/architecture.md`](docs/dev/architecture.md) is the one to
read first.

**Read the relevant dev doc before non-trivial work** - and the docs
of the features its "Interactions" section names. Changing a contract
other features depend on without reading their Interactions ledger is
how coupling breaks silently.

**When the codebase surprises or confuses you, check the dev docs
before guessing.** A line that looks removable, a constraint that
seems arbitrary, a flow that doesn't match what you expected - the
"Gotchas" section or Interactions ledger usually explains why.

If a dev doc is wrong, stale, or missing the thing that would have
saved you, fix it in the same PR. A stale dev doc misleads the next
session with full confidence - worse than no doc at all.

### `docs/dev/in-progress/` is for *open* work only

`docs/dev/in-progress/` holds plans and milestone trackers for work
that is actively underway. It is not an archive. When a milestone
ships, **graduate and retire its doc in the same PR that closes it**:

1. **Graduate** the durable content - the "how it works now" end state,
   the load-bearing design rationale - into the permanent feature docs
   (`architecture.md`, the per-feature doc) if it isn't already there.
   The in-progress doc is a migration *narrative*; the permanent docs
   own current reality.
2. **Retire** the in-progress doc: delete it. Git preserves the
   narrative; a finished plan left in `in-progress/` reads as open work
   and is exactly the "ambiguous ownership / migration residue" debt
   these docs are supposed to prevent.
3. **Fix inbound links** (grep `in-progress/` across `docs/`) so nothing
   dangles - usually point them at the permanent doc that now owns the
   end state.

The test: if someone opens `in-progress/` and can't tell what is still
unfinished, the folder has rotted. Keep it honest as the work lands,
not in a later cleanup sweep.

## Talking to the user

Hard constraints, not style preferences. (Personality and prose
calibration live in engram's global store; this section is the
project-specific deltas.)

**Correctness over comfort.** No reassurance, validation, softening,
or emotional framing. Lead with the answer. "That's wrong because X,"
not "one consideration is X." "I don't know" or "50/50" rather than
hedged framing. Skip the "want me to..." preamble when the action is
obvious - just do it or state it.

**Push back when justified.** If the user dictates an approach,
evaluate against (1) the problem and constraints, (2) the codebase
and conventions (this file plus `docs/dev/`), (3) the principles
here. If it fails any check, explain the problems directly, itemize
cleaner alternatives, and make the last alternative *"Do it anyway
(but the bot washes its hands of it)."* If the user insists, respond
*"We are but soldiers. Ours is not to reason why, but to do and die.
😇"* and proceed.

**Identify implications proactively.** A literal reading of a
request can have non-obvious downstream effects - "gate this on X"
often gates more than the user had in mind because the same code
path is reused elsewhere. Look at every caller before editing, name
what would silently break, and itemize alternatives. Catching the
implication after the edit is a regression they have to debug;
catching it before is free.

**Challenge implicit assumptions when they don't match what you
know.** A request's framing carries premises ("fix the bug where X
happens," "this used to work"). If the premise contradicts the
visible codebase, recent commits, or this session's history, name
the mismatch BEFORE answering. Don't silently translate the request
into one where the false premise holds - that produces a confidently
wrong answer the user then has to unwind.

**Ask rather than hallucinate intent.** When the request is
ambiguous and the cost of being wrong is non-trivial, ask before
guessing.

**One open question per round.** Don't dump multiple decisions into
one message. Pick one, present it with enough context, wait. When
more than one is pending, end with a `[n/X] points to resolve`
tracker. The second/third question often turns out to be downstream
of the first answer, making batching actively wasteful.

## Keep the user informed while working

The web UI for Claude Code reads silence as "hung." Emit short text
updates aggressively:

- **Before every slow call** - one sentence stating intent BEFORE
  the tool call submits, so the user sees it while the spinner ticks.
- **Between steps** in multi-step git work. "Rebased cleanly, now
  re-running the gate" costs nothing and prevents the "is it stuck?"
  check-in.
- **On an unexpected detour** - call it out immediately rather than
  silently working around it. "Hitting X, trying Y."
- **At the end of a long op** - at least one sentence after a slow
  tool returns, even if the next step is another slow tool.

One sentence per update is almost always enough. The rule: the user
should be able to tell from your text output alone whether you're
working, waiting, or done.

## Commenting style

Nak is small and dense. Many files encode non-obvious decisions -
browser-API quirks, security tradeoffs, bugfixes that look removable
but aren't. **When you change code, the surrounding comments are
often the only record of why it's that way.**

Default to writing a comment when you add non-trivial logic.

### What deserves a comment

- **Why, not what.** Names tell the reader *what*; the comment
  explains *why this approach*.
- **A constraint that forced the design.** Browser-API quirks
  (EventSource can't POST with headers; canvas-based glyph detection
  needs a PUA fallback). Security tradeoffs (PBKDF2-SHA256 not
  Argon2; read-then-write safe for single-user settings). Protocol
  details (OpenAI SSE framing; Unicode emoji-presentation selectors).
- **Bugfixes.** Name the symptom. "This check prevents the draft
  from materializing twice when the user hits Enter before the first
  insert resolves" costs two lines today and prevents a regression
  six months from now when someone reads the fix and thinks "this
  guard looks extraneous."
- **Invariants and contracts.** "Must run before X"; "caller owns
  cleanup"; "safe to call repeatedly"; "no-op when not signed in".
- **Intentional silence.** An empty `catch {}` should say *why*
  silence is correct.
- **Magic numbers from a standard.** Cite the source (OWASP, NIST,
  RFC number, WCAG level).

### Voice

Complete sentences. Name symptoms by their observable behavior, not
internal jargon. ASCII only - no smart quotes, smart apostrophes, or
em-dashes. Single hyphen with spaces (` - `) for parenthetical
asides. (The codebase has em-dashes scattered through earlier
comments; leave them alone unless you're touching the surrounding
code. A wholesale cleanup is a separate task.)

Good: `// U+FE0F forces emoji-style presentation - without it,
U+2696 SCALES renders as a thin text glyph that reads as
near-invisible against the toggle background.`

Bad: `// set variation selector`, `/* Mobile styles */`.

### Where to put them

- **File-level preambles** on any module whose role isn't obvious
  from its name. Say what this module owns and name the adjacent
  modules it interacts with.
- **Block comments above non-obvious branches.** Not `// loop over
  items`, but `// Preserve drafts across a refetch - they only
  exist in memory until the user sends.`
- **Trailing line comments** for single-line clarifications of a
  constant.

### What NOT to comment

- Obvious plumbing (imports, state declarations).
- Pure reformatting or rename-only changes.
- Things a well-named identifier already makes plain.
- Already-commented code - if you learned something new, *update*
  the existing comment, don't add a parallel one.

### Describe current reality, not change history

Comments encode current behavior and the constraints it serves, not
the change that produced them. Git logs the history; comments
narrate the file as it stands. Phrases that mark this drift: "the
earlier version," "originally," "we used to," "switched to," "now
we," "this commit," "this fix." If you catch one, rewrite the
comment as if you'd never seen the prior shape.

The exception: comments that describe current code behavior in
response to *legacy state* are not change-history. "Older rows in
the DB may still carry the v1 shape, so we coerce here before
reading" is about the present (a current invariant against a legacy
condition), not a refactor narrative.

### TODO and FIXME comments

A TODO describes the *problem* to solve, not the solution to apply.
The future implementer has context the present caller doesn't;
prescribing the fix cements an implementation choice and bleeds
upstream assumptions into work that hasn't been thought through.

Good: `// TODO: the recall fan-out result list grows unbounded
across long sessions; want a windowing strategy before this becomes
a memory pressure issue.`

Bad: `// TODO: cap the recall fan-out result list at 50 entries.`

### Self-review checklist

Before handing work back:

- [ ] Every bugfix names its failure mode.
- [ ] Every empty `catch {}` explains the swallowed error.
- [ ] Every browser-API quirk cites the quirk by observable behavior.
- [ ] Every spec-derived constant cites the spec.
- [ ] No stale comments pointing at removed code.
- [ ] No past-tense narration of code evolution.
- [ ] Every TODO/FIXME describes the problem, not the prescribed fix.

### False positives are a documentation signal

A false positive in code review (LLM or human) is not noise - it's
evidence the code is missing inline documentation that would have
prevented the wrong read. The fix is never to dismiss it; it's to
add the comment that makes the false positive impossible next time.

Apply this proactively. Common offenders:

- Cross-language semantics where defaults diverge. Postgres unary
  `log()` is base-10 (`ln()` is natural); JS `Math.log` is natural.
  `5.0 * log(n + 10)` gets cross-flagged unless a comment names
  the base.
- Functions whose behavior is the inverse of the obvious naming
  (e.g. a "claim" RPC returning `false` on success).
- Conventions chosen against the local sibling pattern - the
  divergence itself needs justification.
- Magic constants from a spec - cite the source.

## Capturing conventions

If you learn something the next session would waste time
rediscovering - a workflow that differs from "the usual," a
non-obvious constraint, a load-bearing invariant - write it down:

- **Single-file scope:** comment next to the code.
- **Multi-file or repo-wide scope:** add it here under a named
  section.
- **Both:** short pointer in the file ("see CLAUDE.md § Supabase
  schema changes") plus the full explanation here.

When the underlying behavior changes, update the note in the same
PR. If the user corrects you on a project convention, that's a
strong signal it isn't documented yet - add it before closing.

## Code quality and organization

**Separation of concerns is the prime directive.** Special cases
stay off the API. A function whose behavior changes drastically
based on a parameter is two functions. Make the right thing the
easiest thing.

**Simple over over-engineered.** Don't add features, refactor, or
introduce abstractions beyond what the task requires. A bug fix
doesn't need surrounding cleanup. Three similar lines beat a
premature abstraction. No "in case we need it later" config knobs.

**Trust internal code and framework guarantees.** Validate only at
system boundaries (user input, external APIs, the Venice wire
shape). No backwards-compat shims or feature flags when you can
change the code directly.

**Wire up the desired state first, then collapse.** Software
changes work like tetris: stack them up, then collapse when density
is high. Don't polish incomplete work; finish wire-up first, then
delete artifacts.

**Prefer named functions over inline procedural code.** Function
signatures tell the story; the main block shows the flow.

**Flag newly-unused code for deletion.** When you remove a call,
check whether the target is now unused. Say so in the PR description
even if you're not touching it.

**When you move code, clean up its accommodations.** A relocated
element usually had scaffolding around it - CSS clearance for an
absolutely-positioned button now in a flex row, a z-index against an
overlay that no longer exists, a wrapper whose only job was catching
an event that now fires elsewhere, a parent `position: relative`
that anchored the moved child. Scan the old neighborhood and delete
what the prior form was load-bearing for. A move is done when the
old site no longer leaves a shadow.

**Non-conforming code requires a comment.** The reader has to be
able to tell a deliberate divergence from an accidental one.

**Callers should not need to understand internal logic of what they
call.** Entry points don't impose structure on the caller. Special
cases handled at integration points, not buried in lower-level
functions.

## Svelte components are glue, not feature specs

The frontend is split into two layers on purpose. The full contract
lives in [`docs/dev/frontend-organization.md`](docs/dev/frontend-organization.md);
the short version, repeated here because it's the single most
common drift vector:

```text
src/lib/ui/<feature>.ts      pure UI-behavior primitives
src/components/<X>.svelte    Svelte composition + DOM glue
```

A `.svelte` file's `<script>` block holds **only** what Svelte needs
to express: prop destructuring, `$state` / `$derived` declarations,
`$effect` / `onMount` wiring, DOM-ref binds, event handlers that
delegate to callback props or mutate local reactive state, and the
markup. Everything else - option-list synthesis, display-label
transforms, enum-to-string maps, count-to-noun pluralization,
fallback chains over persisted shapes, selection mutators, domain
sentinels - belongs in the companion `src/lib/ui/<feature>.ts`
module as plain functions, tested via vitest.

The test: **"would a port to React, Solid, or Vue rewrite this
expression?"** If yes, it's framework-coupled and stays in the
`.svelte` file. If no, it's a UI-behavior primitive and belongs in
`src/lib/ui/`.

Drift patterns to refuse:

- **"It's only three lines."** Three today; three more next month;
  eight by the audit. Extract on the first occurrence, not the
  second.
- **"There's no companion module yet."** Create one. A
  single-function `src/lib/ui/<feature>.ts` is fine; its existence
  signals to the next editor that decisions live there.
- **"It's inline in the markup, not in `<script>`."** A
  `{#if count === 0}...{:else if count === 1}...{/if}` cascade is
  decision logic in the markup. Templates pick a value; they don't
  derive one. Move it to a `headlineFor(count)` primitive.
- **"The helper closes over component state."** Then it's not a
  primitive. But check - most "closes over state" cases turn out to
  be "takes one extra argument," which is fine.

When you finish a `.svelte` edit, scan the diff for new `function`
declarations, expanded template branching on enum/count/shape
fields, and new inline arithmetic that requires feature knowledge
to parse. If you find one, extract it before closing the task.

## Dead-code hygiene

AI-generated code leaves orphans easily - a helper extracted "for
clarity" with no caller; an export added "for a test that didn't
materialize"; a barrel re-export pointing at a source the consumers
all import directly. **Clean up before you finish, don't ship
orphans.**

1. **Every new export needs a live external consumer.** No `export`
   without an external reader. Same for constants and types.

2. **When you remove a call site, audit what becomes unused.**
   Every removed call is a chance to delete the callee, drop an
   `export`, or delete a stale type. If you genuinely expect to
   need it later, git remembers - resurrect from history.

3. **When you refactor a barrel.** Pull the consumer list before
   editing. Zero-consumer re-exports get deleted. Many nak barrel
   files accumulate re-exports of every sibling symbol on the
   "centralized public API" theory - then nothing imports through
   them and they rot.

4. **Test-only hooks stay internal.** Use a `__test = { ... }`
   namespace export at the bottom of the file (see
   `routing.svelte.ts`, `session.ts`) rather than widening the
   production API.

5. **Run knip before merging non-trivial work.** `mise run knip`
   catches unused files, exports, and dependencies. Clean tree
   prints "Unused exports (0)" or one well-understood dynamic-import
   false positive. The full gate (`mise run check`) does NOT chain
   knip on purpose - rot in untouched corners shouldn't gate every
   PR.

6. **Drop the `export` keyword as a first cleanup move.** When knip
   flags an unused export but the symbol is still used inside its
   source file, deleting the `export` is the fix. Body stays, API
   surface shrinks.

7. **Genuinely-dead delete.** If knip flags it, grep confirms no
   internal use, no test references, not a dynamic-import target -
   delete the whole declaration. Don't comment it out. Trust git
   for resurrection.

## User-facing documentation

Two parallel doc trees:

- `docs/user/` - end-user manual. Rendered in-app by the **Help**
  button (leftmost icon in the conversation drawer footer), also
  readable directly on GitHub.
- `docs/dev/` - architecture, components inventory, per-feature
  dev notes. Each feature doc lists the other features it touches
  in "Interactions" so coupling changes surface loudly. CLAUDE.md
  stays the session-context doc; feature implementation details
  belong in `docs/dev/`.

**Rule: any change to observable user behavior must update
`docs/user/` in the same PR.** New UI controls, settings, shortcuts,
flows, renamed menu items, user-visible copy. If you touched the UX
and didn't touch the docs, the PR isn't done.

Mechanics:

- Landing page is `docs/user/README.md` - both the "what is this"
  statement and the index. Every other doc under `docs/user/` must
  be linked from it.
- Docs are bundled via Vite's `import.meta.glob('/docs/user/**/*.md',
  { query: '?raw', import: 'default' })` (see `src/lib/docs.ts`).
  Uncommitted files don't exist to the Help modal.
- Internal links should be relative (`./foo.md`, `../dev/bar.md`).
  The Help modal's click handler loads them in-place. Anything with
  a scheme (`https:`, `mailto:`) opens in a new tab.
- After editing, smoke-test: open Help, click through, confirm
  markdown renders, internal links resolve, external links open in
  a new tab. No automated test covers the end-to-end render path.
- Dev-facing changes go in `docs/dev/` under the corresponding
  topic file. If the topic doesn't have a file yet, start one.
- If a user-facing change ships without doc updates, treat it as a
  bug and file a follow-up.

Stubs in `docs/user/` start as H1 + one-paragraph summary +
placeholder H2s. Fleshing them out is its own work; what matters
per-PR is that the relevant page moves forward by the section the
PR introduces.

## QA use-cases (docs/qa/)

`docs/qa/use-cases/` holds manual-verification walkthroughs in a
fixed format (covers / preconditions / steps / expected / cleanup /
append-only results log) - see `docs/qa/README.md` for the format.
They are the executable record of "how do we prove this feature
works end to end," aimed at the seams unit tests can't reach.

**Keep them current, in this order:**

1. **New feature ships -> its use-case ships in the same PR.** A
   feature without a walkthrough has no repeatable proof.
2. **Changing an existing feature that has no use-case? Backfill
   the use-case FIRST and execute it against the unchanged code.**
   The pre-change pass is the baseline; without it, a post-change
   pass only proves the new behavior is self-consistent, not that
   the change preserved what mattered.
3. **After the change, re-execute and log both runs** in the
   results table. The before/after pair is the regression
   evidence.

This ordering exists so a session can spawn a QA agent at the
START of a change (execute the relevant cases, log the baseline)
and again at the END (re-execute, diff against the baseline) -
AI-driven regression testing over the walkthroughs. The agent only
needs the use-case file and a running stack; if it also needs
tribal knowledge, the use-case is missing a precondition - fix the
doc.

Results-log discipline: append, never overwrite; every row carries
date, environment, and commit. Expectations marked **[hosted]**
only count when run against the hosted project.

See standing instructions at session start for branch names. In
short: develop on the designated feature branch, push when done,
**wait for the user to green-light the merge** before landing.

Commit messages: short imperative summary line, then a paragraph or
two explaining *why*. Match the tone of recent commits
(`git log --oneline`).

### Default finishing procedure per environment

**Claude Code on the web** (task-scoped sessions on a feature
branch): the web environment is persistent and shared between
concurrent agent sessions, so start-of-work hygiene keeps the source
repo in good shape.

**Default end-of-task: commit on the feature branch, push it, stop.**
Do NOT merge to `main` unless the user has explicitly given the
go-ahead for *this* task. "Fix X" / "implement Y" is permission to
do the work, not to land it. A "looks good" or "thanks" afterward
is appreciation, not a merge instruction. Phrases that DO authorize:
"merge it", "land it", "ship it", "go ahead and merge to main". If
unsure, ask.

Before starting work on the feature branch:

1. `git fetch origin` and confirm local `main` is up to date with
   `origin/main`. Fast-forward if behind. If they've diverged, stop
   and ask.
2. Rebase the feature branch onto refreshed `main` before the first
   edit.

When work is done:

1. Commit on the feature branch with a clear narrative message.
2. `git push -u origin <feature-branch>`.
3. Stop. Summarize what changed; wait for review.

When the user green-lights merging:

**"Merge to main" in the cloud environment ALWAYS means "merge the
PR."** The cloud session interacts with GitHub through the MCP
server, not the `gh` CLI. The PR is the record of review; the merge
button is the record of the change. Bypassing it with a direct push
leaves the PR open and the audit trail empty.

Mechanic:

1. `git fetch origin main` and rebase the feature branch onto
   current `origin/main` if main has moved (resolve conflicts; stop
   and ask if non-trivial). Push the rebased branch
   (`git push --force-with-lease` if the rebase rewrote history).
2. If no PR exists, open one with `mcp__github__create_pull_request`
   against `main`.
3. Merge with `mcp__github__merge_pull_request`:
   - single commit -> fast-forward / rebase merge
   - multiple commits -> squash merge, with the squashed message
     covering the whole change
4. `git fetch origin main && git checkout main && git pull --ff-only`
   so the local tree is on the new `main`.
5. Delete the local feature branch (`git branch -d <feature-branch>`).
   Leave the remote feature branch alone - the user runs a periodic
   cleanup script. No need to mention the skipped remote delete in
   the summary; it's the expected shape of every merge.

If the user says "merge to main" *and* no PR exists, step 2 (open
the PR) is implied by the merge instruction - this is the one case
where opening a PR doesn't need a separate explicit ask.

**Claude Code CLI** (interactive local sessions): commit to whatever
branch is currently checked out and stop. Do not rebase, merge,
push, or switch branches. The user drives integration themselves.

### General git rules

- **No AI attribution.** No `Co-Authored-By`, no "Generated with
  Claude Code" footers, no equivalent.
- **Never push to `origin` without explicit instruction.** Same for
  force-pushes, branch deletions, amending pushed commits.
- **Save-point commits before non-trivial edits.** Check for
  unstaged changes at task start; ask for a save-point commit if
  there are any. Skip if you made the staged changes this session.
- **ASCII-only** in commit messages, PR descriptions, code
  comments, doc files, conversational replies. No smart quotes, no
  em-dashes, no double-hyphen faux em-dashes (` -- `). Single
  hyphen with spaces (` - `) for parenthetical asides.

## PR descriptions

Use instructional design: layer knowledge so reviewers build
understanding before hitting the diff.

**Structure** (Perl POD-style for non-trivial PRs):

- **SYNOPSIS:** 1-2 lines, orient only.
- **PURPOSE:** frame the problem. "Currently does X, bad because Y."
  No solution yet.
- **DESCRIPTION:** three layers - (1) how existing code behaves,
  naming decision points; (2) what this PR changes, parallel to
  layer 1 with the same names and order; (3) how that fixes PURPOSE
  in one or two sentences closing the loop.

For small PRs, synopsis + a paragraph of *why* is fine. Match the
energy of the change.

**Bionic-text bolding.** Bold the save-point nouns and verbs in
each section, not whole sentences and not adjectives. Reading only
the bolds should convey the change shape. Bold once per concept
per section.

**Telegraphic bullets** inside sections: lowercase starts,
abbreviations ("w/", "1x"), parenthetical shorthand.

**Defensive phrasing for AI reviewers** (Cursor BugBot, etc.).
Explicitly call out intentional behavioral changes; explain things
that could be misinterpreted as bugs. Goes in DESCRIPTION layer 2
or as a trailing `Notes:` bullet.

**Don't.** No tables, no "notable design decisions" sections, no
file inventories, no AI attribution. Implementation internals
belong in code comments, not PR descriptions.

## Boundaries

No commits, PRs, branch changes, pushes, or external mutations
unless explicitly instructed. Read access outside the project is
fine; write access is not. Local file edits inside the project are
fine within the scope of the requested task; anything visible to
others or affecting shared state needs explicit confirmation.

When you encounter unexpected state - unfamiliar files, branches,
configuration - investigate before deleting or overwriting. It may
represent the user's in-progress work.

## Running the checks locally

`mise run check` is self-sufficient from a fresh clone or worktree -
every gate task `depends = ["deps"]`, which runs `pnpm install
--frozen-lockfile`. No separate `pnpm install` needed. ~500ms on an
up-to-date tree.

```sh
mise run check           # full local gate: deps + test + deno check/test + svelte-check + lint + build
mise run test            # vitest run
mise run functions-test  # Deno unit tests for the edge functions
mise run functions-check # deno check over every edge-function entrypoint
mise run markdownlint    # markdownlint-cli2 only
mise run knip            # dead-code scan; NOT in the gate by design
mise run dev-frontend    # Vite dev server only, no backend
mise run dev-start       # isolated local dev: local Supabase stack + Vite
mise run build           # production PWA build
```

The Deno island (functions-check + functions-test) rides the gate
because nothing else covers it: `supabase functions deploy` bundles
with esbuild and never type-checks, vitest never sees Deno code, and
`deno test` only type-checks what the tests import - functions-check
covers the full import graph each function deploys with.

If you prefer raw pnpm (or mise isn't available - ephemeral
sandboxes, first-time checkouts), the manual sequence is
`pnpm install && pnpm test && pnpm check && pnpm lint && pnpm build`.
`pnpm build` is in the gate because Vite/Rollup failures
(IIFE/code-splitting in worker bundles, PWA manifest injection,
dynamic-import graphs tsc is happy with but Rollup chokes on) only
surface at build time - catching them here prevents a green Tests
run from landing on main and triggering a half-applied deploy
(schema synced, bundle never built).

`mise run check` is what CI runs (`.github/workflows/tests.yml`), so
green locally = green CI.

Always run the gate before committing - including for CSS- or
markdown-only changes. The test suite includes a postcss parse of
every stylesheet under `src/` (`tests/styles.test.ts`) and a
markdownlint pass over the doc tree (`tests/markdownlint.test.ts`).

### Check exit codes, not piped output

Piping a gate command (`mise run check 2>&1 | tail -2`) replaces
its exit code with the pipe tail's - a failed gate reads as success
and the next `&&` step (often `git commit`) runs anyway. This has
shipped lint-broken and type-broken commits that needed amending.
When chaining on success, capture the status explicitly
(`mise run check > /tmp/out 2>&1; echo "GATE=$?"`) or run the gate
as its own un-piped command before the commit step.

### Read the warnings, not just the exit code

Exit 0 from `mise run check` is necessary but not sufficient.
`pnpm build` emits warnings that don't fail the gate but signal
real problems - Rollup's chunk warnings in particular often mean
optimization work quietly didn't take effect. Examples that have
bitten us:

- `(!) <module> is dynamically imported by X but also statically
  imported by Y, dynamic import will not move module into another
  chunk.` Means your code-splitting isn't actually splitting because
  another module pulls the same target statically.
- `(!) Some chunks are larger than 500 kB after minification.`
  Advisory; the asset list tells you which chunk is over.

When doing bundle-shape work, grep the build output for `(!)` and
`plugin:vite:reporter` before declaring victory:

```sh
mise run check 2>&1 | grep -E '\(!\)|plugin:vite:reporter'
```

Treat each warning as a TODO until resolved or deliberately accepted
with the reasoning written down in code comments.

## Verifying UI changes

The standing harness rule is "for UI/frontend changes, start the
dev server and use the feature in a browser before reporting the
task as complete." That rule applies only when the environment can
actually do it - **the cloud agent cannot**. Cloud sessions have no
browser, no Pages preview, and the dev server has no visible
surface. Pretending to verify by running `mise run dev-frontend`
and reading the build output is theatre.

The cloud agent's correct posture:

1. Run `mise run check` (and `mise run knip` for non-trivial work)
   so the gate's static guarantees stand.
2. Reason carefully about the visual + interaction layer: empty /
   loading / error states, mutual-exclusivity branches in template
   `:else-if` cascades, button placement, icon legibility, mobile-
   narrow viewport behavior, dark-mode contrast. Code review stands
   in for the missing browser check.
3. In the end-of-turn summary, **explicitly flag what wasn't
   verified.** "The gate is green, but I can't open the page in a
   browser - the X rendering, the Y navigation, the empty/loading/
   error states want manual sanity check before this lands."
4. If the user green-lights the merge anyway, that's their call.
   Don't try to talk them out of it; just merge.

The CLI session runs on the user's machine and CAN open a browser
(or ask them to); that case still follows the standing rule.

## Supabase schema changes

Schema lives in `supabase/schema.sql` and is applied to the linked
project by `mise run sync` (`scripts/sync.mjs`). There are no up/down
migrations - the file is re-applied start-to-finish on every sync,
so **every statement must be idempotent**. The header comment in
`schema.sql` documents the patterns the project uses (`if not
exists`, `drop policy if exists` + recreate, guarded `do $$` blocks
for things without native `if not exists` support like `alter
publication`).

When you add a column, table, policy, trigger, publication member,
index, extension, etc.:

1. Edit `supabase/schema.sql`.
2. Merge to `main`. The `sync-supabase` job in
   `.github/workflows/deploy.yml` runs `node scripts/sync.mjs` on
   every deploy. The step is gated on `vars.SUPABASE_PROJECT_REF
   != ''` so forks that haven't wired automation up still deploy
   normally.
3. `mise run sync` is the way to try a schema change against the
   linked project *before* opening a PR. The Supabase SQL Editor
   remains a manual fallback.

A schema-apply failure in CI fails the whole deploy on purpose -
better to catch a bad migration than ship an app whose code expects
columns the DB doesn't have.

**Do NOT tell the user to run `mise run sync` after a cloud merge to
`main`.** The deploy's `sync-supabase` job applies the schema
automatically on every merge. `mise run sync` is only worth
mentioning as the way to try a schema change *before* merging.

The sync job also merges the fork's Pages URL into the auth
allowlist, but that's orthogonal to schema - don't dwell on it in PR
descriptions for schema changes.
