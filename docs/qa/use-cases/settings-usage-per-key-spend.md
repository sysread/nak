# Settings: Usage pane per-key spend vs account-wide breakdown

## Covers

The Settings -> **Usage** pane's two-scope split
([dev: settings](../../dev/settings.md)): the per-key headline fetched
through the venice `key-usage` route (`GET /api_keys`, matched to our
key by `last6Chars`) and the account-wide per-model chart fetched
through `usage-analytics` (`GET /billing/usage-analytics`).

The point of the walkthrough is the *distinction* between the two
numbers. Venice reports billing per account and offers no key filter,
so the chart necessarily includes every other API key on the account
plus Venice web-app usage. The headline is the only per-key figure
Venice exposes. A regression that quietly makes them agree - or makes
the headline follow the date pickers - is the failure this case exists
to catch.

## Preconditions

- Local stack up (`mise run dev-start`), signed in as the dev user.
- A Venice key seeded in `app_config`. It must be an **ADMIN**-typed
  key: `GET /api_keys` rejects `INFERENCE` keys with 401, which
  degrades the headline to an error (itself worth checking once - see
  the last step).
- **A second source of spend on the same Venice account** within the
  last 7 days - another API key, or usage in Venice's own web app.
  Without one, the account total and the key total legitimately match
  and the case proves nothing. Confirm before starting:

  ```sh
  curl -s https://api.venice.ai/api/v1/api_keys \
    -H "Authorization: Bearer $VENICE_API_KEY" \
    | jq '.data[] | {description, last6Chars,
                     usd: .usage.trailingSevenDays.usd}'
  ```

  At least two rows should carry a non-zero `usd`.

## Steps

1. Open **Settings -> Usage** for the first time this session. Watch
   the top of the pane while it loads.
2. Read the headline figure and the caption under it. Note the key
   name shown.
3. Cross-check the headline against the `curl` output from the
   preconditions - find the row whose `last6Chars` matches the tail of
   the key in `app_config`.
4. Read the per-model chart below. Add up the spend pills, or read the
   totals strip.
5. Change **From** to 30 days ago, leave **To** at today, hit
   **Refresh**. Watch BOTH the chart and the headline.
6. Close Settings, reopen it to **Usage** within 15 minutes. Watch for
   a loading flash.
7. Sign out and back in, then reopen **Settings -> Usage**.
8. *(Optional, one-off)* Temporarily point `app_config` at an
   `INFERENCE`-typed Venice key, reload, and reopen the pane.

## Expected

- (1) The headline area shows "Loading this key's spend..." then
  resolves. It loads independently of the chart - neither blocks the
  other, and they may settle in either order.
- (2) A large dollar figure, with the key's Venice description
  underneath in a code span and the caption naming a **7-day** window
  and stating it is fixed, not the range below. Hovering the figure
  gives the same warning in a tooltip.
- (3) The headline equals that row's `usage.trailingSevenDays.usd`.
  Where the key also has DIEM spend, a second smaller muted figure
  sits beside the dollar one; a key with zero spend reads `$0.00`,
  not blank.
- (4) The chart total is **larger** than the headline, by roughly the
  other keys' trailing-7-day spend. The prose above the chart says it
  covers the whole account.
- (5) The chart refetches for the new range and its totals grow. **The
  headline does not change** - same figure, same caption. This is the
  key assertion: the headline's window is fixed by Venice.
- (6) Both render from cache with no loading flash.
- (7) Both are empty on the fresh open and refetch from scratch - no
  figures from the prior session survive the sign-out.
- (8) The headline shows a Venice 401 error; **the chart below still
  renders normally**. The two failure domains are independent.

## Cleanup

- Reset the date pickers to the default range.
- If you did step 8, restore the ADMIN key in `app_config` and reload.

## Results log

| Date | Env | Commit | Result | Notes |
| ---- | --- | ------ | ------ | ----- |
| 2026-07-27 | hosted | 8314527 | pass (1-4) | First run, at merge time by the project owner, terminal style / light mode. Headline `$12.84` for `nak-personal` with the caption naming the 7-day fixed window; chart `$156.69` across 12 models / 413.1M tokens over 07/20-07/27. The gap is the point: `GLM 5.2` alone carries `$147.54` on another key, so the pre-change pane was reporting >12x nak's actual spend. Key identity confirmed independently - `right(venice_api_key, 6)` in `app_config` is `2i2YGU`, matching the `nak-personal` row's `last6Chars`, so `last6Chars` is literally the key's last six characters and the suffix match is sound. All six keys on the account have distinct suffixes, so the collision guard was not exercised. Also clears the visual checks the cloud session could not run: the figure, the `<code>` key name, and the `.key-usage` terminal-style left side-border all render correctly. (5-8) not run - the date-range invariance check (5) is the one worth doing deliberately next pass; (6) cache no-flash, (7) sign-out reset, and (8) the INFERENCE-key 401 degradation are unexercised. Note the headline read `$12.4299` in an API sample taken ~4h earlier; the drift is the trailing window sliding, not an inconsistency. |
| 2026-07-27 | hosted | 8314527 | pass (5) | Same session, immediately after the run above. Widened the range to 06/27-07/27: the chart moved from `$156.69` / 12 models / 413.1M tokens to `$342.37` / 16 models / 895M tokens, while the headline stayed at `$12.88`. That is the assertion - the headline does not follow the date pickers. Read the 4-cent difference from the prior row (`$12.84`) carefully: the operator ran one chat completion between the two observations, and the rolling 7-day window billed it - confirmed cause, not inferred drift. Set that against `$186` of movement in the chart at the same moment; the range change contributed nothing. Incidentally the stronger result of the two: the headline picked up a known nak completion at its actual cost, so it is live-attributing this key's own spend rather than merely holding still. A regression here would look like the headline tracking the chart's growth. |
