/**
 * Guardrail for the repo's markdown content.
 *
 * Docs are rendered in three places - GitHub (both trees), the in-app
 * Help modal (`docs/user/` only), and Claude sessions reading
 * `CLAUDE.md`. A broken list-marker or fence ladder in any of those
 * shows up as a silently-wrong render rather than a loud failure, so
 * we run markdownlint-cli2 here over the tree and fail the suite on
 * any violation.
 *
 * Calls markdownlint-cli2's programmatic `main()` API directly rather
 * than spawning a child process. Same glob expansion, config
 * discovery, and exit-code contract - just no `pnpm exec` process
 * spawn overhead (~1.4s saved on every test run).
 */

import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
// @ts-expect-error - markdownlint-cli2 is CommonJS with no .d.ts; we call main() by shape
import { main as markdownlintCli2 } from 'markdownlint-cli2';

// Patterns the lint should cover. markdownlint-cli2 expands the globs
// itself - we pass them as literals so pnpm + node don't pre-expand.
// Keep this in sync with the invocation documented in
// `docs/dev/build-deploy.md`.
const TARGETS = [
  'docs/**/*.md',
  'README.md',
  'CLAUDE.md',
  // Nested CLAUDE.md files in the source tree (e.g.
  // src/screens/CLAUDE.md, src/components/CLAUDE.md) are loaded by
  // Claude Code when files in their subtree are touched - same
  // rendering surface as the root CLAUDE.md, so they need the same
  // lint guardrail.
  'src/**/CLAUDE.md',
  // README files outside the docs tree (e.g.
  // supabase/functions/README.md, which describes the edge-function
  // half of the app and is rendered on GitHub when browsing the
  // subdirectory). Same lint coverage as the root README.
  'supabase/**/README.md',
];

const REPO_ROOT = join(__dirname, '..');

describe('markdown lints clean', () => {
  // CI runners (GitHub Actions ubuntu-latest) are slower than local
  // dev machines; the programmatic main() call can take 5+ seconds
  // there vs ~1s locally. The old spawnSync had a 30s timeout - this
  // matches that ceiling.
  it('passes markdownlint-cli2 across the repo', async () => {
    // markdownlint-cli2's `main` returns 0 on success, 1 on
    // violations, 2 on help/usage. It does config-file discovery
    // (`.markdownlint-cli2.jsonc`), glob expansion, and ignore
    // patterns internally - same behavior as the CLI, no process
    // spawn. We capture log output to surface violations in the test
    // reporter on failure.
    const lines: string[] = [];
    const exitCode = await markdownlintCli2({
      directory: REPO_ROOT,
      argv: TARGETS,
      logMessage: (msg: string) => lines.push(msg),
      logError: (msg: string) => lines.push(msg),
    });

    if (exitCode !== 0) {
      throw new Error(
        `markdownlint-cli2 reported violations (exit ${exitCode}):\n${lines.join('\n')}`,
      );
    }

    expect(exitCode).toBe(0);
  }, 30_000);
});