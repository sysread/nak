/**
 * Guardrail for the repo's markdown content.
 *
 * Docs are rendered in three places — GitHub (both trees), the in-app
 * Help modal (`docs/user/` only), and Claude sessions reading
 * `CLAUDE.md`. A broken list-marker or fence ladder in any of those
 * shows up as a silently-wrong render rather than a loud failure, so
 * we run markdownlint-cli2 here over the tree and fail the suite on
 * any violation.
 *
 * Tooling note: `markdownlint-cli2` is pinned in `.mise.toml` rather
 * than `package.json`. Keeping it in mise means the same binary is
 * used locally (via `mise exec`) and in CI (via the `jdx/mise-action`
 * step in `.github/workflows/tests.yml`), and we don't drag node_modules
 * bloat into the main app bundle path for a dev-only tool. The test
 * invokes it via `mise exec` so a system-wide homebrew install (which
 * might be a different version) can't shadow the pin.
 */

import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';

// Patterns the lint should cover. markdownlint-cli2 expands the globs
// itself — we pass them as literals so mise + node don't pre-expand.
// Keep this in sync with the invocation documented in
// `docs/dev/build-deploy.md`.
const TARGETS = ['docs/**/*.md', 'README.md', 'CLAUDE.md'];

const REPO_ROOT = join(__dirname, '..');

describe('markdown lints clean', () => {
  it('passes markdownlint-cli2 across the repo', () => {
    const result = spawnSync('mise', ['exec', '--', 'markdownlint-cli2', ...TARGETS], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      // 30s is generous; a clean run over the current tree is sub-second,
      // but the first invocation after a fresh `mise install` may have
      // to resolve the tool.
      timeout: 30_000,
    });

    // `spawnSync` sets `error` on ENOENT / ETIMEDOUT / etc. Treat it as
    // a test failure with the underlying message — there's nothing
    // useful we can do in the test itself.
    if (result.error) {
      throw new Error(
        `Failed to invoke mise exec markdownlint-cli2: ${result.error.message}. ` +
          `Is mise installed? Run \`mise install\` to provision dev tools.`,
      );
    }

    // markdownlint-cli2 exits 0 on success, non-zero on any rule
    // violation. The violations themselves go to stderr in a
    // file:line:column format that matches the editor convention, so
    // we surface both stdout and stderr verbatim to the test reporter.
    if (result.status !== 0) {
      const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
      throw new Error(
        `markdownlint-cli2 reported violations (exit ${result.status}):\n${output}`,
      );
    }

    expect(result.status).toBe(0);
  });
});
