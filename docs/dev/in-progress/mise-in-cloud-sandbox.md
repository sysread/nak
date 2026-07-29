# Why `mise run check` cannot run in a cloud agent sandbox

**Status: open. Research only - no remediation is proposed here.**

Cloud agent sessions (Claude Code on the web) cannot run the gate
through mise and have to fall back to the raw pnpm sequence. This
records what the failure actually is, since the error message names
the wrong cause and two plausible-sounding diagnoses turn out to be
wrong.

Nothing here argues for a fix. Whether the sandbox *should* be able
to run mise is a separate decision that has not been made.

## Symptom

```text
mise ERROR Failed to install tools: aqua:charmbracelet/gum@latest, aqua:cli/cli@latest

aqua:charmbracelet/gum@latest: no versions found for
aqua:charmbracelet/gum matching date filter
```

The gate never starts. No gate task runs, so nothing is checked.

## Confirmed mechanism

1. **mise resolves the entire `[tools]` set before running any
   task.** The gate needs node, pnpm, and deno. It does not use
   `gh` or `gum` at all. That does not matter: an unresolvable entry
   anywhere in `[tools]` aborts before task dispatch.

2. **Exactly two entries fail**, and both float on `latest`:

   ```toml
   "aqua:cli/cli"           = "latest"   # fails
   "aqua:charmbracelet/gum" = "latest"   # fails
   "aqua:supabase/cli"      = "2.101.0"  # fine
   ```

3. **`latest` forces a GitHub releases-list API call**, and that
   call is refused:

   ```text
   403 Forbidden for https://api.github.com/repos/cli/cli/releases?per_page=100
   403 Forbidden for https://api.github.com/repos/charmbracelet/gum/releases?per_page=100
   ```

   The response body is the agent proxy's own message: "GitHub
   access to this repository is not enabled for this session." The
   session's GitHub access is scoped to `sysread/nak`, and
   `charmbracelet/gum` and `cli/cli` are not it.

4. **An exact pin needs no list call.** `aqua:supabase/cli` is
   pinned, never queries the releases endpoint, and **installs
   successfully** in this same sandbox. It is the natural control in
   the experiment: same backend, same host, different version
   spec, opposite outcome.

5. **Binary downloads are not blocked.** Follows from (4) - the
   pinned tool's release asset downloaded fine. Only the
   `api.github.com` version-list query is refused, not the release
   asset fetch.

6. **The reported cause does not exist.** mise renders an empty
   version list as "no versions found matching date filter." There
   is no date filter: `mise settings` has no date, age, cutoff, or
   filter key, and there is no global mise config in the sandbox.
   The phrase is mise's generic wording for "the list came back
   empty," and it sends you looking for a knob that is not there.

## Dead ends, so nobody re-walks them

- **"It is a date/version cutoff somewhere."** No. See (6).
- **"The whole aqua backend is broken in the sandbox."** No. See
  (4) - a pinned aqua tool installs.
- **"The session cannot reach GitHub."** Too broad. The GitHub MCP
  tools work all session; they use a separate credentialed path.
  What is unavailable is `api.github.com` to arbitrary CLI tools.
- **"Only `latest` is the problem, so aqua is fine with pins."**
  True as far as tested, but see the open questions - nobody has
  actually pinned `gh`/`gum` and re-run the gate.

## A probe that gives a false negative

Testing resolution by exit code alone reports success on the
failing tools:

```sh
mise ls-remote "aqua:charmbracelet/gum@latest" >/dev/null 2>&1 && echo resolves
```

`ls-remote` exits 0 with an empty list, so this prints `resolves`
for a tool that cannot resolve. It also appears to pass from a
directory with no `.mise.toml`. Read the warnings, or run
`mise run check` itself - the exit code of a subcommand is not
evidence here.

## Evidence

Gathered in a cloud session on mise `2026.7.11 linux-x64`:

- `mise run check` - fails as above; `supabase/cli` absent from the
  failure set.
- `mise ls --installed` - shows `aqua:supabase/cli 2.101.0`
  installed.
- `curl https://api.github.com/repos/charmbracelet/gum/releases` -
  403 with the proxy's repo-access message.
- `curl https://api.github.com/repos/sysread/nak` - also 403, so
  raw `api.github.com` is not usable by CLI tools even for the
  in-scope repo.
- `mise settings` - no date/age/cutoff/filter key.
- `mise ls-remote node@20.11.1`, `pnpm@10.33.4`, `deno@2.8.0` - all
  resolve; the core backends are unaffected.

## Open questions

- **Would pinning `gh` and `gum` unblock the gate?** Suggestive from
  (4) but untested. Pinning also has a cost the pin comment on
  `supabase/cli` already spells out: a pinned tool stops tracking
  upstream and needs deliberate bumps.
- **Can mise scope a tool to specific tasks** in 2026.7.11, so the
  gate does not resolve wizard-only tools? Unverified - do not
  assume the syntax exists.
- **Is the `api.github.com` denial deliberate egress policy?**
  `/root/.ccr/README.md` says a 403 means the host is not allowed
  for the session and to report the blocked host rather than route
  around it. If the denial is intentional, "make aqua work" is the
  wrong frame and the fallback is the answer.
- **Does this affect the local CLI or CI at all?** No evidence
  either does; both resolve these tools normally. The blast radius
  looks confined to cloud agent sessions, but that has not been
  checked against a non-Anthropic sandbox.

## What to do meanwhile

Use the raw pnpm sequence, which is what the cloud sessions already
do:

```sh
pnpm install && pnpm test && pnpm check && pnpm lint && pnpm build && pnpm knip
```

It skips the Deno island (`functions-check`, `functions-test`), so a
change under `supabase/functions/` is not fully covered by it. See
[`../testing.md`](../testing.md).
