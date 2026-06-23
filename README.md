# Nak

[![Tests](https://github.com/sysread/nak/actions/workflows/tests.yml/badge.svg)](https://github.com/sysread/nak/actions/workflows/tests.yml)
[![Deploy](https://github.com/sysread/nak/actions/workflows/deploy.yml/badge.svg)](https://github.com/sysread/nak/actions/workflows/deploy.yml)

Nak is a browser-only, installable chat PWA that talks to **Venice.ai** for
completions and uses **your** Supabase project for auth, persistence, and the
server-side Venice calls. There is no server component operated by the project
author - you fork, deploy to GitHub Pages, point it at a Supabase project you
own, and that project owns every piece of infrastructure it touches.

## Architecture at a glance

- **Frontend**: Svelte 5 + Vite + TypeScript, built as an installable PWA.
- **AI**: Venice.ai's OpenAI-compatible REST API, called from a Supabase
  **edge function** (not from the browser). Streamed chat turns run
  server-side in the function; tokens come back to the browser over a
  Supabase realtime channel and render token-by-token in the UI. Running
  the turn server-side means it survives the tab closing or the PWA
  backgrounding mid-stream.
- **Data/Auth**: Supabase, configured by you, using `supabase-js` with the
  public **publishable key** and Row Level Security.
- **Config storage**: Your Supabase URL and Supabase publishable key are
  stored as **plaintext JSON in `localStorage`**. Neither is a secret: the
  publishable key is meant to ship in client bundles, and the URL is just a
  project identifier. The security boundary is the Supabase sign-in flow plus
  RLS, not key secrecy. The **Venice API key never reaches the browser** - it
  lives server-side in your project's `app_config` table and is read only by
  the edge function.
- **Deployment**: GitHub Pages from any fork, plus the Supabase edge functions
  deployed to your project. The browser's only cross-origin target is your own
  Supabase project (REST + realtime + edge functions), which is configured for
  your `*.github.io` origin, so CORS is a non-issue. The edge function reaches
  Venice server-side, where CORS does not apply.

The author of this repo does not run any infrastructure for you. There is no
shared backend, no shared database, and no API proxy - the "server side" is
edge functions running inside the Supabase project you own.

## Quick start (the wizard)

Three commands, plus two accounts you probably already have.

```sh
# 1. Fork this repo on github.com, then clone your fork.
git clone https://github.com/<you>/nak && cd nak

# 2. Install all tools (Node, pnpm, gh, supabase) via mise.
mise install

# 3. Run the interactive wizard.
mise run setup
```

The wizard will:

1. Log you into `gh` (opens a browser for the OAuth dance).
2. Enable **GitHub Pages** on your fork with Actions as the source.
3. Flip the repo to **read+write workflow permissions**.
4. Log you into `supabase` (opens a browser).
5. Let you **create or link a Supabase project** and apply `schema.sql`.
6. **Seed your Venice API key** directly into the project's `app_config`
   table over Supabase's Management API (get a key at
   <https://venice.ai/settings/api>). Use an **Admin** key so the in-app
   **Usage** view works - billing needs admin scope; chat and embeddings
   work with a standard key. The key is written server-side; it never
   touches the browser.
7. **Seed the edge-function secrets** the Venice function needs (project URL
   and a service-role key, stored in Supabase Vault for the cron backfill to
   authenticate against the function).
8. **Configure auth**: ask whether public sign-ups should be allowed and
   (if so) whether to require email confirmation, then whitelist your
   Pages URL in Supabase Auth URL config. The default - sign-ups **off**,
   confirmation **off** - is the right choice for a personal deployment.
9. **Create the main user** directly on the project via Supabase's admin
   API. The email is pre-confirmed, so you can sign in immediately with
   no email round-trip. (You can skip this if you prefer to manage users
   yourself.)
10. Print a one-shot setup link like
    `https://<you>.github.io/nak/#setup=<blob>`.

Open the link, then sign in with the email and password you just seeded.
That's it. The link pre-fills your Supabase URL and publishable key; click
**Save and continue** and you're at the sign-in screen.

> The `#setup=…` value is a URL **fragment**, which browsers do not send in
> HTTP requests. The app reads it locally, pre-fills the form, and then
> immediately clears it from the address bar.
>
> **The edge functions are required, and they deploy through CI.** The
> wizard seeds the Venice key and Supabase config, but the `venice` edge
> function - which every chat, embedding, and billing call routes through -
> is deployed by the **Deploy** workflow, gated on the `SUPABASE_PROJECT_REF`
> variable and `SUPABASE_ACCESS_TOKEN` secret. Wire those up (see [Keeping a
> project in sync](#keeping-a-project-in-sync)) or the app will have no
> Venice backend to talk to.

### Useful individual tasks

The wizard chains these together, but each one is runnable on its own and is
idempotent (safe to rerun). Run `mise tasks` to see the full list.

| Command                   | What it does                                                  |
| ------------------------- | ------------------------------------------------------------- |
| `mise run doctor`         | Verify prerequisites without changing anything                |
| `mise run pages-enable`   | Enable Pages + flip workflow perms for the current fork       |
| `mise run supabase-init`  | First-time Supabase flow: create/link project, apply schema, seed the Venice key + function secrets, configure auth, seed user |
| `mise run sync`           | Re-apply schema + auth allowlist to the linked project. Prompt-free after first setup. |
| `mise run dev-frontend`   | Vite dev server only (http://localhost:5173); app points at whatever the browser config holds |
| `mise run dev-start`      | Isolated local dev: local Supabase stack + Vite; tears the stack down on exit |
| `mise run dev-stop`       | Stop the local Supabase stack (crash-cleanup fallback)        |
| `mise run build`          | Production PWA build                                          |
| `mise run test`           | Vitest unit tests                                             |

### Manual fallback (no wizard)

If automation fails or you prefer clicking buttons, everything can be done
by hand:

1. **Fork** this repository.
2. **Create a Supabase project** at <https://supabase.com> and note the
   project URL + publishable key from Project Settings → API.
3. **Apply the schema** by pasting [`supabase/schema.sql`](supabase/schema.sql)
   into the Supabase SQL Editor. This creates the `app_config` table, among
   everything else.
4. **Seed your Venice API key** into `app_config` from the SQL Editor:
   `insert into public.app_config (id, venice_api_key) values (true, '<your
   key>') on conflict (id) do update set venice_api_key = excluded.venice_api_key;`.
   Get a key at <https://venice.ai/settings/api> - use an **Admin** key if you
   want the in-app **Usage** view (billing needs admin scope; a standard key
   covers chat and embeddings).
5. **Deploy the edge functions** to your project:
   `supabase functions deploy venice` (plus `attachment-gc` and
   `recipe-image-gc`). The `venice` function is what holds the key and relays
   every Venice call - the app does not work without it.
6. **Whitelist** your `https://<you>.github.io/<repo>/` URL in Supabase
   Authentication → URL Configuration (both Site URL and Redirect URLs).
7. **Configure email auth** in Authentication → Providers → Email:
   - Toggle **Enable sign-ups** off if you're the only user.
   - Toggle **Confirm email** off unless you've configured SMTP.
8. **Create your user** in Authentication → Users → *Add user* →
   *Create new user*. Enter your email and password and tick
   **Auto Confirm User** so you can sign in without an email round-trip.
9. **Enable GitHub Pages** in Settings → Pages → Source = "GitHub Actions".
10. **Allow workflow writes** in Settings → Actions → General → Workflow
    permissions → "Read and write permissions".
11. **Push to `main`** (or dispatch the `Deploy` workflow manually).
12. Open `https://<you>.github.io/<repo>/`, paste your Supabase URL and
    publishable key into the Setup screen, then sign in.

## Security model

The browser never holds a long-lived secret. What's in `localStorage` - the
Supabase URL and publishable key - is safe to expose: the publishable key is
designed to ship in client bundles, and every table has Row Level Security
where the policy is `auth.uid() = user_id` (or a join through it). An attacker
holding the publishable key still has to sign in through Supabase auth to read
any row. The line of defense for your data is the sign-in flow and RLS, not the
secrecy of anything on disk.

**Where the secrets actually live:**

- The **Venice API key** is project-global and stored in the `app_config`
  table. Only the `venice` edge function reads it (with the service role,
  server-side). The browser never sees it, so a compromised tab, a leaked
  `localStorage` snapshot, or a passive malicious extension cannot exfiltrate
  it.
- The Supabase **secret key** (`SUPABASE_SECRET_KEY`, or the legacy
  **service-role key** as a fallback) bypasses RLS. The wizard uses it only
  long enough to seed the schema, the Venice key, the Vault secrets, and the
  main user, then discards it. It is never written to `localStorage`, the
  `#setup=` hand-off link, or anywhere else the browser can reach. Only the
  publishable key ever reaches the browser.

**What this protects against:**

- Exfiltration of your Venice key from the browser - it's not there to steal.
- Cross-user data access - RLS denies it even with a valid publishable key.
- Account creation by strangers, if you picked "sign-ups disabled" during
  setup: anyone who finds the deployed URL cannot create an account; they'd
  need access to your Supabase project to add a user.

**What it does NOT protect against:**

- Active in-page JavaScript with your signed-in session: once you're signed
  in, any script running in the same origin can make Venice calls through the
  edge function and read your rows under your identity. Don't paste
  third-party code into DevTools and don't install untrusted browser
  extensions with access to this origin.
- Supply-chain compromise of the deployed JavaScript or the edge function:
  you're trusting the code you deployed. Pin dependencies and review diffs
  before deploying.
- Physical access to a signed-in device: an attacker who can use the browser
  can simply open the app.
- Network adversaries: TLS to Supabase (and Supabase-to-Venice) protects
  requests in flight. Make sure your OS/browser has current roots.

**Staying signed in:** the Supabase auth session (a JWT + refresh token) is
owned by `supabase-js` and persisted in `localStorage` under
`sb-<project>-auth-token`. You stay signed in until you explicitly sign out or
the refresh token expires - there is no separate app-level lock or password.
A tab-scoped pointer to your last-active thread lives in `sessionStorage` so a
refresh re-opens the same conversation; signing out clears it.

Additionally:

- The app never contacts the Supabase Management API from the browser.
  Schema changes, auth-config updates, the Venice-key seed, and main-user
  creation all happen from `mise run setup` on your local machine (or the
  Deploy workflow's sync job), not from the deployed PWA.

## Models

Nak routes requests through Venice's OpenAI-compatible API, with three
pre-configured tiers so you don't have to memorize model names. Each tier
pairs a Venice model with a default thinking level:

| Tier         | Venice model       | Context | Default thinking | When to use                                 |
| ------------ | ------------------ | ------- | ---------------- | ------------------------------------------- |
| **Smart**    | `qwen-3-7-plus`    | 1M      | Medium           | Best quality; hard problems, native vision. |
| **Balanced** | `deepseek-v4-flash`| 1M      | Light            | Default - solid quality at reasonable speed. |
| **Fast**     | `deepseek-v4-flash`| 1M      | Off              | Quickest replies; same model as Balanced, thinking turned off. |

- Pick your **default tier** in Settings → *Default AI model*. Any thread
  that hasn't set its own model uses this. The default is **Balanced**.
- The thinking level shown above is each tier's **default**, not a lock - the
  composer's reasoning picker stays visible on every reasoning-capable tier,
  so you can bump a single thread up or down for that conversation.
- Override the **tier per thread** from the dropdown at the top of the chat
  view. The choice is sticky - it's saved on the thread row in Supabase, so it
  survives refreshes and carries across devices.
- **Auto-titling**: the first reply in a new thread triggers a one-shot call
  to a small dedicated title model (gpt-oss 20b, via Venice's E2EE tier) to
  generate a short title (3-6 words). It's best-effort - if the call fails,
  the thread keeps its placeholder name. You can always click the title in the
  top bar to rename it by hand.

### What syncs vs what stays local

| Item | Lives where | Shared across devices? |
| ---- | ----------- | ---------------------- |
| Supabase URL / publishable key | local `localStorage` (plaintext JSON) | No - per-device, needed to reach your Supabase project |
| Venice API key | Supabase `app_config` (server-side) | n/a - never in the browser; the edge function reads it |
| Supabase auth session | local `localStorage` (`supabase-js`) | No - sign in on each device |
| **Default model tier** | Supabase `profiles.settings` | **Yes** |
| **Color mode + accent** | Supabase `profiles.settings` + local cache for flash-free boot | **Yes** |
| Per-thread model override | Supabase `threads.model` | Yes |
| Threads and messages | Supabase | Yes |
| Linked Supabase project (wizard) | gitignored `.nak/state.json` | No |

So when you sign into Nak from a second browser, you only re-enter your
Supabase URL and publishable key (or import them from a JSON file exported in
Settings) and sign in - your Venice key is already server-side, and your
default model, color scheme, threads, and per-thread overrides will all
already be there.

### Appearance

Settings → Appearance has two axes:

- **Mode**: Light, Dark, or System (follows your OS's `prefers-color-scheme`).
  System is the default. Dark is a near-black canvas; light is a cream/latte.
- **Accent**: five choices - blue, green, purple, orange, red. Each name has a
  dark-mode pastel variant and a light-mode sharp variant, so switching modes
  keeps the same color identity. All pairings clear WCAG AA contrast. Blue is
  the default.

The choice is cached to `localStorage` for an instant next-load (a small
inline script in `index.html` applies it before first paint), and mirrored
to `profiles.settings` so it follows you to other devices.

### Typography

The UI uses [Lekton](https://github.com/ryanoasis/nerd-fonts/releases)
(Nerd Fonts Mono build), a humanist monospace with a lighter visual
weight than a typical code font. Regular, Italic, and Bold TTFs are
shipped locally under `src/assets/fonts/` (SIL Open Font License; see
the bundled `Lekton_LICENSE.txt`).

### Keeping a project in sync

The Deploy workflow can re-apply your schema, refresh the auth allowlist, and
deploy the edge functions on every push to `main`. **For Nak this is not
optional comfort - the `venice` edge function is what every chat, embedding,
and billing call routes through, and CI is what deploys it.** Wire it up once:

1. In Supabase: click your avatar (top-right) → **Account** →
   **Access Tokens** → **Generate new token**. Name it something
   like `nak-deploy` and copy the value - Supabase only shows it
   once.
2. In your GitHub fork → **Settings** → **Secrets and variables**
   → **Actions**:
   - **Secrets** tab → **New repository secret** → name
     `SUPABASE_ACCESS_TOKEN`, value = the token from step 1.
   - **Variables** tab → **New repository variable** → name
     `SUPABASE_PROJECT_REF`, value = your project ref (the part
     after `/project/` in its Supabase dashboard URL; also visible
     in `.nak/state.json` after `mise run setup`).

From the next deploy onward, every merge to `main` re-applies `schema.sql`,
merges your Pages URL into the auth allowlist, and deploys the `venice`,
`attachment-gc`, and `recipe-image-gc` functions before the site is
rebuilt. A schema or function failure fails the deploy, so you can't ship app
code whose backend is out of sync with it. If you never add these secrets, the
sync and function-deploy steps are skipped - which means no edge functions get
deployed and the app has no Venice backend.

You can also re-apply schema and auth config **manually from your laptop**:
`mise run setup` is the full first-time wizard, and `mise run sync` is the
idempotent re-applier - handy for trying a schema change against the linked
project *before* opening a PR. Note that `mise run sync` does **not** deploy
the edge functions; only the Deploy workflow does that.

### Schema columns added over time

The schema grows by `ADD COLUMN IF NOT EXISTS` rather than migrations, so
`mise run sync` is always safe to re-run. A representative slice:

- `threads.model text` - per-thread model tier override.
- `threads.reasoning_effort text` - per-thread thinking-level override
  (`off` | `low` | `medium` | `high`).
- `threads.verbosity text` - per-thread `text.verbosity` override.
- `profiles.settings jsonb` - per-user preferences (default model tier,
  default thinking, default verbosity, color mode, accent).
- `app_config` - the project-global, single-row table holding the shared
  Venice API key.

## Development

This project uses [mise](https://mise.jdx.dev/) to pin Node and pnpm.

```sh
# One-time: install mise, then inside the repo:
mise install
pnpm install

# Dev server (hot reload)
pnpm dev

# Type check
pnpm check

# Unit tests
pnpm test

# E2E tests (builds and previews, then drives Chromium)
pnpm test:e2e

# Production build
pnpm build
pnpm preview
```

Architecture and per-feature notes live under [`docs/dev/`](docs/dev/README.md);
[`docs/dev/architecture.md`](docs/dev/architecture.md) is the place to start.

### Running against a local Supabase

You can point the app at a local Supabase stack (`supabase start`) just by
entering its URL and publishable key during initial setup. Apply `schema.sql`
via `supabase db reset` or the local SQL editor, seed `app_config` with a
Venice key, and serve the edge functions locally (`supabase functions serve`).

## Project layout

```text
src/
  lib/
    config.ts         plaintext Supabase URL + publishable key in localStorage
    venice.ts         browser-side Venice wire shape; posts to the edge function
    supabase.ts       auth, thread/message CRUD, and Venice relays (complete/embed)
    models/           tier + agent-role model registry
    state.svelte.ts   top-level reactive app state + phase machine
  screens/
    Setup.svelte      Supabase URL + publishable key entry (reads #setup= hash)
    Auth.svelte       Supabase email/password sign in/up
    Chat.svelte       thread list + streaming message view
    Settings.svelte   default model, appearance, system prompts, config export
  App.svelte          phase router (loading -> setup | unlocked)
  main.ts             entry
scripts/
  bootstrap.mjs       the wizard (mise run setup)
  doctor.mjs          prerequisite checks
  setup-pages.mjs     enable GitHub Pages
  setup-supabase.mjs  create/link project, schema, Venice key, secrets, auth, user
  sync.mjs            idempotent schema + auth-allowlist re-apply (mise run sync)
  lib/                shared helpers (ui, shell, github, supabase, repo)
supabase/
  schema.sql          RLS schema applied by the wizard
  functions/venice/   edge function: holds the Venice key, relays every call
.github/workflows/    CI, plus the Deploy workflow (schema sync + function deploy + Pages)
tests/                Vitest unit tests
e2e/                  Playwright E2E tests
```

## License

MIT - see [LICENSE](LICENSE).
