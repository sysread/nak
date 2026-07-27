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
