# Build & deploy

Vite + vite-plugin-pwa, GitHub Pages hosting, a sync-on-deploy
step that applies `supabase/schema.sql` to the linked Supabase
project. This is the full build / CI / deploy picture —
nothing hidden.

## Role in the app

The repo is a standard Vite project. `pnpm dev` spins a local
server; `pnpm build` emits static assets (with a service
worker) under `dist/`; GitHub Actions takes that output and
publishes it to GitHub Pages. A parallel CI step re-applies
the canonical schema to Supabase before the build, so a
schema-dependent code change can't ship against a stale DB.

The app is a PWA — install it from the browser address bar
and it opens as a standalone window. Offline caching is
automatic for every bundled asset, including the user-facing
docs imported via `import.meta.glob`.

## Files

- `vite.config.ts` — Vite + Svelte 5 + PWA plugin + Vitest
  config. `base` is overridable via `VITE_BASE` for GitHub
  Pages forks.
- `package.json` — scripts (`dev`, `build`, `check`, `lint`,
  `test`, `test:e2e`, `preview`). `pnpm` is the package
  manager of record.
- `supabase/schema.sql` — single source of truth for the
  database. Applied by `mise run sync` (local) and by the
  `sync-supabase` CI job.
- `scripts/sync.mjs` — the sync script. Interactive for
  `mise run sync`; non-interactive when `SUPABASE_PROJECT_REF`
  + `SUPABASE_ACCESS_TOKEN` are in the env (CI mode).
- `.mise.toml` — tool pinning (node, pnpm, supabase CLI) and
  task definitions (`mise run sync`, `mise run setup`, etc.).
- `.github/workflows/tests.yml` — runs `pnpm check / lint /
  test` on every push + PR.
- `.github/workflows/deploy.yml` — triggered by a successful
  Tests run on `main`; runs the Supabase sync, builds, and
  publishes to Pages.

## Entry points

- **`pnpm dev`** — Vite dev server at `http://localhost:5173`.
  HMR handles source edits; changes to `docs/user/*.md`
  hot-reload too because they're imported via
  `import.meta.glob`.
- **`pnpm build`** — production build into `dist/`. Emits one
  lazy chunk per user-doc markdown file plus the PWA artifacts
  (`sw.js`, `workbox-*.js`, `manifest.webmanifest`).
- **`pnpm preview`** — serves the built `dist/` on
  `http://localhost:4173`. Use for a PWA smoke test (the dev
  server does not emit a service worker).
- **`mise run sync`** — applies `supabase/schema.sql` to the
  linked project + merges the Pages URL into the auth
  allowlist. Interactive on first run (picks a project,
  writes `.nak/state.json`); idempotent after.
- **Push to `main`** — triggers Tests → Deploy. The deploy
  runs sync-supabase → build → publish.

## Data model

- **`public/`** — files Vite copies verbatim to the build
  root. Currently just `icon.svg`.
- **`docs/user/**/*.md`** — bundled via `import.meta.glob`
  (see `./help.md`). NOT under `public/`; they go through
  the module graph and land as lazy chunks under
  `dist/assets/*.js`.
- **`docs/dev/**/*.md`** — NOT bundled. GitHub-rendered only.
- **`.nak/state.json`** — local scratch for sync.mjs's
  project-resolution state. Gitignored.
- **GitHub Pages deployment** — served at
  `https://<user>.github.io/<repo>/` by default; user/org
  pages at `https://<user>.github.io/` use `VITE_BASE=/` in
  repo vars.
- **Repo secrets / vars consumed by CI** —
  `SUPABASE_PROJECT_REF` (var), `SUPABASE_ACCESS_TOKEN`
  (secret), `VITE_BASE` (var, optional).

## Contracts

- **Idempotent schema.** Every statement in
  `supabase/schema.sql` uses `create if not exists` /
  `add column if not exists` / `drop policy if exists` +
  recreate / guarded `do $$` for `alter publication`. A
  schema change that isn't idempotent is a bug — the next
  `mise run sync` errors at someone else's statement, not
  yours.
