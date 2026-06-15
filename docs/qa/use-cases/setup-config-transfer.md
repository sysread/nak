# Setup: first-run config and browser-to-browser transfer

## Covers

First-run setup fields ([dev: settings](../../dev/settings.md),
[dev: auth-session](../../dev/auth-session.md)), config persistence in the
browser ([dev: settings](../../dev/settings.md)), and config-only
export/import ([dev: build-deploy](../../dev/build-deploy.md),
[dev: settings](../../dev/settings.md)).

## Preconditions

- Local stack up (`mise run dev-start`).
- One signed-in browser session that can export config.
- A second clean browser profile / incognito window that has not yet been
  configured for this local stack.

## Steps

1. In the configured browser, open `Settings` -> `API keys` and export the
   config JSON.
2. Inspect the downloaded file.
3. In the clean browser profile, open Nak to the first-run `Setup` screen.
4. On `Setup`, click `Import` and choose the exported JSON file.
5. Confirm the `Supabase URL` and publishable key fields auto-fill.
6. Sign in with the dev account in the clean browser.
7. Reload the clean browser once after sign-in.

## Expected

- (1-2) Export downloads a JSON file that contains the Supabase URL and
  publishable key, but not the user's password, JWT, or Venice key.
- (3-5) The clean browser shows the first-run `Setup` screen; `Import`
  accepts the JSON file and fills both config fields automatically.
- (5-6) Importing config does not sign the user in by itself; the user
  must still authenticate with Supabase credentials.
- (6-7) After sign-in and reload, the clean browser keeps the imported
  config locally and returns to the configured app instead of the blank
  setup form.

## Cleanup

- Remove the exported config file from the local downloads folder if it
  was created only for this test.
- Sign out of the clean browser profile if it should not stay logged in.

## Results log

| Date | Env | Commit | Result | Notes |
| ---- | --- | ------ | ------ | ----- |
