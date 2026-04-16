# BYO Chat PWA

A browser-only, installable chat app that talks to **Venice.ai** for completions
and uses **your** Supabase project for auth and persistence. There is no server
component operated by the project author — you fork, deploy to GitHub Pages,
and own every piece of infrastructure it touches.

## Architecture at a glance

- **Frontend**: Svelte 5 + Vite + TypeScript, built as an installable PWA.
- **AI**: Venice.ai REST API, called directly from the browser. Chat responses
  stream via SSE and render token-by-token in the UI.
- **Data/Auth**: Supabase, configured by you, using `supabase-js` with the
  public anon key and Row Level Security.
- **Config storage**: Your Supabase URL, Supabase anon key, and Venice API key
  are encrypted with a master password using AES-256-GCM via the Web Crypto
  API (PBKDF2-SHA256, 600k iterations) and stored only in `localStorage`. No
  plaintext secrets are ever written to disk.
- **Deployment**: GitHub Pages from any fork. Because requests originate from
  your `*.github.io` subdomain and go directly to your Supabase and Venice
  endpoints, CORS is natively correct.

The author of this repo does not run any infrastructure for you. There is no
shared backend, no database, and no API proxy.

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
6. **Whitelist your Pages URL** in Supabase Auth URL config.
7. Prompt for your **Venice API key** (get one at <https://venice.ai/settings/api>).
8. Print a one-shot setup link like
   `https://<you>.github.io/nak/#setup=<blob>`.

Open the link, set a master password, and you're in. That's it.

> The `#setup=…` value is a URL **fragment**, which browsers do not send in
> HTTP requests. The app reads it locally, pre-fills the form, and then
> immediately clears it from the address bar. Still — treat it like a
> password until you've set your master password.

### Useful individual tasks

The wizard chains these together, but each one is runnable on its own and is
idempotent (safe to rerun). Run `mise tasks` to see the full list.

| Command                   | What it does                                                  |
| ------------------------- | ------------------------------------------------------------- |
| `mise run doctor`         | Verify prerequisites without changing anything                |
| `mise run pages-enable`   | Enable Pages + flip workflow perms for the current fork       |
| `mise run supabase-init`  | Create/link a Supabase project, apply schema, whitelist URL   |
| `mise run dev`            | Vite dev server (http://localhost:5173)                       |
| `mise run build`          | Production PWA build                                          |
| `mise run test`           | Vitest unit tests                                             |

### Manual fallback (no wizard)

If automation fails or you prefer clicking buttons, everything can be done
by hand:

1. **Fork** this repository.
2. **Create a Supabase project** at <https://supabase.com> and note the
   project URL + `anon` key from Project Settings → API.
3. **Apply the schema** by pasting [`supabase/schema.sql`](supabase/schema.sql)
   into the Supabase SQL Editor.
4. **Whitelist** your `https://<you>.github.io/<repo>/` URL in Supabase
   Authentication → URL Configuration.
5. **Get a Venice API key** at <https://venice.ai/settings/api>.
6. **Enable GitHub Pages** in Settings → Pages → Source = "GitHub Actions".
7. **Allow workflow writes** in Settings → Actions → General → Workflow
   permissions → "Read and write permissions".
8. **Push to `main`** (or dispatch the `Deploy` workflow manually).
9. Open `https://<you>.github.io/<repo>/`, paste the three values into the
   Setup screen, and pick a master password.

## Security model

The master password protects the config blob in `localStorage` from attackers
who gain *read-only* access to the browser's storage — for example, someone
who snapshots the `localStorage` contents or reads them through a passive
malicious extension. Concretely:

**What the master password protects against:**

- Plaintext exfiltration of your API keys from disk backups or another user
  of the same OS account who can read `localStorage` files.
- Casual inspection of the stored blob (it's an AEAD-encrypted ciphertext
  keyed from your password, not a stored plaintext).
- Ciphertext tampering — AES-GCM authenticates the full payload, so any
  modification causes decryption to fail.

**What it does NOT protect against:**

- Active in-page JavaScript: once unlocked, the decrypted config is held in
  memory so the app can make API calls. Any script running in the same
  origin can read it. Don't paste third-party code into DevTools and don't
  install untrusted browser extensions with access to this origin.
- Supply-chain compromise of the deployed JavaScript: you're trusting the
  code you deployed. Pin dependencies and review diffs before deploying.
- Physical access to an unlocked device: an attacker who can use the browser
  can simply open the app.
- Weak passwords: PBKDF2 at 600k iterations raises the cost of guessing, but
  it does not replace a strong passphrase.
- Network adversaries: TLS to Supabase and Venice protects requests in
  flight. Make sure your OS/browser has current roots.

Additionally:

- Supabase RLS is the line of defense for data. The anon key does not grant
  access to other users' rows — RLS policies in `schema.sql` enforce this.
- The app never contacts the Supabase Management API from the browser.
  Schema changes are an explicit, manual action you perform in the SQL
  Editor.

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

### Running against a local Supabase

You can point the app at a local Supabase stack (`supabase start`) just by
entering its URL and anon key during initial setup. Apply `schema.sql` via
`supabase db reset` or the local SQL editor.

## Project layout

```
src/
  lib/
    crypto.ts         Web Crypto AES-GCM + PBKDF2
    config.ts         encrypted config in localStorage
    venice.ts         Venice API client with SSE streaming
    supabase.ts       auth and thread/message CRUD
    state.svelte.ts   top-level reactive app state
  screens/
    Setup.svelte      initial key entry + password creation (reads #setup= hash)
    Unlock.svelte     master-password prompt on subsequent loads
    Auth.svelte       Supabase email/password sign in/up
    Chat.svelte       thread list + streaming message view
    Settings.svelte   key rotation + password change
  App.svelte          phase router
  main.ts             entry
scripts/
  bootstrap.mjs       the wizard (mise run setup)
  doctor.mjs          prerequisite checks
  setup-pages.mjs     enable GitHub Pages
  setup-supabase.mjs  create/link Supabase project + schema + URL config
  lib/                shared helpers (ui, shell, github, supabase, repo)
supabase/schema.sql   RLS schema applied by the wizard
.github/workflows/    CI and Pages deploy
tests/                Vitest unit tests
e2e/                  Playwright E2E tests
```

## License

MIT — see [LICENSE](LICENSE).
