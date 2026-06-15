# Auth and session lifecycle: gate, sign in/out, and restore

## Covers

The Supabase email/password gate and the cold-start state machine
([dev: auth-session](../../dev/auth-session.md)), the in-chat
`Auth` screen and its sign-in/sign-up toggle
([dev: auth-session](../../dev/auth-session.md)), session restore on
reload, and the sign-out reset path
([dev: chat](../../dev/chat.md)).

## Preconditions

- Local stack up (`mise run dev-start`).
- Config already stored in this browser (`nak:config:v2` present in
  localStorage), so the app boots past `Setup` into the chat shell.
  If the browser is fresh, complete first-run `Setup` once - that
  flow is proven separately in
  [setup-config-transfer](./setup-config-transfer.md) and is out of
  scope here.
- The dev account exists (`dev@nak.local` / `devpass123`).
- Start signed OUT. If the browser currently holds a live session,
  sign out first (drawer footer `Sign out` icon) or clear the
  Supabase token key from localStorage:

  ```sql
  -- No SQL needed; clear the client-side auth token in the browser
  -- devtools console instead:
  --   Object.keys(localStorage)
  --     .filter(k => k.startsWith('sb-') && k.endsWith('-auth-token'))
  --     .forEach(k => localStorage.removeItem(k));
  -- Then reload the page.
  ```

## Steps

1. With config stored but signed out, load Nak and watch the
   first paint.
2. When the `Sign in` card appears, confirm the email and password
   fields and the mode toggle are present without touching `Setup`.
3. Click `Need an account? Sign up.` and observe the card.
4. Click `Have an account? Sign in.` to return to sign-in mode.
5. Enter `dev@nak.local` with a wrong password and submit `Sign in`.
6. Correct the password to `devpass123` and submit `Sign in`.
7. Once the chat shell is up, reload the page.
8. In the chat shell, locate the drawer footer and click the
   `Sign out` icon.
9. After sign-out lands, reload the page once more.

## Expected

- (1) First paint shows a brief `Loading…` then `Connecting…` (the
  session check), not the `Setup` form - stored config means the
  app boots straight into the chat shell, which then gates on the
  Supabase session.
- (2) The `Auth` screen renders in place with heading `Sign in`,
  an `Email` field, a `Password` field, a `Sign in` submit button,
  and an `Edit Supabase config` link at the bottom. No chat content
  is visible behind it.
- (3) The heading flips to `Create account`, the submit button reads
  `Sign up`, and the toggle now reads `Have an account? Sign in.`.
- (4) The card returns to the `Sign in` heading and `Sign in` submit
  button.
- (5) The submit button briefly shows `Working…`, then an error line
  (red `error` text below the fields) reports the bad credentials.
  The card stays on screen; no chat appears.
- (6) Submit shows `Working…`, the `Auth` card is replaced by the
  chat shell (thread list / composer visible), and no error remains.
- (7) After reload, the app returns directly to the chat shell with
  no `Auth` card - the Supabase auth-token in localStorage
  (`sb-<project>-auth-token`) restores the session. Briefly
  `Connecting…` may flash before the shell paints.
- (8) The chat shell is replaced by the `Sign in` `Auth` card again.
  The stored config (`nak:config:v2`) is untouched, so no `Setup`
  form appears.
- (9) After reload while signed out, the app still lands on the
  `Sign in` `Auth` card (config persists; only the auth session was
  cleared), confirming sign-out cleared the Supabase token and not
  the config blob.

## Cleanup

- Leave the browser signed in as the dev user if later cases need
  it, or sign out via the drawer footer `Sign out` icon.
- This case does not create auth users. Sign-up is exercised only as
  a UI toggle (steps 3-4) and never submitted, so no junk
  `auth.users` rows are produced. If you do submit a real sign-up
  for a separate test, delete the stray account:

  ```sql
  delete from auth.users where email = '<the-test-email>';
  ```

## Results log

| Date | Env | Commit | Result | Notes |
| ---- | --- | ------ | ------ | ----- |
