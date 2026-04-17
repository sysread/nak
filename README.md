# Nak

Nak is a browser-only, installable chat PWA that talks to **Venice.ai** for
completions and uses **your** Supabase project for auth and persistence. There
is no server component operated by the project author — you fork, deploy to
GitHub Pages, and own every piece of infrastructure it touches.

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
6. **Configure auth**: ask whether public sign-ups should be allowed and
   (if so) whether to require email confirmation, then whitelist your
   Pages URL in Supabase Auth URL config. The default — sign-ups **off**,
   confirmation **off** — is the right choice for a personal deployment.
7. **Create the main user** directly on the project via Supabase's admin
   API. The email is pre-confirmed, so you can sign in immediately with
   no email round-trip. (You can skip this if you prefer to manage users
   yourself.)
8. Prompt for your **Venice API key** (get one at <https://venice.ai/settings/api>).
9. Print a one-shot setup link like
   `https://<you>.github.io/nak/#setup=<blob>`.

Open the link, set a master password, then sign in with the email and
password you just seeded. That's it.

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
| `mise run supabase-init`  | First-time Supabase flow: create/link project, apply schema, configure auth, seed user |
| `mise run sync`           | Re-apply schema + allowlist to the linked project. Prompt-free after first setup. |
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
   Authentication → URL Configuration (both Site URL and Redirect URLs).
5. **Configure email auth** in Authentication → Providers → Email:
   - Toggle **Enable sign-ups** off if you're the only user.
   - Toggle **Confirm email** off unless you've configured SMTP.
6. **Create your user** in Authentication → Users → *Add user* →
   *Create new user*. Enter your email and password and tick
   **Auto Confirm User** so you can sign in without an email round-trip.
7. **Get a Venice API key** at <https://venice.ai/settings/api>.
8. **Enable GitHub Pages** in Settings → Pages → Source = "GitHub Actions".
9. **Allow workflow writes** in Settings → Actions → General → Workflow
   permissions → "Read and write permissions".
10. **Push to `main`** (or dispatch the `Deploy` workflow manually).
11. Open `https://<you>.github.io/<repo>/`, paste the three values into the
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
  memory (and, during an active browser tab, a copy also lives in
  `sessionStorage` so a refresh within an hour of your last interaction
  doesn't reprompt — see "Session persistence" below). Any script running
  in the same origin can read it. Don't paste third-party code into
  DevTools and don't install untrusted browser extensions with access to
  this origin.
- Supply-chain compromise of the deployed JavaScript: you're trusting the
  code you deployed. Pin dependencies and review diffs before deploying.
- Physical access to an unlocked device: an attacker who can use the browser
  can simply open the app.
- Weak passwords: PBKDF2 at 600k iterations raises the cost of guessing, but
  it does not replace a strong passphrase.
- Network adversaries: TLS to Supabase and Venice protects requests in
  flight. Make sure your OS/browser has current roots.

**Session persistence (auto-unlock):** after you type the master password,
the decrypted config is also kept in `sessionStorage` with a 1-hour
inactivity TTL. Any page interaction (key, click, scroll, tab focus) bumps
the TTL. A refresh within that window skips the unlock screen. Closing the
tab or window clears the session immediately (per the `sessionStorage`
scope), as does clicking **Lock** in the sidebar. This means the only
thing protecting the in-memory config during the TTL is the same origin
boundary that protects the app while it's actively running — there is no
additional encryption for the sessionStorage blob.

Additionally:

- Supabase RLS is the line of defense for data. The anon key does not grant
  access to other users' rows — RLS policies in `schema.sql` enforce this.
- The app never contacts the Supabase Management API from the browser.
  Schema changes, auth-config updates, and main-user creation all happen
  from `mise run setup` on your local machine, not from the deployed PWA.
- The Supabase **service-role key** (which bypasses RLS) is used by the
  wizard only long enough to seed the main user, then discarded. It is
  never written to `localStorage`, the `#setup=` hand-off link, the
  encrypted config blob, or anywhere else in the app. Only the anon key
  ever reaches the browser.
- If you picked "sign-ups disabled" during setup, anyone who finds the
  deployed URL cannot create an account — they'd need access to your
  Supabase project to add a user.

## Models

Nak routes requests through Venice's OpenAI-compatible API, with three
pre-configured tiers so you don't have to memorize model names:

| Tier         | Venice model id                  | Context | When to use                                 |
| ------------ | -------------------------------- | ------- | ------------------------------------------- |
| **Smart**    | `kimi-k2-5`                      | 256k    | Best quality; harder questions, longer answers. |
| **Balanced** | `arcee-trinity-large-thinking`   | 256k    | Default — solid quality at reasonable speed.     |
| **Fast**     | `grok-41-fast`                   | 1M      | Snappy answers, big context windows.             |

- Pick your **default tier** in Settings → *Default AI model*. Any thread
  that hasn't set its own model uses this.
- Override **per thread** from the dropdown at the top of the chat view.
  The choice is sticky — it's saved on the thread row in Supabase, so it
  survives refreshes and carries across devices.
- **Auto-titling**: the first reply in a new thread triggers a one-shot
  call to the Fast tier to generate a short title (3–6 words). It's
  best-effort — if the call fails, the thread keeps its placeholder name.
  You can always click the title in the top bar to rename it by hand.

### What syncs vs what stays local

| Item | Lives where | Shared across devices? |
| ---- | ----------- | ---------------------- |
| Supabase URL / anon key / Venice API key | local `localStorage` (AES-GCM encrypted) | No — needed to reach Supabase, and staying local is the whole point of the encryption |
| Master password | derived per-device | No — it's the KDF input; nothing is stored |
| **Default model tier** | Supabase `profiles.settings` | **Yes** |
| **Color mode + accent** | Supabase `profiles.settings` + local cache for flash-free boot | **Yes** |
| Per-thread model override | Supabase `threads.model` | Yes |
| Threads and messages | Supabase | Yes |
| Linked Supabase project (wizard) | gitignored `.nak/state.json` | No |

So when you sign into Nak from a second browser, you'll have to re-enter
your API keys and pick a master password — but your default model,
color scheme, threads, and per-thread overrides will all already be there.

### Appearance

Settings → Appearance has two axes:

- **Mode**: Light, Dark, or System (follows your OS's `prefers-color-scheme`).
  Dark is a near-black canvas; light is a cream/latte.
- **Accent**: six choices — blue, green, purple, pink, orange, teal. Each
  name has a dark-mode pastel variant and a light-mode sharp variant, so
  switching modes keeps the same color identity. All pairings clear WCAG
  AA contrast.

The choice is cached to `localStorage` for an instant next-load (a small
inline script in `index.html` applies it before first paint), and mirrored
to `profiles.settings` so it follows you to other devices.

### Typography

The UI uses [ProggyDotted](https://github.com/bluescan/proggyfonts), a
mono pixel-style font with a dotted zero. Shipped locally under
`src/assets/fonts/` (MIT-licensed; see the bundled LICENSE file).

### Keeping a project in sync

- `mise run setup` — full first-time wizard. Walks you through Pages,
  Supabase, auth policy, and the main user.
- `mise run sync` — idempotent re-application for **later**. Re-applies
  `schema.sql` and merges the current Pages URL into Supabase's auth
  allowlist. No prompts; it remembers the linked project in
  `.nak/state.json`. Use this whenever you pull new code that added
  schema changes.

### Schema columns added over time

All use `ADD COLUMN IF NOT EXISTS`, so `mise run sync` is always safe:

- `threads.model text` — per-thread model override.
- `profiles.settings jsonb` — per-user preferences (default model tier,
  color mode, accent).

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
