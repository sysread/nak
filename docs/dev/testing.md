# Testing

How the test suites are wired, what each one exists to catch, and
the setup details that are easy to trip over.

## Role in the app

There are **three independent test islands**, and they do not see
each other:

1. **vitest** (`tests/*.test.ts`) - the main-thread suite. Pure
   logic, UI-behavior primitives, and component mounts.
2. **Deno** (`supabase/functions/tests/`) - the edge functions have
   their own toolchain and are invisible to vitest.
3. **Playwright** (`e2e/*.spec.ts`) - browser-driven end-to-end
   specs, run on demand rather than in the gate.

The vitest suite also carries two **guardrail tests** that are not
really unit tests: a postcss parse of every stylesheet, and a
markdownlint pass over the doc tree. Both exist because their
failure modes otherwise surface only at deploy time or as a
silently-wrong render.

## Files

- `vite.config.ts` - the `test` block: environment split, setup
  file, include/exclude globs, integration-test gating.
- `tests/setup.ts` - `setupFiles` for **every** vitest file, node
  and jsdom alike.
- `tests/styles.test.ts` - postcss parse of every stylesheet under
  `src/`.
- `tests/markdownlint.test.ts` - markdownlint over the tracked
  markdown.
- `playwright.config.ts`, `e2e/` - the browser specs.
- `.mise.toml` - the gate task graph (`check` and its parallel
  dependencies).
- `supabase/functions/deno.json` - import map the Deno tasks point
  at.

## The vitest environment split

**`environment: 'node'` is the default. jsdom is opt-in, per file,
by name.**

```ts
environment: 'node',
environmentMatchGlobs: [
  ['tests/ascii-spinner.test.ts', 'jsdom'],
  // ...
],
```

Most test files are pure logic with no DOM dependency, and jsdom
costs roughly **350ms of bootstrap per file**. With ~128 test files
that was tens of seconds of aggregate environment time and 4-5s of
wall clock on every run. Listing the dozen files that genuinely need
a DOM buys that back.

**When you add a test that mounts a component or touches a DOM
global, add it to `environmentMatchGlobs` in the same change.**
Things that need jsdom: component mounts (`@testing-library/svelte`),
`localStorage` / `sessionStorage`, the history API, DOMPurify,
`fake-indexeddb`.

### Why this bites on a branch that forked before the split

The list enumerates files **by name**, so it cannot know about a
file that did not exist when it was written. That makes the failure
invisible to every signal a branch normally trusts:

- the test passes locally if the branch forked while jsdom was still
  the default;
- the rebase is clean, because the two changes touch different
  files;
- the gate is green before the rebase, and `git` reports no
  conflict after it.

It then fails in CI with `ReferenceError: document is not defined`.

The inline comment in `vite.config.ts` tells you to add the file
*once you see that error*, which is the right instruction for a
fresh branch and useless for a rebased one. Treat "did I add a DOM
test?" as a rebase checklist item, not something the tooling will
remind you about.

To confirm an entry is actually load-bearing rather than
cargo-culted, delete it and run the file - a CLI
`--environment node` flag will **not** override
`environmentMatchGlobs`, so the flag alone proves nothing.

## `tests/setup.ts`

Runs for every file in both environments, so everything in it is
either environment-agnostic or guarded:

- **`@testing-library/jest-dom/vitest`** is imported here rather
  than per file, so any component test gets
  `expect(el).toBeInTheDocument()` without a local import.
- **`globalThis.crypto`** is polyfilled from `node:crypto` if absent
  or missing `subtle`.
- **`Element.prototype.animate`** is shimmed because jsdom does not
  implement it and Svelte's `slide` / `fade` transitions call it.
  Guarded on `typeof Element !== 'undefined'` so the node
  environment skips it. The shim only needs `cancel()` for Svelte's
  lifecycle to clean up; the animation is a no-op, which is fine
  because tests assert on state, not interpolated styles.

## Guardrail tests

Neither of these tests a feature. Both exist because a green Tests
job used to be compatible with a broken deploy.

- **`tests/styles.test.ts`** runs postcss over every stylesheet
  under `src/`. A stray `}` in `src/styles.css` once got through:
  Vite's dev server kept rendering, `pnpm check` and `pnpm test`
  do not parse CSS, and the error surfaced only at `pnpm build` -
  in the deploy workflow, after Tests had gone green.
- **`tests/markdownlint.test.ts`** runs markdownlint-cli2's
  programmatic `main()` (not a child process) over the tracked
  markdown. Docs render in three places - GitHub, the in-app Help
  modal, and Claude sessions reading `CLAUDE.md` - and a broken
  fence ladder shows up as a wrong render rather than a loud
  failure.

**Consequence: run the suite for CSS-only and markdown-only
changes too.** There is no such thing as a change too cosmetic for
the gate.

## Integration tests

Files matching `tests/**/*.integration.test.ts` hit live Venice and
are **excluded unless `VENICE_INFERENCE_KEY` is set**:

```sh
VENICE_INFERENCE_KEY=<key> pnpm test tests/web-search.integration.test.ts
```

Presence of the key **is** the opt-in - there is no separate flag to
remember. The default `pnpm test` stays hermetic, so CI never
depends on outbound network or a credential.

## The Deno island

The edge functions run on their own toolchain and are invisible to
vitest. Two tasks cover them, and the gate runs both:

- **`mise run functions-test`** - offline unit tests (fake fetch, no
  network, no Supabase) over the pure logic in `_shared`. Handler
  glue is exercised via `dev-start`'s `functions serve`, not here.
- **`mise run functions-check`** - `deno check` over every function
  **entrypoint**.

