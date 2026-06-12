# Auth & session

One authentication gate sits in front of the chat UI:
**Supabase email/password**, which protects the user's data
in their Supabase project. The browser also keeps a plaintext
configuration blob with the Supabase URL + publishable key so
the user doesn't have to retype them on every visit, but
there is no separate password ceremony around it - the
publishable key is RLS-safe and the Venice API key lives
server-side, so the browser never holds a real secret.

## Role in the app

From a cold start, a user passes through:

1. `loading` - `App.svelte` runs its session-restore check.
2. `setup` (no stored config) or straight to `unlocked`
   (`nak:config:v2` present in localStorage).
3. `Chat.svelte` mounts and gates an internal `<Auth />`
   screen on the Supabase session. If `supabase.getSession()`
   yields no session, `Auth.svelte` renders in-place. User
   signs in (or signs up), gets a JWT, and the chat UI
   takes over.

There is no master-password gate. The encrypted-blob layer the
app used to ship was retired - keeping a key derivation around
to protect data that was either publishable or held
server-side cost typing every session for no real attack-surface
reduction. The blob is now plaintext JSON, and the boundary
that matters is Supabase's row-level security.

## Files

- `src/lib/config.ts` - plaintext config store in localStorage
  (`nak:config:v2`), plus the JSON export/import format.
  `loadConfig()` / `saveConfig()` / `clearStoredConfig()` /
  `hasStoredConfig()`. Reads stamp `LEGACY_STORAGE_KEY` away
  if a stale encrypted blob from before the rip is still
  sitting there.
- `src/lib/session.ts` - a tiny sessionStorage helper for the
  last-active-thread pointer.
  `getSessionThreadId` / `setSessionThreadId` /
  `clearSessionThreadId`. No TTL, no config copy - the
  Supabase auth session is what holds session liveness.
- `src/screens/Setup.svelte` - the first-time config-entry
  screen. Collects the Supabase URL + publishable key and
  calls `activate()`.
- `src/screens/Auth.svelte` - Supabase email/password form,
  rendered inside `Chat.svelte` when Supabase has no
  session.
- `src/App.svelte` - phase routing.
- `src/lib/state.svelte.ts` - `activate()` and
  `resetForSignOut()`.

## Entry points

- **Cold boot** - `App.svelte`'s `onMount` checks
  `hasStoredConfig()`. Hit -> `activate(config)`; miss -> phase
  goes to `setup`.
- **Setup submit** - `Setup.svelte` calls
  `saveConfig(config)` then `activate(config)`.
- **Account password rotation** - Settings &rarr; Security
  pane calls `app.supabase.changeAuthPassword(old, new)`,
  which re-verifies the current password against Supabase
  before applying the update. Does not touch local
  storage.
- **Sign out** - the footer button in `Chat.svelte`'s
  `signOut()` handler calls `clearSessionThreadId()`,
  `resetForSignOut()` (clears in-memory profile defaults
  and system prompts), and `app.supabase.signOut()` (clears
  the Supabase session). The localStorage config stays so
  signing back in re-uses it without going through Setup.

## Data model

- **`localStorage['nak:config:v2']`** - plaintext JSON
  `{ supabaseUrl, supabasePublishableKey }`. Validated by
  `coerceConfig` on read; unknown fields are dropped.
- **`localStorage['nak:config:v1']`** - legacy encrypted
  blob from before the master-password rip. `config.ts`
  removes it on any read so it doesn't accumulate.
- **`localStorage['sb-<project>-auth-token']`** - Supabase's
  own auth-token storage (JWT + refresh token). Owned by
  the supabase-js client; nak does not read or write it
  directly.
- **`sessionStorage`** - the last-active-thread id, written
  by `Chat.svelte` when the user opens a thread. Cleared
  on tab close (sessionStorage semantics) and on sign-out.
- **`localStorage['nak:theme:v1']`** - non-secret; documented
  here only because it's on the same origin. See
  `./settings.md`.
- **Supabase `auth.users`** - managed by Supabase.

The `AppConfig` shape is fixed: `supabaseUrl`,
`supabasePublishableKey`. `coerceConfig` drops any other
fields on read.

