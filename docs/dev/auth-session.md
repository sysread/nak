# Auth & session

Two authentication gates sit in front of the chat UI: the **local
master password** (protects the encrypted API-key blob in
localStorage) and **Supabase email/password** (protects the user's
data in their Supabase project). This doc covers both and the
session lifecycle that stitches them together.

## Role in the app

From a cold start, a user passes through:

1. `loading` — `App.svelte` checks sessionStorage for a live
   session. Hit → skip to step 4.
2. `setup` (no stored config) or `locked` (stored config). Either
   way, the user lands on a screen that gets us to the next phase.
3. Master password is accepted → config is decrypted → `activate()`
   flips to `unlocked`.
4. Chat screen mounts. Supabase auth is a separate gate inside
   `Chat.svelte`: if `supabase.getSession()` yields no session,
   `Auth.svelte` is shown in-place. User signs in, gets a JWT,
   chat UI renders.

Two gates because they protect different things. Local encryption
is defense-in-depth for a shared browser or stolen device; Supabase
auth is the row-level-security boundary on your data. Losing the
master password means re-entering the three keys. Losing the
Supabase password means the normal password-reset flow for that
project.

## Files

- `src/lib/config.ts` — encrypted-blob store in localStorage
  (`nak:config:v1`), plus the plaintext `nak-config` export/import
  format.
- `src/lib/crypto.ts` — AES-256-GCM envelope with a versioned
  ciphertext layout, key derived via PBKDF2-SHA256 (600k
  iterations). Web Crypto primitives only.
- `src/lib/session.ts` — sessionStorage bridge
  (`nak:session:v1`) holding the decrypted config + TTL + last
  active thread id.
- `src/screens/Setup.svelte` / `Unlock.svelte` / `EditConfig.svelte`
  — the three screens that drive the locked → unlocked branches.
- `src/screens/Auth.svelte` — Supabase email/password form,
  rendered inside `Chat.svelte` when Supabase has no session.
- `src/App.svelte` — phase routing, activity listeners, idle-TTL
  check.

## Entry points

- **Cold boot** — `App.svelte`'s `onMount` calls `loadSession()`.
  Hit → `activate(config, { persist: false })`; miss → phase goes
  to `setup` (`hasStoredConfig() === false`) or `locked`.
- **Unlock click** — `Unlock.svelte` calls `loadConfig(password)`
  → either `activate(config)` (flips to `unlocked`) or
  `enterEditConfig(config)` (flips to `edit-config` so the user
  can fix a mistyped key).
- **Setup submit** — `Setup.svelte` calls `saveConfig(config,
  password)` then `activate(config)`.
- **Password rotation** — `Settings.svelte` Security pane calls
  `changePassword(old, new)`, which decrypts with old and
  re-encrypts under new. Does not touch Supabase.
- **Activity tick** — every `keydown`/`pointerdown`/`scroll`/
  `focus` on the window calls `touchSession(DEFAULT_TTL_MS)`
  (throttled to once per 30s). Every 30s, a wall-clock interval
  checks `sessionRemainingMs()`; expiry triggers `lock()`.
- **Sign out** — the footer button in `Chat.svelte` calls
  `app.supabase.signOut()`, which clears the Supabase session;
  does NOT touch the local config or phase. The user can sign
  into another Supabase account without re-entering keys.

## Data model

- **`localStorage['nak:config:v1']`** — base64-encoded ciphertext.
  Layout: `[4 bytes version][16 bytes salt][12 bytes iv][body+tag]`.
  Version is u32 big-endian; bump when the PBKDF2 iteration count
  or cipher choice changes.
- **`sessionStorage['nak:session:v1']`** — JSON
  `{ config: AppConfig, expiresAt: number, activeThreadId?: string }`.
  Clears on tab close (sessionStorage semantics). TTL defaults to
  24 hours.
- **`localStorage['nak:theme:v1']`** — non-secret; documented here
  only because it's on the same origin. See `./settings.md`.
- **Supabase `auth.users`** — managed by Supabase. JWT stored in
  localStorage by the Supabase client under its own keys.

The `AppConfig` shape is fixed: `supabaseUrl`, `supabaseAnonKey`,
`veniceApiKey`. `validateConfig` drops any other fields on read,
so a future storage-shape change is a version bump on the
localStorage key (`v2`) rather than a migration.

## Contracts

- `loadConfig(password): Promise<AppConfig | null>` — null on "no
  stored blob", `ConfigError` on "wrong password or corrupted
  data" (AES-GCM tag mismatch normalized to a generic message
  because the underlying `OperationError` DOMException is opaque).
- `saveConfig(config, password): Promise<void>` — overwrite of the
  blob. Validates the config shape before encrypting.
- `changePassword(old, new): Promise<void>` — decrypts with old,
  re-encrypts under new. Minimum-length check (8 chars); anything
  stronger is the user's job. Does NOT touch the Supabase
  password or session.
- PBKDF2 iteration count is implicit in the envelope `VERSION`.
  Changing `PBKDF2_ITERATIONS` requires bumping `VERSION` and
  teaching `decrypt` to dispatch by version; otherwise old blobs
  will be undecryptable.
