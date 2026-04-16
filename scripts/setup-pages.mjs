#!/usr/bin/env node
// mise run pages-enable — turns on GitHub Pages with Actions as the source
// and grants the workflow write permissions so deploy.yml can publish.
// Idempotent: re-running is safe.
import {
  banner,
  step,
  info,
  ok,
  warn,
  hint,
  bail,
  confirm,
  style,
} from './lib/ui.mjs';
import {
  ghAvailable,
  ghAuthStatus,
  ghLoginInteractive,
  ghRefreshScopes,
  ghApi,
  ghApiJson,
  REQUIRED_SCOPES,
} from './lib/github.mjs';
import { getRepoSlug, pagesUrl } from './lib/repo.mjs';

banner('Enable GitHub Pages');

step(1, 'Verify gh is installed and authenticated');
if (!(await ghAvailable())) {
  bail(
    'gh CLI not found.',
    'Run `mise install` in this repo to fetch it, or install from https://cli.github.com/.'
  );
}
let status = await ghAuthStatus();
if (!status.ok) {
  warn('gh is not authenticated — starting login flow.');
  info('A browser window will open. Paste the one-time code gh shows you.');
  await ghLoginInteractive();
  status = await ghAuthStatus();
  if (!status.ok) bail('gh login did not complete.');
}
ok('gh is authenticated.');

if (!status.hasAllScopes) {
  info(`gh token is missing required scope(s): ${style.bold(status.missingScopes.join(', '))}`);
  hint('Opening a browser so GitHub can grant them.');
  await ghRefreshScopes(status.missingScopes);
  const after = await ghAuthStatus();
  if (!after.hasAllScopes) {
    bail(
      `Still missing: ${after.missingScopes.join(', ')}.`,
      `Try \`gh auth refresh -s ${after.missingScopes.join(' -s ')}\` manually.`
    );
  }
}
ok(`gh token has required scopes: ${style.dim(REQUIRED_SCOPES.join(', '))}`);

const { owner, repo } = await getRepoSlug();
info(`Target repository: ${style.bold(`${owner}/${repo}`)}`);

step(2, 'Enable Pages (source = GitHub Actions)');
// POST creates the Pages site, PUT updates config. POST 409s if Pages is
// already enabled; we handle that by issuing a PUT instead.
const createRes = await ghApi('POST', `/repos/${owner}/${repo}/pages`, [
  ['build_type', 'workflow'],
]);
if (createRes.code === 0) {
  ok('Pages site created with Actions as the source.');
} else if (/409|exists|already/i.test(createRes.stderr + createRes.stdout)) {
  info('Pages is already enabled — updating the source to Actions.');
  const updateRes = await ghApi('PUT', `/repos/${owner}/${repo}/pages`, [
    ['build_type', 'workflow'],
  ]);
  if (updateRes.code !== 0) {
    bail(
      `Failed to set Pages source: ${updateRes.stderr.trim()}`,
      'Open Settings → Pages and pick "GitHub Actions" under Source.'
    );
  }
  ok('Pages source set to GitHub Actions.');
} else {
  bail(
    `Failed to enable Pages: ${createRes.stderr.trim() || createRes.stdout.trim()}`,
    'Open Settings → Pages and pick "GitHub Actions" under Source, then re-run this.'
  );
}

step(3, 'Grant workflow write permissions');
// Needed so the deploy workflow can request an OIDC token and upload the
// pages artifact. Equivalent to Settings → Actions → "Read and write
// permissions" on the repo.
const permRes = await ghApi(
  'PUT',
  `/repos/${owner}/${repo}/actions/permissions/workflow`,
  [
    ['default_workflow_permissions', 'write'],
    ['can_approve_pull_request_reviews', 'false'],
  ]
);
if (permRes.code !== 0) {
  warn('Could not set workflow permissions automatically.');
  hint(
    'Open Settings → Actions → General → Workflow permissions and pick ' +
      '"Read and write permissions".'
  );
} else {
  ok('Workflow permissions set to read+write.');
}

step(4, 'Kick off the first deploy');
const yes = await confirm(
  'Trigger the `Deploy` workflow now? (Otherwise it runs on next push to main.)',
  { default: true }
);
if (yes) {
  try {
    await ghApiJson('POST', `/repos/${owner}/${repo}/actions/workflows/deploy.yml/dispatches`, [
      ['ref', 'main'],
    ]);
    ok('Deploy workflow dispatched.');
    info('Watch progress with: ' + style.bold('gh run watch'));
  } catch (err) {
    warn(`Could not dispatch the workflow: ${err.message}`);
    hint('Push a commit to main to trigger it, or run it from the Actions tab.');
  }
}

console.log(
  `\n${style.green('Pages is configured.')} Once the deploy finishes, your app will live at:\n  ${style.bold(pagesUrl({ owner, repo }))}\n`
);
