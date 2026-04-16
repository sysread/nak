#!/usr/bin/env node
// mise run doctor — verifies the local environment is ready for the wizard.
// Changes nothing. Safe to run anytime.
//
// Exit codes:
//   0 — wizard can run (green + blue items). Auth/scope items that the
//       wizard resolves automatically are printed as info, not blockers.
//   1 — at least one hard blocker the wizard can't fix on its own.
import { banner, step, info, ok, warn, hint, fail, style } from './lib/ui.mjs';
import { which } from './lib/shell.mjs';
import { ghAvailable, ghAuthStatus, REQUIRED_SCOPES } from './lib/github.mjs';
import { supaAvailable, readAccessToken } from './lib/supabase.mjs';
import { getRepoSlug, pagesUrl } from './lib/repo.mjs';

let blockers = 0;
let wizardWillFix = 0;

banner('Nak — environment doctor');

step(1, 'Shell tools');
for (const bin of ['node', 'git', 'pnpm']) {
  const path = await which(bin);
  if (path) ok(`${bin} found at ${style.dim(path)}`);
  else {
    fail(`${bin} not found on PATH`);
    blockers++;
  }
}

step(2, 'GitHub CLI');
if (!(await ghAvailable())) {
  fail('gh not on PATH.');
  hint('Install from https://cli.github.com/ (brew install gh) or via mise.');
  blockers++;
} else {
  ok('gh binary present');
  const status = await ghAuthStatus();
  if (!status.ok) {
    info('gh is not authenticated yet.');
    hint('The wizard will log you in. Or run `gh auth login` now.');
    wizardWillFix++;
  } else {
    ok('gh is authenticated');
    if (!status.hasAllScopes) {
      info(`gh token is missing scope(s): ${status.missingScopes.join(', ')}`);
      hint(
        `The wizard will refresh them. Or run \`gh auth refresh -s ${status.missingScopes.join(' -s ')}\` now.`
      );
      wizardWillFix++;
    } else {
      ok(`gh token has required scopes (${REQUIRED_SCOPES.join(', ')})`);
    }
  }
}

step(3, 'Supabase CLI');
if (!(await supaAvailable())) {
  fail('supabase not on PATH.');
  hint('Install: https://supabase.com/docs/guides/cli (brew install supabase/tap/supabase).');
  blockers++;
} else {
  ok('supabase binary present');
  const token = await readAccessToken();
  if (!token) {
    info('supabase is not logged in yet.');
    hint('The wizard will log you in. Or run `supabase login` now.');
    wizardWillFix++;
  } else {
    ok('supabase access token present');
  }
}

step(4, 'Git remote');
try {
  const slug = await getRepoSlug();
  ok(`origin parses as ${style.bold(`${slug.owner}/${slug.repo}`)}`);
  info(`Pages will publish to ${style.bold(pagesUrl(slug))}`);
} catch (err) {
  fail(err.message);
  hint('Set a github remote, e.g. `git remote set-url origin https://github.com/<you>/<repo>`.');
  hint('SSH host aliases like `git@my-alias:owner/repo` are supported.');
  blockers++;
}

console.log('');
if (blockers === 0 && wizardWillFix === 0) {
  console.log(`${style.green('All checks passed.')} Run ${style.bold('mise run setup')} when ready.\n`);
  process.exit(0);
} else if (blockers === 0) {
  console.log(
    `${style.green('Ready.')} ${wizardWillFix} item(s) above will be handled automatically ` +
      `by ${style.bold('mise run setup')}.\n`
  );
  process.exit(0);
} else {
  console.log(
    `${style.yellow(`${blockers} blocker(s) to resolve before running the wizard.`)} ` +
      `(${wizardWillFix} more will be handled automatically once those are fixed.)\n`
  );
  process.exit(1);
}
