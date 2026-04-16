#!/usr/bin/env node
// mise run doctor — verifies the local environment is ready for the wizard.
// Changes nothing. Safe to run anytime.
import { banner, step, info, ok, warn, hint, fail, style } from './lib/ui.mjs';
import { which } from './lib/shell.mjs';
import { ghAvailable, ghAuthStatus } from './lib/github.mjs';
import { supaAvailable, readAccessToken } from './lib/supabase.mjs';
import { getRepoSlug, pagesUrl } from './lib/repo.mjs';

let problems = 0;

banner('BYO Chat — environment doctor');

step(1, 'Shell tools');
for (const bin of ['node', 'git', 'pnpm']) {
  const path = await which(bin);
  if (path) ok(`${bin} found at ${style.dim(path)}`);
  else {
    fail(`${bin} not found on PATH`);
    problems++;
  }
}

step(2, 'GitHub CLI');
if (!(await ghAvailable())) {
  fail('gh not on PATH.');
  hint('Run `mise install` in this repo to fetch it, or install from https://cli.github.com/.');
  problems++;
} else {
  ok('gh binary present');
  const status = await ghAuthStatus();
  if (!status.ok) {
    warn('gh is installed but not authenticated.');
    hint('Run `gh auth login --web --scopes repo,workflow,pages`.');
    problems++;
  } else {
    ok('gh is authenticated');
    if (!status.hasPagesScope) {
      warn('gh token is missing the `pages` scope.');
      hint('Run `gh auth refresh -s pages`.');
      problems++;
    } else {
      ok('gh token has the `pages` scope');
    }
  }
}

step(3, 'Supabase CLI');
if (!(await supaAvailable())) {
  fail('supabase not on PATH.');
  hint('Run `mise install` in this repo, or install from https://supabase.com/docs/guides/cli.');
  problems++;
} else {
  ok('supabase binary present');
  const token = await readAccessToken();
  if (!token) {
    warn('supabase is installed but not logged in.');
    hint('Run `supabase login` (opens a browser), or export SUPABASE_ACCESS_TOKEN.');
    problems++;
  } else {
    ok('supabase access token present');
  }
}

step(4, 'Git remote');
try {
  const slug = await getRepoSlug();
  ok(`origin points at ${style.bold(`${slug.owner}/${slug.repo}`)}`);
  info(`Pages will publish to ${style.bold(pagesUrl(slug))}`);
} catch (err) {
  fail(err.message);
  hint('Set a github.com remote: `git remote add origin https://github.com/<you>/<repo>`.');
  problems++;
}

console.log('');
if (problems === 0) {
  console.log(`${style.green('All checks passed.')} Run ${style.bold('mise run setup')} when ready.\n`);
  process.exit(0);
} else {
  console.log(
    `${style.yellow(`${problems} issue(s) to resolve before running the wizard.`)}\n`
  );
  process.exit(1);
}
