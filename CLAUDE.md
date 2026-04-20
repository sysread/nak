# CLAUDE.md

Guidance for Claude Code / Claude sessions working in this repo. See `README.md` for the project-level overview, `docs/user/README.md` for the end-user manual (also rendered in-app via the **Help** button), and `docs/dev/README.md` for architecture + per-feature dev notes.

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

Match the prevailing style in `src/lib/*.ts`. Complete sentences. Em-dashes
for "here's the reason" tangents. Name symptoms by their observable behavior
rather than by internal jargon.

Good:

```ts
// U+FE0F forces emoji-style presentation — without it, U+2696 SCALES
// renders as a thin text glyph that reads as near-invisible against
// the toggle background.
```

```ts
// Best-effort: ask the fast model for a short title for this thread.
// Runs after the first user+assistant round-trip. Any failure is
// swallowed — the thread simply keeps the default title.
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

See the standing instructions given at session start for branch names and
merge policy. In short: develop on the designated feature branch, fast-forward
into `main` when done, and clean up the feature branch when safely merged.

Commit messages follow the project's narrative style: a short imperative
summary line, then a paragraph or two explaining *why*. Match the tone of
recent commits (`git log --oneline`).

## Running the checks locally

```sh
mise run check        # full local gate: tests + svelte-check + ESLint
mise run test         # vitest only (includes the markdownlint guardrail)
mise run markdownlint # markdownlint-cli2 only (fast iteration on docs)
```

`mise run check` is what CI runs (see `.github/workflows/tests.yml`),
so a green `mise run check` locally is a green CI job. The individual
pnpm targets still work — `pnpm check`, `pnpm lint`, `pnpm test`,
`pnpm test:e2e` — but prefer the mise tasks so dev + CI stay on the
same entry point.

Always run the gate before committing — including for CSS- or
markdown-only changes. The test suite includes a postcss parse of
every stylesheet under `src/` (see `tests/styles.test.ts`) and a
markdownlint-cli2 pass over the doc tree (see
`tests/markdownlint.test.ts`). Both only surface at `pnpm build` /
the Pages deploy otherwise.

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
