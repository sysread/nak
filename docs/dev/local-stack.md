# Local dev stack

## Role

An isolated, ephemeral local dev environment, with no risk of
touching a linked cloud project. Nak's only backend is one
Supabase project, and the app reads its endpoint from runtime
config (encrypted localStorage entered via Setup), not a
build-time env var - so there is no built-in isolation. Point
the app at your cloud project and every schema experiment
mutates it. `mise run dev-start` makes the isolated thing the
easy thing: one foreground command brings up a disposable
Postgres + Auth + Realtime (+ Storage) on localhost, applies
`supabase/schema.sql`, seeds a login, writes a credentials file
the app can import, and runs Vite - then stops the stack when
you exit. Pointing at the real project is still possible, but
only as a deliberate manual act (enter the prod keys in the
app's settings UI).

There is no local Postgres anywhere else in the project. `mise
run dev-frontend` is just Vite serving the SPA; it applies no
schema and talks to whatever Supabase URL your imported config
points at.

## Files

- [`scripts/dev-local.mjs`](../../scripts/dev-local.mjs) - the
  provisioner + lifecycle owner behind `mise run dev-start`.
- [`supabase/config.toml`](../../supabase/config.toml) - the
  CLI stack definition (`supabase init` output; `project_id =
  "nak"`). Ports: API 54321, DB 54322, Studio 54323, Mailpit
  54324.
- `nak-local-config.json` - generated, git-ignored, plaintext.
  The importable credentials (see Entry points).

## Entry points

- `mise run dev-start` - bring up the stack, provision it, run
  Vite in the foreground, and stop the stack on exit. Reuses an
  already-running stack (and still stops it on exit). Idempotent
  provisioning, so reuse and restart are safe.
- `mise run dev-stop` - `supabase stop`. The crash-cleanup
  fallback for a `dev-start` that exited without tearing down.
  Data preserved; add `--no-backup` for a clean wipe.

First run pulls several GB of Docker images and is slow once.

### Lifecycle

`dev-start` owns the stack for the session. On exit - Ctrl-C, a
Vite crash, or a kill signal - it runs `supabase stop`, so the
setup never outlives the command. `supabase stop` preserves the
database between sessions (only the containers go down), so dev
data survives a restart. The Vite server runs as a child with
inherited stdio; Ctrl-C reaches both it and the script, and a
once-only guard makes teardown run exactly once whether the
signal or the child's exit triggers it.

### The import handoff

The app already has a Setup -> Import from JSON flow
(`parseExportedConfig` in
[`src/lib/config.ts`](../../src/lib/config.ts)) that accepts
`{kind:"nak-config", version:2, supabaseUrl,
supabasePublishableKey}`. `dev-start` writes exactly that shape, so the
handoff needs no app code. It is a one-time act per browser -
the local publishable key and the config file are stable across
sessions:

1. In the app (Vite is already running): Setup -> Import from
   JSON -> pick `nak-local-config.json`.
2. Click Save and continue - the imported values are stored as
   plaintext JSON in this browser (neither is a secret) and the
   file is left untouched.
3. Log in with the seeded credentials (default
   `dev@nak.local` / `devpass123`).

## How it works

1. **Preflight.** mise provisions the supabase CLI, but nothing
   can provision the Docker daemon - so the script checks
   `docker info` and bails with a fixable message if it is down.
2. **Ensure stack.** Probe `supabase status -o json`; reuse if
   up, otherwise `supabase start`.
3. **Schema.** `psql` applies `supabase/schema.sql` straight,
   as the postgres superuser, with `ON_ERROR_STOP=1`. Single
   source of truth - the same file the cloud deploy re-applies.
   There are deliberately no `supabase/migrations`; splitting
   the schema into a migrations tree would fork it.
4. **Seed login.** GoTrue admin API creates a confirmed user,
   which fires the `on_auth_user_created` trigger and
   materializes the `profiles` row the app expects.
5. **Config file.** Writes `nak-local-config.json`.
6. **Watch the schema.** A directory watch on `supabase/` re-runs
   the schema apply whenever `schema.sql` changes (see below).
7. **Run Vite, then tear down.** Spawns the dev server in the
   foreground and stops the stack when it exits.

### Live schema re-apply

While `dev-start` runs, editing `supabase/schema.sql` re-applies
it to the local stack automatically (debounced) - the local
counterpart of running `mise run sync` after a schema change, but
without sync's cloud-only steps (project resolution and the
Pages-URL auth-allowlist merge have no local meaning). The
re-apply is additive-idempotent, so a failure is non-fatal: the
dev session keeps running and the next save retries. The
destructive-change caveat carries over from the cloud sync model -
a re-apply adds new objects but does not drop a column you removed
from the file; that needs a wipe (`supabase stop --no-backup`).
Frontend code is already live via Vite HMR; this brings the schema
layer to the same immediacy.