## Contracts

- `loadConfig(): AppConfig | null` - null on "no stored
  blob" or "blob present but malformed."
- `saveConfig(config): void` - overwrite of the blob.
  Validates the config shape before writing.
- `clearStoredConfig(): void` - destructive remove. Used
  by the "Forget this device" affordance.
- `activate(config): void` - the only transition into
  `unlocked`. Stores the config, news up `SupabaseService`
  and `VeniceClient`, flips phase, fires background
  workers.
- `resetForSignOut(): void` - clears in-memory profile +
  system-prompt state so the previous account's
  preferences don't leak into a subsequent
  sign-in-as-someone-else before `refreshSettings` re-seeds
  from the new account's Supabase settings.

## Refresh-token rotation across workers

Nak runs multiple Supabase clients per tab: the main-thread
client plus one in each background worker (samskara, bias).
Only the main-thread client refreshes. Each worker is
built with `autoRefreshToken: false` and is pinned to the
current session via `setSession(...)`; its manager
subscribes to `app.supabase.onAuthChange` and forwards
every rotated `{access_token, refresh_token}` pair to the
worker as a `{type: 'session', ...}` message, which the
worker re-pins via `setSession`.

Why: with every client running its own `autoRefreshToken`,
multiple refreshers race for the same refresh token.
Supabase's "detect and revoke potentially compromised
refresh tokens" feature flags any non-latest refresh
token as replayed once the reuse interval (default 10s)
elapses and revokes the **entire session family** - the
user is then forced through the email/password prompt
even though they haven't been idle long enough for the
project's inactivity timeout to fire.
Main-thread-as-sole-refresher eliminates the race.

Bridge wiring:

- Main -> worker: `SupabaseService.onAuthChange`
  (`src/lib/supabase.ts`) -> `worker.postMessage({type:
  'session', ...})`.
- Worker: a module-scope `currentClient` handle set by
  `runWorker` after the initial `setSession` succeeds and
  cleared on teardown. The `session` message handler
  calls `currentClient.auth.setSession(...)`. A stray
  `session` message arriving before the initial
  setSession completes (or after teardown) is a no-op -
  the start message carried the same tokens, and the
  post-teardown case has no client to write to.

Every manager unsubscribes in `stop()` before terminating
the worker so a late-arriving auth event can't post into
a null worker reference.

## Interactions with other features

- **Chat** - `chat.md`'s screen mounts only after
  `activate()` yields a live `app.supabase` + `app.venice`,
  plus a Supabase session.
- **Settings** - the Security pane rotates the account
  password via `app.supabase.changeAuthPassword`.
- **Background workers** - `activate()` fires every
  manager's `start()` fire-and-forget. Sign-out does not
  tear them down directly; the supabase-js sign-out
  triggers `onAuthChange(null)` which lets the workers
  notice the missing session and stop themselves.

## Gotchas

- **The publishable key is not a secret in the
  RLS-key sense.** RLS gates everything by
  `auth.uid() = user_id`, so an attacker with the
  publishable key still has to sign in through Supabase
  auth to read anything. The "encrypted at rest in
  localStorage" ceremony the app used to ship around it
  was reassurance theater, which is why it got removed.
- **The Venice key is never on the wire to the browser.**
  It lives in `app_config` and the edge function reads
  it server-side. Even an attacker with full
  localStorage access never gets it; revoking it is a
  cron-and-Supabase operation, not a per-user one.
- **The legacy `nak:config:v1` entry is reaped on read.**
  Any session that touches `loadConfig` removes the
  stale encrypted blob if one is still sitting in
  localStorage from before the rip. Tests that drive
  `loadConfig` need to expect this.
- **No idle-timeout sign-out.** The app used to lock
  itself after 7 days of inactivity; that was a
  master-password-era affordance. Supabase's own
  inactivity timeout still applies to the auth session.

## Where to go next

- `./chat.md` - what mounts after activation lands.
- `./settings.md` - the keys pane + account-password
  rotation pane.
- `./architecture.md` - the phase state machine in
  context.
