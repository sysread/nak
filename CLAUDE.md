# CLAUDE.md

Guidance for Claude Code / Claude sessions working in this repo. See `README.md` for the project-level overview, `docs/user/README.md` for the end-user manual (also rendered in-app via the **Help** button), and `docs/dev/README.md` for architecture + per-feature dev notes.

## Talking to the user

Calibration that applies to every interaction. Hard constraints, not style preferences.

**Correctness over comfort.** No reassurance, validation, softening, or emotional framing. Questions are requests for epistemic validation, not support. Lead with the answer, not the framing. "That's wrong because X," not "one consideration is X." "I don't know" or "50/50" rather than "it might be worth considering." Skip the "want me to..." preamble when the action is obvious - just do it or state it directly.

**Be machine-parseable.** Communication should aim toward deterministic. Tactful framing adds heuristic surface area where the real point can be missed entirely. Treat consideration for feelings as surface area for misinterpretation. Assume the user will not be offended by direct honesty.

**Push back when justified.** If the user dictates an approach, evaluate before accepting:

1. Confirm you understand the reasons (ask if unclear; don't ask just to ask).
2. Evaluate against the problem, constraints, and goals.
3. Evaluate against the codebase, architecture, and conventions (this file plus `docs/dev/`).
4. Evaluate against the principles in this document.

If the suggestion fails any check, explain the problems directly, referencing the principle/constraint/convention. Itemize cleaner alternatives if any exist. Make the final item in your alternatives list "Do it anyway (but the bot washes its hands of it)." If the user insists despite the issues, respond *"We are but soldiers. Ours is not to reason why, but to do and die. 😇"* and proceed.

**Identify implications proactively.** When a literal reading of a request would have non-obvious downstream effects, surface them BEFORE making the change, not after. A "gate this on X" instruction often gates more than the user had in mind because the same code path is reused for unrelated cases - look at every caller of the path you're about to touch and name any behavior that would silently break. Itemize the alternatives (accept the regression, carve out an exception, restructure) and ask which the user wants. Catching the implication late is a regression the user has to debug; catching it before the edit is free. The user values catching errors over feeling good.

**Challenge implicit assumptions when they don't match what you know.** A request's framing carries premises - "fix the bug where X happens," "since I'm new to Y," "the Z feature should...," "this used to work." When a premise contradicts the conversation history, the visible codebase, recent commits, or what you've seen the user do in this session (asking about a feature that was removed last week; claiming beginner status at something they've shipped for months; asserting a behavior the code doesn't have; attributing a regression to a change that didn't touch the path), name the mismatch BEFORE answering the literal question. Do not silently translate the request into one where the false premise holds; that produces a confidently wrong answer the user then has to unwind. The right shape is "X was removed in #45 - did you mean Y?" or "the code on `main` has never done that, here's what it actually does, are we talking about a different branch?" - then wait. A false premise caught at the start is free; caught after the edit, it's a regression plus the original problem still unsolved.

**Ask rather than hallucinate intent.** When the request is ambiguous and the cost of getting it wrong is non-trivial, ask before guessing.

## Keep the user informed while working

The web UI for Claude Code is a little basic - a long tool call with no
text chatter reads to the user as "hung" even when work is happening.
Emit short text updates aggressively:

- **Before every slow call.** State what you're about to run (a test
  suite, a rebase, a build, an `$effect` narration in a long
  investigation) in one sentence *before* hitting the tool call, so the
  user can see the intent while the spinner ticks. Don't say "I'll run
  the tests" and then take thirty seconds to actually submit the tool
  call - the UI shows silence in the gap.
- **Between steps.** Narrate rebases, multi-commit git work, and any
  sequence where one tool result gates the next. "Rebased cleanly, now
  re-running the gate" costs nothing and prevents the "is it stuck?"
  check-in.