### Overrides

- `NAK_DEV_EMAIL` / `NAK_DEV_PASSWORD` - seeded login.
- `VENICE_API_KEY` - skips the interactive Venice prompt (useful
  for non-interactive runs).

## Gotchas

- **Docker is the hard prerequisite.** The stack is a Docker
  Compose bundle. mise cannot provision a daemon, so this is
  local-CLI only - the cloud agent has no Docker and gets no
  benefit. `dev-start` fails fast with a fixable message when
  Docker is down.
- **The local stack does not proxy Venice.** The app calls
  Venice directly with whatever key the imported config carries.
  Login works without a key; chat and embeddings do not. Supply
  `VENICE_API_KEY` or answer the prompt; a blank answer writes a
  `REPLACE_WITH_VENICE_KEY` placeholder you edit before
  importing.
- **schema.sql creates its extensions before first use.**
  `pgcrypto` and `vector` are created up top, ahead of the
  `vector(2048)` columns further down. This matters for a clean
  apply: hosted Supabase enables `vector` by default so a cloud
  re-apply never depended on the ordering, but a fresh local DB
  fails with `type "vector" does not exist` if the extension is
  not created first. Keep new extension dependencies declared
  before their first use for the same reason.
- **The script refuses any non-loopback target.** It reads its
  endpoints from `supabase status` and asserts both the DB and
  API hosts are loopback before applying the schema or seeding a
  user. A dev machine commonly has prod credentials in its
  environment (direnv injecting a Supabase access token), so the
  guard is on the endpoint itself, not on trusting the env to be
  clean. Note that `dev-start` does bake the ambient
  `VENICE_API_KEY` into the config file when set - that is the
  real key, used because the local app calls Venice directly.
- **`nak-local-config.json` is a secret.** Plaintext, carries
  the Venice key, git-ignored. Same design as the app's own
  config export.
- **The cloud sync path is untouched.** `scripts/sync.mjs` and
  `mise run supabase-init` still target the linked project via
  the Management API. This stack is additive isolation, not a
  replacement.

## Edge functions in the local stack

The script wires the edge functions into the local stack:

- **`app_config` seeding.** `dev-start` mirrors the Venice key
  into the `app_config` table so the shared-key path the
  function reads at request time works against the local stack.
  Guarded in SQL via `to_regclass`, so the seed is a no-op on a
  branch without the table.
- **`supabase functions serve`.** When `supabase/functions/*/`
  files exist, `dev-start` runs `supabase functions serve` as a
  second supervised child, torn down with everything else on
  exit. `serve` hot-reloads the Deno code on edit, so functions
  need no watcher of their own - unlike the schema, they are
  served, not applied. The serve child is a supporting service,
  not the lifecycle driver: if it dies on its own the session
  keeps running (the frontend is unaffected) and a warning
  prints; restart `dev-start` to resume functions. Per-function
  `verify_jwt` and import maps come from `config.toml`;
  `dev-start` passes no overriding flags. See
  `supabase/functions/README.md` for the function-side layout.

## Interactions

- [Auth & session](./auth-session.md) - the imported config and
  the seeded GoTrue user feed the plaintext local config and the
  Supabase session lifecycle.
- [Build & deploy](./build-deploy.md) - the cloud counterpart:
  the sync-on-deploy workflow that applies the same
  `schema.sql` to the linked project.
- [Embeddings](./embeddings.md) - the first consumer of the
  edge-functions shared key; the `app_config` seed above keeps
  its local-vs-shared path testable.