- `activate(config, opts?)` — the only transition into `unlocked`.
  By default persists a session blob; pass `{ persist: false }`
  when restoring from an existing session (don't bump the TTL on
  page refresh).
- `lock()` — the only transition out of `unlocked`. Stops all
  workers, clears services, clears the session blob.
- `encrypt` / `decrypt` from `crypto.ts` — the only envelope
  layer. If something else needs to be encrypted, route it through
  here rather than duplicating the AES-GCM / PBKDF2 scaffolding.

## Refresh-token rotation across workers

Nak runs five Supabase clients per tab: the main-thread client
plus one in each of the embeddings, reflection, summary, and
attachment-expiry Web Workers. Only the main-thread client
refreshes. Each worker is built with `autoRefreshToken: false`
and is pinned to the current session via `setSession(...)`; its
manager subscribes to `app.supabase.onAuthChange` and forwards
every rotated `{access_token, refresh_token}` pair to the worker
as a `{type: 'session', ...}` message, which the worker re-pins
via `setSession`.

Why: with every client running its own `autoRefreshToken`, five
refreshers race for the same refresh token. Supabase's "detect
and revoke potentially compromised refresh tokens" feature flags
any non-latest refresh token as replayed once the reuse interval
(default 10s) elapses and revokes the **entire session family** —
the user is then forced through the email/password prompt even
though they haven't been idle long enough for the project's
inactivity timeout to fire. Main-thread-as-sole-refresher
eliminates the race.

Bridge wiring:

- Main → worker: `SupabaseService.onAuthChange` (`src/lib/supabase.ts`)
  → `worker.postMessage({type: 'session', ...})`.
- Worker: a module-scope `currentClient` handle set by
  `runWorker` after the initial `setSession` succeeds and cleared
  on teardown. The `session` message handler calls
  `currentClient.auth.setSession(...)`. A stray `session` message
  arriving before the initial setSession completes (or after
  teardown) is a no-op — the start message carried the same
  tokens, and the post-teardown case has no client to write to.

Every manager unsubscribes in `stop()` before terminating the
worker so a late-arriving auth event can't post into a null
worker reference.

## Interactions with other features

- **Chat** — `chat.md`'s screen mounts only after `activate()`
  yields a live `app.supabase` + `app.venice`, plus a Supabase
  session. Lock clears all of that in one go.
- **Settings** — Settings' Security pane rotates the master
  password (`changePassword`), which re-encrypts the config blob
  owned by this feature. The Keys pane also re-encrypts on
  update. Both call paths live in `settings.md`.
- **Embeddings / reflection / summaries / attachment-expiry** —
  `activate()` fires `embeddingManager.start()`,
  `reflectionManager.start()`, `summaryManager.start()`, and
  `attachmentExpiryManager.start()` fire-and-forget; `lock()`
  calls matching `stop()` on each. The managers also bridge
  refresh-token rotation to their workers (see above). Those
  docs cover the worker lifecycle from the worker side; this
  page owns the activate/lock pivot and the auth bridge.

## Gotchas

- **Three plaintext locations for the decrypted config.** Memory
  (`app.config`), sessionStorage (`nak:session:v1`), and the live
  `VeniceClient.apiKey` / `SupabaseService.client` instances. Lock
  has to clear all three; `lock()` does so in order (services
  first, then `app.config`, then session). Skipping any one leaves
  a footgun.
- **Version-coupling between envelope and iteration count.** The
  salt and IV ride in the ciphertext, but the PBKDF2 iteration
  count is implicit in `VERSION`. Raising `PBKDF2_ITERATIONS`
  without bumping `VERSION` would make old blobs silently
  undecryptable — the salt would still match but the derived key
  wouldn't. Bump `VERSION` and teach `decrypt` to dispatch on it
  before changing that constant.
- **`edit-config` phase holds a decrypted `app.config` with no
  services.** Any code that assumes `app.config != null` implies
  `app.supabase != null` is wrong. The phase exists so the user
  can fix a mistyped key without going through Supabase auth
  first; services instantiate only on `activate()`.
- **`ConfigError` on decryption doesn't distinguish "wrong
  password" from "corrupted blob."** AES-GCM fails the same way
  for both. This is intentional — surfacing "wrong password,
  corrupted blob, or tampered blob" as distinct errors leaks
  information an attacker with stolen ciphertext shouldn't have.
- **Auto-unlock on refresh is not a security property.** Anyone
  with access to the open tab's sessionStorage already has the
  plaintext config; we're not pretending otherwise. The refresh
  bridge saves typing, not secrets.
- **`#setup=<base64>` URL fragment** in `Setup.svelte` carries
  plaintext keys. The onMount handler strips the fragment
  immediately so a refresh or accidental share doesn't re-leak
  it; never `window.location.href`-log that value.

## Where to go next

- `./chat.md` — what mounts after activation lands.
- `./settings.md` — the keys pane + password rotation pane.
- `./architecture.md` — the phase state machine in context.
