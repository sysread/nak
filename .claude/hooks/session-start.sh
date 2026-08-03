#!/bin/bash
# SessionStart hook: trust the repo's mise config, then resync the
# sandbox's local `main` with `origin/main`.
#
# Problem this solves: Claude Code's web sandbox shares filesystem
# state across sessions. Local `main` drifts from `origin/main` as
# prior sessions merge branches locally without pushing (or push
# feature branches without rebasing main). A new session that cuts
# a feature branch from a stale local main ends up parented on dead
# history, which produces merge commits and phantom history when
# the web UI's "merge to main" later reconciles the two.
#
# Fix: at every session start, bring local main into line with what
# the remote actually says. Feature branches always get cut from
# real upstream state.
#
# Destructive by design: the sandbox's local main has no independent
# value, it's a cache. We reset it without ceremony. The current
# working branch (if not main) is left alone - the hook updates the
# main ref out-of-band via `git update-ref` rather than checking main
# out and reverting, so a mid-session resume/clear/compact on a
# feature branch doesn't disturb in-progress work.
#
# Scoped to Claude Code on the web via $CLAUDE_CODE_REMOTE. On a
# local dev machine this would be wildly inappropriate - the user's
# actual main is not disposable there.
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "$CLAUDE_PROJECT_DIR"

# Trust the repo's mise config. The trust db lives in the container's
# home directory, so every fresh sandbox starts untrusted and the
# first `mise run` dies with a misleading "error parsing config file"
# until someone trusts it. Idempotent; non-fatal so a missing mise
# binary doesn't block the git sync below.
if command -v mise >/dev/null 2>&1; then
  mise trust "$CLAUDE_PROJECT_DIR/.mise.toml" || true
fi

# Defensive: skip if not a git repo.
if ! git rev-parse --git-dir >/dev/null 2>&1; then
  exit 0
fi

# Fetch failure is non-fatal - better to continue with stale state
# than to block the session on a transient network hiccup. A session
# that can't reach the remote has bigger problems than a stale main.
if ! git fetch -p origin 2>&1; then
  echo "session-start: git fetch failed, continuing with stale state"
  exit 0
fi

# No origin/main ref means nothing to sync against (fresh clone of a
# repo that uses a different default branch, say). Skip cleanly.
if ! git rev-parse --verify origin/main >/dev/null 2>&1; then
  echo "session-start: no origin/main ref, skipping main sync"
  exit 0
fi

current=$(git branch --show-current || true)

if [ "$current" = "main" ]; then
  # Currently on main - do the full destructive reset. Any
  # uncommitted work or divergent commits on main at this point are
  # a prior session's leftover state, not user work worth preserving.
  git reset --hard origin/main
  git clean -fd
else
  # On a feature branch (or detached HEAD). Force-move the local
  # main ref to origin/main without touching the working tree.
  # `git update-ref` works regardless of whether main and origin/main
  # have diverged, so this covers the "50 ahead / 78 behind" case
  # that motivated the hook.
  git update-ref refs/heads/main "$(git rev-parse origin/main)"
fi