- **Tests gate the deploy.** Deploy workflow triggers on
  `workflow_run` of Tests with `conclusion: success`. A
  failing test won't ship.
- **Sync-supabase gates the build.** `needs: sync-supabase`
  on the build job means a schema-apply failure halts the
  deploy before the build runs. Better to fail than ship
  against a stale DB.
- **Fork-friendly sync gating.**
  `if: vars.SUPABASE_PROJECT_REF != ''` on the sync step.
  A fresh fork that hasn't wired the Supabase automation
  yet still deploys normally; the sync step is a no-op.
- **`VITE_BASE` computation in CI.** The deploy workflow
  computes `/<repo>/` for project pages and `/` for
  user/org pages. The repo root makes it a project page;
  `<user>.github.io` is the user-page exception.
- **Service worker cache scope.** `globPatterns:
  **/*.{js,css,html,svg,png,ico,woff2}` — every bundled
  asset is precached. `/api/*` is denied-listed so the
  SW never intercepts user-API traffic.

## Interactions with other features

- **Every feature** — the build ships every feature, and
  the sync job applies schema changes that every
  data-touching feature depends on. A broken schema
  migration halts the deploy; a broken build halts the
  publish.
- **Help** — Vite's `import.meta.glob` is what makes the
  user docs ship with the PWA. Each doc file becomes its
  own lazy chunk in `dist/assets/`. See `./help.md`.
- **Architecture (schema conventions)** — every load-
  bearing schema pattern (idempotent alters, RLS
  policies, claim RPCs, partial claim indexes) is
  enforced here on deploy. See `./architecture.md`.

## Gotchas

- **`pnpm dev` does not emit a service worker.** The PWA
  plugin only wires the SW in `build` + `preview` modes.
  Testing offline behavior or install prompts requires
  `pnpm build && pnpm preview`.
- **`registerType: 'autoUpdate'`** — the SW updates in the
  background and reloads to a new version on next
  navigation. Users don't see a prompt; bugs in a shipped
  version can't be "fixed by hard-refresh" once cached.
  Think twice before shipping something you're not sure
  about.
- **`navigateFallbackDenylist: [/^\/api/]`** is a Workbox
  setting — it prevents the SW from hijacking paths that
  start with `/api`. Nak doesn't ship an `/api` of its
  own, but Venice's SDK shape and user-configurable
  Supabase hosts could one day land there; the denylist is
  defensive.
- **Schema re-applies on every deploy.** Not a migration
  per deploy — the whole file runs top-to-bottom. This is
  why every statement must be idempotent. A developer who
  writes a `create table foo (...)` without
  `if not exists` breaks the next deploy for everyone.
- **The deploy job has no rollback story.** A bad schema
  change that accidentally drops a column is permanent —
  `drop column if exists` is valid SQL, it just runs. Get
  destructive changes reviewed before merging.
- **`VITE_BASE=./` default.** Works for local dev and most
  Pages deployments. A fork hosting elsewhere (Cloudflare
  Pages, Netlify) likely wants `/` — set it in repo vars.
- **Supabase CLI is required for `mise run sync` locally
  but not in CI.** CI talks to the Management API
  directly via tokens. Fresh local installs without the
  CLI get an error; `mise install` fixes it.
- **The deploy workflow uses `workflow_run`, not
  `workflow_call`.** Means Tests still runs on its own
  (its badge reflects real runs) and the Deploy only
  fires on success. Re-running a failed deploy doesn't
  re-run tests — fix the tests, push, let them succeed,
  and the deploy retriggers automatically.
- **`public/icon.svg` is the only icon.** The manifest
  declares `sizes: 'any'` + `purpose: 'any maskable'`, so
  one SVG covers every device. Don't add PNG fallbacks
  unless you hit a real UA incompatibility — maintaining
  raster icons at multiple sizes is a drag.

## Where to go next

- `./architecture.md` — the data-layer conventions the
  schema enforces.
- `./help.md` — the user-docs bundling path.
- `supabase/schema.sql` — the canonical schema, commented
  extensively.