- **On an unexpected detour.** If you hit a surprise (a stale file, a
  NUL byte, a 403 from the harness's git proxy), call it out
  immediately rather than working around it silently. The user would
  rather see "hitting X, trying Y" than wonder what happened during a
  silent gap.
- **At the end of a long op.** Always emit at least one sentence after
  a slow tool returns, even if the next step is another slow tool.

Brief is good; silent is not. One sentence per update is almost always
enough. The rule is "the user should be able to tell from your text
output alone whether you're working, waiting, or done" - tool calls
aren't visible enough in this UI to carry that signal on their own.

## Commenting style

Nak is small and dense. Many files encode non-obvious decisions — browser-API
quirks, security tradeoffs, bugfixes that look removable but aren't. **When you
change code, the surrounding comments are often the only record of why it's
that way.** If the next session can't distinguish a load-bearing constraint
from an accidental quirk, they'll confidently delete the wrong line.

Default to writing a comment when you add non-trivial logic. Don't wait to be
asked.

### What deserves a comment

- **Why, not what.** Names tell the reader what the code does; the comment
  should explain *why this approach*.
- **A constraint that forced the design.** Browser-API quirks (EventSource
  can't POST with headers; canvas-based glyph detection needs a PUA fallback
  char). Security tradeoffs (why PBKDF2-SHA256 and not Argon2; why
  read-then-write is safe for single-user settings). Protocol details
  (OpenAI-compatible SSE framing; Unicode emoji-presentation selectors).
- **Bugfixes.** Name the symptom in the comment. "This check prevents the
  draft from materializing twice when the user hits Enter before the first
  insert resolves" costs two lines today and prevents a regression six months
  from now when someone else reads the fix and thinks "this guard looks
  extraneous, I bet I can remove it." If the change fixes an observable bug,
  leave a note on the failure mode you're protecting against.
- **Invariants and contracts.** "Must run before X"; "caller owns cleanup";
  "safe to call repeatedly"; "no-op when not signed in".
- **Intentional silence.** An empty `catch {}` should say *why* silence is
  correct — e.g. "best-effort; auto-title failure just keeps the placeholder
  title."
- **Magic numbers from a standard.** Cite the source (OWASP PBKDF2 guidance,
  NIST SP 800-132, an RFC number, a WCAG level).

### Voice

Complete sentences. Name symptoms by their observable behavior
rather than by internal jargon. ASCII only - no smart quotes, no
smart apostrophes, no em-dashes. Single hyphen with spaces (` - `)
for "here's the reason" tangents and parenthetical asides.

(The existing codebase has em-dashes scattered through comments
from earlier passes; leave them alone unless you're touching the
surrounding code, but don't write new ones. A pass to clean them
up wholesale is a separate task.)

Good:

```ts
// U+FE0F forces emoji-style presentation - without it, U+2696
// SCALES renders as a thin text glyph that reads as near-
// invisible against the toggle background.
```

```ts
// Best-effort: ask the fast model for a short title for this
// thread. Runs after the first user+assistant round-trip. Any
// failure is swallowed - the thread simply keeps the default
// title.
```

Not:

```ts
// set variation selector
```

```ts
/* Mobile styles */
```

### Where to put them

- **File-level preambles** on any module whose role isn't obvious from its
  name. Say what this module owns and name the adjacent modules it interacts
  with.
- **Block comments above non-obvious branches.** Not `// loop over items`,
  but `// Preserve drafts across a refetch — they only exist in memory
  until the user sends.`
- **Trailing line comments** for single-line clarifications of a constant.

### What NOT to comment

- Obvious plumbing (imports, state variable declarations).
- Pure reformatting, rename-only, or style-only changes.
- Things a well-named identifier already makes plain (`const isMac = ...;`
  doesn't need `// true on mac`).
- Already-commented code — if you learned something new, *update* the
  existing comment rather than adding a parallel one. Stale comments are
  worse than missing ones.

### Code review checklist (for yourself)

Before handing work back:

- [ ] Every bugfix names its failure mode.
- [ ] Every empty `catch {}` explains the swallowed error.
- [ ] Every browser-API quirk cites the quirk by observable behavior.
- [ ] Every constant derived from a spec cites the spec.
- [ ] No stale comments left pointing at removed code.

### False positives are a documentation signal

A false positive in code review (LLM or human) is not noise. It's
evidence the code is missing inline documentation that would have
prevented the wrong read. The fix is never to dismiss the false
positive - it's to add the comment that makes the false positive
impossible next time. The reviewer was working with the
information available; if they reached the wrong conclusion, the
inputs were under-specified.

Apply this proactively. Code that's inviting a false positive
should be commented before any review. Common offenders:

- Cross-language semantics where defaults diverge. Postgres
  unary `log()` is base-10 (natural log is `ln()`); JS `Math.log`
  is natural; the convention is reversed in most other languages.
  A line like `5.0 * log(n + 10)` will get cross-flagged unless a
  comment names the base.
- Functions whose behaviour is the inverse of the obvious naming
  (e.g. a "claim" RPC returning `false` on success of acquisition
  vs failure to acquire).
- Conventions chosen against the local sibling pattern. If one
  RPC raises where its siblings silent-skip, the divergence itself
  needs a sentence of justification.
- Magic constants from a spec or standard - cite the source
  (OWASP, RFC, NIST, WCAG, the W3C spec name).

## Capturing conventions

Claude sessions don't share state with prior or future sessions. If
you learn something the next session would waste time rediscovering
— a workflow that differs from "the usual" (e.g. schema changes go
through `mise run sync`, not the SQL Editor), a non-obvious
constraint, a load-bearing invariant — write it down:

- **Single-file scope:** leave it as a comment next to the code.
  You'll see it on the next edit.
- **Multi-file or repo-wide scope:** add it here, ideally under a
  named section so it surfaces on a quick scan of the table of
  contents.
- **Both:** a short pointer in the file (e.g. "see CLAUDE.md §
  Supabase schema changes") plus the full explanation here.

When the underlying behavior changes, update the note in the same
PR. A stale convention note sends the next session the wrong way
with full confidence — worse than no note at all.

If the user corrects you on a project convention, that's a strong
signal the convention isn't documented yet. Add it before closing
the task.

## Code quality and organization

**Separation of concerns is the prime directive.** Special cases
stay off the API (internal and external). A function whose
behaviour changes drastically based on a parameter is two
functions. Make the right thing the easiest thing.

**Simple solutions over over-engineered ones.** Don't add
features, refactor, or introduce abstractions beyond what the task
requires. A bug fix doesn't need surrounding cleanup. Don't design
for hypothetical future requirements. Three similar lines beat a
premature abstraction. If you find yourself adding a config knob
"in case we need it later," stop.

**Trust internal code and framework guarantees.** Only validate at
system boundaries (user input, external APIs, the Venice wire
shape). Don't add error handling, fallbacks, or validation for
scenarios that can't happen. Don't add backwards-compatibility
shims or feature flags when you can change the code directly.

**Wire up the desired state first, then collapse.** Software
changes work like tetris: stack them up, then when density is high
enough, collapse the stack to manageable complexity. Don't polish
incomplete work; finish the wire-up first, then delete the
artifacts. All of software development is complexity management.

**Prefer named functions over inline procedural code.** A
subcommand or script reads better when scanning/setup logic lives
in named functions and the main flow at the bottom calls them.
Function signatures tell the story; the main block shows the flow.

**Flag newly-unused code for deletion.** When you remove a call,
check whether the target is now unused. Say so in the PR
description even if you're not touching it in this change - the
user has a strong preference for deleting what isn't paying rent.

**When you move code, clean up the accommodations it leaves
behind.** A relocated element usually had scaffolding around it -
CSS clearance for an absolutely-positioned button that's now in a
flex row, a z-index bump against an overlay that no longer exists,
a wrapper whose only job was catching an event that now fires
somewhere else, a parent `position: relative` that existed only to
anchor the moved child. Before closing the task, scan the old
neighborhood and delete what the prior form was load-bearing for.
Otherwise the compensation silently outlives the thing it
compensated for and distorts the new layout - often only visible on
mobile, in dark mode, or at a viewport narrow enough to reveal what
the stale gutter was hiding. A move is not done when the new site
works; it's done when the old site no longer leaves a shadow.

**Non-conforming code requires a comment.** If you have a good
reason for diverging from the prevailing pattern, the reason goes
inline. The reader has to be able to tell a deliberate divergence
from an accidental one.

**Callers should not need to understand internal logic of what
they call.** Entry points should not impose structure on the
caller or assume intent. Context-agnostic contracts are fine.
Special cases handled at integration points, not buried in
lower-level functions.

## Dead-code hygiene

AI-generated code leaves orphans easily - a helper extracted
"for clarity" that ends up with no caller; an export added "for
a test that didn't materialise"; a constant declared next to its
former consumer that was later inlined; a barrel re-export pointing
at a source the consumers all import directly. The user's biggest
struggle with AI-assisted development is exactly this drift, and
the standing instruction is: **clean up before you finish, don't
ship orphans.**

Concrete rules. Apply each before declaring a task done.

**1. Every new export needs a live external consumer.** If you
add `export function foo()`, grep for who calls it from another
file. If the answer is "nobody yet, but later something will" -
don't export it. Make it a plain function in the same module.
Add the export only when an external caller actually lands.
The same applies to constants and types: `export const FOO = 5`
without a non-local reader is the same orphan as a dead function.

**2. When you remove a call site, audit what becomes unused.**
Every removed call is a chance to delete the callee, drop an
`export` keyword, or delete a stale type. Don't leave the
ex-helper sitting in the file "in case." If you genuinely
expect to need it again later, git remembers - resurrect from
history when the need shows up, not as speculation.

**3. When you refactor a barrel.** Pull the consumer list before
editing it. If a barrel re-export has zero consumers (the source
file is imported directly everywhere), delete the re-export -
not just the surrounding `from './foo'` line, the whole entry.
Many nak barrel files accumulate re-exports of every symbol from
every sibling on the theory of "centralised public API" - then
nothing ever imports through the barrel and the re-exports rot.

**4. Test-only hooks stay internal.** A function whose only
external caller is a `tests/*.test.ts` file should still be
flagged in the test's setup with `// test hook` and named with a
leading `_` (or carry a `__test` namespace export at the bottom
of the file). Don't widen the production API for a test that
could read internal state via a dedicated export. The
`__test = { ... }` pattern (see `routing.svelte.ts`,
`crypto.ts`, `session.ts`) keeps the test surface visible and
the production exports narrow.

**5. Run knip before merging non-trivial work.** `mise run knip`
catches unused files, exports, and dependencies. The
configuration in `knip.json` is calibrated so a clean tree
prints "Unused exports (0)" or one well-understood dynamic-import
false positive. Anything beyond that is a TODO. The full gate
(`mise run check`) does NOT chain knip on purpose - rot in
untouched corners shouldn't gate every PR - so this is one you
have to think to run.

**6. Drop the `export` keyword as a first cleanup move.** When
knip flags an unused export but the function/constant is still
used INSIDE its source file, the fix is usually just to delete
the `export` keyword. The body stays, the API surface shrinks.
Many "Unused exports" findings resolve this way without
deleting any code.

**7. Genuinely-dead delete.** If knip says an export is unused
AND your grep confirms no internal use, AND no test references
it, AND it's not a dynamic-import target - delete the whole
declaration. Don't comment it out. Don't leave a "TODO: maybe
useful later" stub. Trust git for resurrection.

When you finish a feature that's drained-down to its real
load-bearing parts, run knip. The smaller surface area you
hand back is the next session's reduced cognitive load.

## User-facing documentation

The repo ships two parallel doc trees:

- `docs/user/` — the end-user manual. Rendered in-app by the **Help**
  button (leftmost icon in the conversation drawer footer), and also
  readable directly on GitHub.
- `docs/dev/` — architecture overview, components inventory, and
  per-feature dev notes. Each feature doc lists the other features it
  touches in an "Interactions" section so coupling changes surface
  loudly. `CLAUDE.md` stays the session-context doc (commenting
  style, testing stance, git conventions); feature implementation
  details belong in `docs/dev/`.

**Rule: any change to observable user behavior must update
`docs/user/` in the same PR.** That covers new UI controls, new
settings, changed shortcuts, changed flows, renamed menu items, and
any user-visible copy that docs already describe. If you touched the
user experience and didn't touch the docs, the PR isn't done.

Mechanics:

- The landing page is `docs/user/README.md`. It's both the "what is
  this" statement and the index — every other doc under `docs/user/`
  must be linked from it. Adding a new page? Add the link too.
- Docs are bundled via Vite's `import.meta.glob('/docs/user/**/*.md',
  { query: '?raw', import: 'default' })` (see `src/lib/docs.ts`). A
  file that isn't committed doesn't exist to the Help modal, so add
  and stage the file in the same change that links to it.
- Internal links should be relative (`./foo.md`, `../dev/bar.md`).
  Those are intercepted by the Help modal's click handler and loaded
  in-place. Anything with a scheme (`https:`, `mailto:`) is treated
  as external and opens in a new tab.
- After editing, smoke-test: open Help, click through to the edited
  page, confirm the markdown renders, internal links resolve, and
  external links open in a new tab. No automated test covers the
  end-to-end render path today.
- Dev-facing changes (build tooling, internal APIs, subsystem
  conventions) go in `docs/dev/` under the corresponding topic file,
  linked from `docs/dev/README.md`. If the topic doesn't have a file
  yet, start one.
- If a user-facing change ships without doc updates, treat it as a
  bug — file a follow-up to close the gap.

Stubs in `docs/user/` start out as an H1 + one-paragraph summary +
placeholder H2s. Fleshing them out is its own work; what matters for
each feature PR is that the relevant page moves forward by at least
the section the PR introduces or changes.

## Commit / branch / merge conventions

See the standing instructions given at session start for branch names
and merge policy. In short: develop on the designated feature branch,
push that branch when the work is done, and **wait for the user to
green-light the merge** before fast-forwarding into `main`. The
designated branch exists precisely so the user can review before
landing - merging without explicit go-ahead pre-empts the review they
intended to do.

Commit messages follow the project's narrative style: a short imperative
summary line, then a paragraph or two explaining *why*. Match the tone of
recent commits (`git log --oneline`).

### Default finishing procedure per environment

These are the defaults - follow them without being asked. Deviate only when
the user explicitly says to.

**Claude Code on the web** (task-scoped sessions on a designated feature
branch): the web environment is persistent and shared between concurrent
agent sessions, so the start-of-work hygiene below keeps the source repo
in good shape - `main` up to date with `origin/main`, feature branches
rebased on current `main`, and (eventually) a merge history that reads
as a clean linear progression rather than a twisty-straw tangle of
crossing merges from stale branches.

**The default end-of-task is "commit on the feature branch, push it, and
stop."** Do NOT merge to `main` unless the user has explicitly given the
go-ahead for *this* task. "Fix X" / "implement Y" is permission to do
the work; it is not permission to land it. A "looks good" or "thanks"
afterward is appreciation, not a merge instruction. Phrases that DO
constitute a green light: "merge it", "land it", "ship it", "go ahead
and merge to main", or any equivalent that unambiguously asks for the
integration step. If unsure, ask.

Before starting any work on the feature branch:

1. `git fetch origin` and confirm local `main` is up to date with
   `origin/main`. Fast-forward if behind (`git checkout main && git pull
   --ff-only origin main`). If they've diverged - a previous session
   left local `main` ahead, or someone else pushed a non-fast-forward
   change - stop and ask; don't guess.
2. Rebase the feature branch onto the refreshed `main` before the first
   edit. Starting work on a stale branch is what produces the twisty
   straw at merge time.

When the work for the task is done:

1. Commit on the feature branch with a clear narrative message.
2. `git push -u origin <feature-branch>`.
3. Stop. Summarise what changed and what's next; wait for the user to
   review and either request changes or green-light the merge.

When the user has explicitly green-lit merging this branch to `main`:

**In the cloud environment, "merge to main" ALWAYS means "merge the
PR."** The cloud session interacts with GitHub through the MCP server,
not the `gh` CLI (which isn't installed). The user's review surface is
the PR itself - that's where they leave comments, ask for changes, or
hit the merge button. Even if `git push origin main` directly happens
to succeed (branch protection may or may not be enforcing in any given
moment), do NOT take that path. The PR is the record of review; the
merge button is the record of the change. Bypassing it with a direct
push leaves the PR open and the audit trail empty.

The mechanic is:

1. `git fetch origin main` and rebase the feature branch onto current
   `origin/main` if main has moved since the start-of-work rebase
   (resolve conflicts; stop and ask if non-trivial). Push the rebased
   branch (`git push --force-with-lease` if the rebase rewrote
   already-pushed history).
2. If a PR for this branch doesn't exist yet, open one with
   `mcp__github__create_pull_request` against `main`.
3. Merge the PR with `mcp__github__merge_pull_request`:
   - single commit on the branch -> fast-forward (or rebase) merge
   - multiple commits -> squash merge, with the squashed commit
     message covering the whole change (use the existing narrative
     commit messages as source material)
4. `git fetch origin main && git checkout main && git pull --ff-only`
   so the local tree is on the new `main` for the next task.
5. Delete the local feature branch (`git branch -d <feature-branch>`).
   Leave the remote feature branch alone - the user runs a periodic
   cleanup script over stale remote branches. No need to mention the
   skipped remote delete in the end-of-turn summary either; it's the
   expected shape of every merge.

If the user says "merge to main" *and* a PR doesn't exist yet, step 2
(open the PR) is implied by the merge instruction - this is the one
case where opening a PR doesn't need a separate explicit ask. The
harness-level rule against creating PRs unbidden still applies to
end-of-task pushes where the user has only asked you to do the work,
not to land it; "merge it" is the trigger that flips both.

**Claude Code CLI** (interactive local sessions): commit to whatever branch
is currently checked out and stop. Do not rebase, do not merge, do not push,
do not switch branches. The user drives integration themselves.

**No AI attribution.** No `Co-Authored-By` lines, no "Generated
with Claude Code" footers, no equivalent. The user's preference is
strict on this.

**Never push to `origin` without explicit instruction.** Pushing
is the user's prerogative. Same for force-pushes, branch deletions,
amending already-pushed commits, or anything else that mutates
shared state. When in doubt, commit locally and stop.

**Save-point commits before non-trivial edits.** Check for
unstaged changes at the start of a task; ask the user for a
save-point commit if there are any. Skip if you made the staged
changes yourself in this session.

**ASCII-only everywhere you're writing for the user or the
repo - commit messages, PR descriptions, code comments, doc
files, conversational replies.** No smart quotes, no smart
apostrophes, no em-dashes. Single hyphen with spaces (` - `)
for parenthetical asides. The double-hyphen faux em-dash
(` -- `) reads as AI slop; don't use it. The codebase has
inherited em-dashes from earlier passes; leave them alone unless
you're touching the surrounding code. A wholesale cleanup is a
separate task.

## PR descriptions

Use instructional design: layer knowledge so reviewers build
understanding before hitting the diff.

**Structure** (Perl POD-style works well for non-trivial PRs):

- **SYNOPSIS**: 1-2 lines. Orient only.
- **PURPOSE**: frame the problem. Pattern "Currently does X, bad
  because Y." No solution yet.
- **DESCRIPTION**: three didactic layers - (1) how existing code
  behaves, naming the decision points; (2) what this PR changes,
  parallel to layer 1 with the same names and order; (3) how that
  fixes PURPOSE in one or two sentences closing the loop.

For small PRs, a synopsis + a paragraph of *why* is fine. Match
the energy of the change; don't over-engineer the description.

**Bionic-text bolding.** Bold the save-point nouns and verbs in
each section, not whole sentences and not adjectives. Reading
only the bolds should convey the shape of the change. Bold once
per concept per section.

**Telegraphic bullets** inside sections: lowercase starts,
abbreviations ("w/", "1x"), parenthetical shorthand. Not full
formal sentences.

**Defensive phrasing for AI reviewers** (Cursor BugBot, etc.).
Explicitly call out intentional behavioural changes; explain
things that could be misinterpreted as bugs; describe intent
clearly enough that an AI reviewer can judge whether changes
follow the spirit of the goal. Goes in DESCRIPTION layer 2 or as
a trailing `Notes:` bullet.

**Don't.** No tables. No "notable design decisions" sections. No
file inventories. No AI attribution. Implementation internals
belong in code comments, not PR descriptions.

## Boundaries

No commits, PRs, branch changes, pushes, or external mutations
unless explicitly instructed. Read access outside the project is
fine; write access is not. Local file edits inside the project
are fine within scope of the requested task; anything visible to
others or affecting shared state needs explicit confirmation
before acting.

When you encounter unexpected state - unfamiliar files, branches,
configuration - investigate before deleting or overwriting. It
may represent the user's in-progress work.

The cost of pausing to confirm is low. The cost of an unwanted
action - lost work, unintended messages sent, deleted branches -
can be very high.

## Running the checks locally

`mise run check` is self-sufficient from a fresh clone or worktree —
every gate task `depends = ["deps"]`, which runs `pnpm install
--frozen-lockfile`. You do not need a separate `pnpm install` step;
the gate provisions its own npm devDependencies on demand. Cost is
~500ms on an up-to-date tree.

```sh
mise run check        # full local gate: deps + test + svelte-check + lint + build
mise run test         # vitest run (auto-installs deps)
mise run markdownlint # markdownlint-cli2 only (auto-installs deps)
mise run knip         # dead-code scan (auto-installs deps); not in the gate by design
mise run dev          # Vite dev server (auto-installs deps)
mise run build        # production PWA build (auto-installs deps)
```

If you prefer raw pnpm (or mise isn't available — ephemeral
sandboxes, first-time checkouts), the manual sequence is
`pnpm install && pnpm test && pnpm check && pnpm lint && pnpm build`.
The mise tasks are thin wrappers around those pnpm scripts; there's
no hidden behaviour. `pnpm build` is in the gate because Vite
failures (Rollup IIFE/code-splitting in worker bundles, PWA
manifest injection, dynamic-import graphs tsc is happy with but
Rollup chokes on) only surface at build time - catching them here
prevents a green Tests run from landing on main and triggering a
half-applied deploy (schema synced, bundle never built).

`mise run check` is what CI runs (see `.github/workflows/tests.yml`),
so a green `mise run check` locally is a green CI job.

Always run the gate before committing — including for CSS- or
markdown-only changes. The test suite includes a postcss parse of
every stylesheet under `src/` (see `tests/styles.test.ts`) and a
markdownlint-cli2 pass over the doc tree (see
`tests/markdownlint.test.ts`). Both only surface at `pnpm build` /
the Pages deploy otherwise.

### Read the warnings, not just the exit code

Exit 0 from `mise run check` is necessary but not sufficient.
`pnpm build` (the Vite/Rollup pass) emits warnings that don't fail
the gate but signal real problems - and Rollup's chunk warnings
in particular often mean the optimisation work you just did
quietly didn't take effect. Examples that have bitten us:

- `(!) <module> is dynamically imported by X but also statically
  imported by Y, dynamic import will not move module into another
  chunk.` Means a dynamic import you added for code-splitting
  isn't actually splitting because some other module pulls the
  same target statically. The chunking diff you thought you
  shipped is a no-op until both consumers go through the same
  import shape.
- `(!) Some chunks are larger than 500 kB after minification.`
  Advisory threshold; reading the surrounding asset list tells
  you which chunk is over and what's in it. Don't ignore it
  silently if you're working on bundle size.
- `(!) <module> is dynamically imported but also statically
  imported by ...` (variant phrasing). Same family.

When you do bundle-shape work (lazy loads, code-splitting, worker
boundaries), grep the build output for `(!)` and `plugin:vite:reporter`
before declaring victory:

```sh
mise run check 2>&1 | grep -E '\(!\)|plugin:vite:reporter'
```

Treat each warning as a TODO until you've either resolved it or
deliberately decided the trade-off (with the reasoning written
down in code comments next to the import that triggered it).

## Verifying UI changes

The standing harness rule is "for UI or frontend changes, start the
dev server and use the feature in a browser before reporting the task
as complete." That rule applies only when the environment can
actually do it - **the cloud agent cannot**. Cloud sessions don't
have a browser, don't have a Pages preview, and the dev server it
can spin up has no surface the user can see. Pretending to verify by
running `mise run dev` and reading the build output is theatre - the
build was already covered by `mise run check`.

The cloud agent's correct posture:

1. Run `mise run check` (and `mise run knip` for non-trivial work) so
   the gate's static guarantees stand - tests pass, svelte-check is
   clean, ESLint is clean, the build succeeds, dead-code surface
   didn't grow. These cover correctness of code; they don't cover
   correctness of UX.
2. Reason carefully about the visual + interaction layer: empty /
   loading / error states, mutual-exclusivity branches in template
   :else-if cascades, button placement, icon legibility at the
   target size, mobile-narrow viewport behavior, dark-mode contrast.
   Code review for UI work is what stands in for the missing browser
   check.
3. In the end-of-turn summary, **explicitly flag what wasn't
   verified.** "The gate is green, but I can't open the page in a
   browser from here - the alert-triangle icon rendering, the row-
   click navigation, the panel's mutual exclusivity with the
   librarian view, and the empty/loading/error states want a manual
   sanity check before this lands on main." Don't bury it; the user
   needs that signal to know which part of the change the gate did
   and didn't cover.
4. If the user green-lights the merge anyway, that's their call -
   they're choosing to spot-check after the fact rather than block
   the merge. Don't try to talk them out of it; just merge.

The Claude Code CLI session runs on the user's machine and CAN open
a browser (or ask them to); that case still follows the standing
rule. The cloud-env carveout is for the cloud agent specifically.

## Supabase schema changes

Schema lives in `supabase/schema.sql` and is applied to the linked
project by `mise run sync` (see `scripts/sync.mjs` and the `[tasks.sync]`
entry in `.mise.toml`). There are no up/down migrations — the file is
re-applied start-to-finish on every sync, so **every statement must
be idempotent**. The header comment in `schema.sql` itself documents
the specific patterns the project uses (`if not exists`, `drop policy
if exists` + recreate, guarded `do $$` blocks for things without
native `if not exists` support like `alter publication`).

When you add a column, table, policy, trigger, publication member,
index, extension, etc., the workflow is:

1. Edit `supabase/schema.sql`.
2. Merge to `main`. The `sync-supabase` job in
   `.github/workflows/deploy.yml` runs `node scripts/sync.mjs` on every
   deploy — the same script `mise run sync` runs locally. The workflow
   passes `SUPABASE_PROJECT_REF` (repo variable) and
   `SUPABASE_ACCESS_TOKEN` (repo secret), which puts the script in its
   CI mode: it skips the `.nak/state.json` + interactive project-picker
   path and goes straight to the Management API. The step is gated on
   `vars.SUPABASE_PROJECT_REF != ''` so forks that haven't wired the
   automation up still deploy normally.
3. `mise run sync` is still the way to try a schema change against the
   linked project before opening a PR. The Supabase SQL Editor remains
   a manual fallback if both paths fail.

A schema-apply failure in CI fails the whole deploy on purpose — we'd
rather catch a bad migration than ship an app whose code expects
columns the DB doesn't have.

The sync job also merges the fork's Pages URL into the auth allowlist,
but that's orthogonal to schema — don't dwell on it in PR descriptions
for schema changes.