`functions-check` is the one that is easy to think redundant and
is not. `deno test` only type-checks the graph its tests import,
and `supabase functions deploy` bundles with esbuild and never
type-checks at all. Without the entrypoint check, a type error in a
handler-graph corner no test imports surfaces **nowhere** and ships
latent.

It `depends = ["bundle-docs"]` because the venice function imports
the gitignored research-docs corpus, which does not exist on a
fresh clone until the bundler runs.

## Playwright

`playwright.config.ts` plus `e2e/` (`setup.spec.ts`,
`setup-hash.spec.ts`), run with `pnpm test:e2e`. **Not in the
gate** - they drive a real browser against a running stack.

Cloud agent sessions cannot run these, or verify anything visual;
see the "Verifying UI changes" section of `CLAUDE.md` for the
posture that replaces them there.

## Test-only exports

Production modules expose internals to tests through a single
`__test = { ... }` namespace export at the bottom of the file
rather than widening their real API one symbol at a time. See
`src/lib/session.ts`, `src/lib/routing.svelte.ts`,
`src/lib/offline-sync.svelte.ts`, `src/lib/pdf-pages.ts`.

Knip runs in the gate, so an export with no external consumer is a
gate failure, not a lint suggestion.

## Contracts

- **The gate is `mise run check`**, and it is what
  `.github/workflows/tests.yml` runs, so green locally means green
  CI. Its components are parallel `depends`, not a serial `run`
  list, so all of them report even when one fails.
- **Every gate task `depends = ["deps"]`**, which runs `pnpm
  install --frozen-lockfile`. No separate install step from a fresh
  clone or worktree.
- **UI-behavior primitives are tested as plain vitest cases** - no
  mount, no harness. That is the point of extracting them out of
  `.svelte` files; see `./frontend-organization.md`.
- **New DOM-touching test files register in
  `environmentMatchGlobs`.**

## Interactions with other features

- **Build & deploy** - the gate exists to keep a green Tests job
  from landing a change that breaks the deploy. `pnpm build` is in
  the gate for exactly that reason, and the two guardrail tests
  close the CSS and markdown versions of the same hole. See
  `./build-deploy.md`.
- **Frontend organization** - the extract-primitives-to-
  `src/lib/ui/` rule is what keeps most of the suite in the fast
  node environment; logic that stays in a `.svelte` file can only
  be tested by a jsdom mount. See `./frontend-organization.md`.
- **Help** - `tests/markdownlint.test.ts` guards the docs the Help
  modal renders. See `./help.md`.
- **Local dev stack** - edge-function handler glue is exercised
  against `dev-start`'s `functions serve`, not by
  `functions-test`. See `./local-stack.md`.
- **Every feature with a QA walkthrough** - `docs/qa/use-cases/`
  covers the seams these suites cannot reach. See
  `docs/qa/README.md`.

## Gotchas

- **A CLI `--environment` flag does not override
  `environmentMatchGlobs`.** Passing
  `--environment node` to a file that is on the jsdom list still
  gets jsdom. To test what an unlisted file would do, remove the
  entry.
- **`mise` may not resolve its tools in a restricted sandbox, and
  the error it prints is a red herring.** You get
  `aqua:charmbracelet/gum@latest: no versions found for
  aqua:charmbracelet/gum matching date filter`, which fails
  `mise run check` before any gate task runs. **There is no date
  filter.** aqua reads version lists from the GitHub releases API,
  and a session whose GitHub access is scoped to this repo alone
  gets denied for `charmbracelet/gum` and `cli/cli`; mise reports
  the resulting empty list with that phrasing. Do not go looking
  for a cutoff setting - `mise settings` has none.

  Note the blast radius is wider than the tools involved: **mise
  resolves the entire `[tools]` set before running any task**, so
  `gum` and `gh` - which only `supabase-init`, `doctor`,
  `bootstrap`, and `setup-pages` use, and which already degrade
  gracefully when absent - block the gate, which needs neither.
  Removing one would not help while the other remains.

  The fallback is the raw pnpm sequence (`pnpm install && pnpm test
  && pnpm check && pnpm lint && pnpm build && pnpm knip`) - note it
  must include `knip`, which is part of the gate. That sequence skips
  the Deno island, so a change touching `supabase/functions/` is not
  fully covered by it.
- **Piping a gate command replaces its exit code** with the pipe
  tail's, so a failed gate reads as success and a chained `git
  commit` runs anyway. Capture the status explicitly or run the
  gate un-piped. See the `CLAUDE.md` section on this - it has
  shipped broken commits twice.
- **Exit 0 is necessary but not sufficient.** `pnpm build` emits
  Rollup warnings that do not fail the gate but do signal real
  problems - grep the output for `(!)` when doing bundle-shape
  work.
- **A script-less `.svelte` file has no inferable component type.**
  svelte-check fails its importers with "Could not find a
  declaration file for module ... implicitly has an 'any' type".
  A component that needs no props still needs an empty
  `<script lang="ts">` block; `src/components/SleepSpinner.svelte`
  carries one with a comment against deletion.
- **The Rollup chunk-size warning is pre-existing.** The threshold
  is `chunkSizeWarningLimit: 750` in `vite.config.ts`, and a clean
  tree already trips it.
  Do not treat it as introduced by your change without checking a
  clean tree first.

## Where to go next

- [`./build-deploy.md`](./build-deploy.md) - what the gate is
  protecting.
- [`./frontend-organization.md`](./frontend-organization.md) - why
  most logic is testable without a mount.
- [`./local-stack.md`](./local-stack.md) - running the edge
  functions for real.
- [`../qa/README.md`](../qa/README.md) - the manual walkthroughs
  that cover what these suites cannot.
