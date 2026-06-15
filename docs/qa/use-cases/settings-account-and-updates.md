# Settings: pane saves, update flow, and account controls

## Covers

Settings pane independence ([dev: settings](../../dev/settings.md),
service-worker update surfaces ([dev: build-deploy](../../dev/build-deploy.md)),
background-job toggles ([dev: memory](../../dev/memory.md),
[dev: wiki](../../dev/wiki.md)), usage refresh UI ([dev: settings](../../dev/settings.md)),
and credential/export controls ([dev: auth-session](../../dev/auth-session.md),
[dev: settings](../../dev/settings.md)).

## Preconditions

- Local stack up (`mise run dev-start`), signed in as the dev user.
- Settings are reachable from the drawer gear icon.
- If testing password change end to end, know the current dev password and
  have a reversible replacement ready.

## Steps

1. Open `Settings` from the drawer gear icon.
2. In `Appearance`, change one safe setting (for example the default log
   level or accent), save it if that pane exposes a save action, then
   leave Settings.
3. Re-open `Settings` and confirm the changed Appearance value persisted.
4. In `About`, click `Check for updates`.
5. In `Memory`, toggle the background memory librarian off, leave the
   pane, then re-open `Memory`.
6. In `Wiki`, under the `Automatic articles` section, toggle the
   "Let Nak's wiki agent maintain articles..." checkbox off, leave the
   pane, then re-open `Wiki`.
7. In `AI`, under the `Reply notifications` section, toggle the
   "Notify me when replies finish" checkbox, then restore it.
8. In `Usage`, set a short date range and click `Refresh`.
9. In `API keys`, trigger the JSON config export flow.

## Expected

- (1-3) Settings opens from the gear icon, panes are navigable, and a
  change in `Appearance` persists without requiring a global Save for the
  whole modal.
- (4) `Check for updates` runs without breaking the session. If a fresh
  build is available, the control flips to `Reload to update` and/or the
  update banner appears; if not, the UI stays in the no-update state.
- (5) The `Memory` pane toggle persists when re-opened; turning it off
  does not delete existing memories.
- (6) The wiki-agent maintenance toggle persists when re-opened; turning
  it off does not disable manual wiki editing.
- (7) The reply-notifications toggle is user-visible and reversible from
  the `AI` pane.
- (8) `Usage` shows a refresh/loading state, then renders usage rows or an
  explicit empty-range result for the chosen dates.
- (9) Export downloads a JSON config file rather than exposing raw secrets
  inline in the pane.

## Cleanup

- Restore any toggles or appearance settings changed during the case to
  their prior values.

## Results log

| Date | Env | Commit | Result | Notes |
| ---- | --- | ------ | ------ | ----- |
