# CLAUDE.md

Guidance for Claude Code / Claude sessions working in this repo. See `README.md` for the human-facing documentation.

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

## Commit / branch / merge conventions

See the standing instructions given at session start for branch names and
merge policy. In short: develop on the designated feature branch, fast-forward
into `main` when done, and clean up the feature branch when safely merged.

Commit messages follow the project's narrative style: a short imperative
summary line, then a paragraph or two explaining *why*. Match the tone of
recent commits (`git log --oneline`).

## Running the checks locally

```sh
pnpm check   # svelte-check: TypeScript + Svelte type-check
pnpm lint    # ESLint
pnpm test    # Vitest unit tests
pnpm test:e2e  # Playwright E2E (slow; CI runs this)
```

Always run `check` and `test` before committing — including for
CSS-only changes. The test suite includes a postcss parse of every
stylesheet under `src/` (see `tests/styles.test.ts`), which is the
only local gate that catches a malformed rule before `pnpm build` /
the Pages deploy rejects it.
