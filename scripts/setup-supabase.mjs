#!/usr/bin/env node
// mise run supabase-init — creates (or links) a Supabase project, applies
// the schema, configures auth URL allowlist for the fork's Pages URL, and
// prints the Supabase URL + anon key.
//
// Returns (via stdout JSON when --json is passed) for downstream chaining.
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  banner,
  step,
  info,
  ok,
  warn,
  hint,
  bail,
  ask,
  choose,
  style,
} from './lib/ui.mjs';
import {
  supaAvailable,
  supaLoginInteractive,
  readAccessToken,
  listOrgs,
  listProjects,
  createProject,
  getProjectApiKeys,
  getAuthConfig,
  updateAuthConfig,
  waitForProject,
  runSql,
} from './lib/supabase.mjs';
import { getRepoSlug, pagesUrl } from './lib/repo.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = join(__dirname, '..', 'supabase', 'schema.sql');

const jsonMode = process.argv.includes('--json');
const log = jsonMode ? () => {} : undefined; // only suppress ui.* in json mode

if (!jsonMode) banner('Supabase setup');

if (!(await supaAvailable())) {
  bail(
    'supabase CLI not found.',
    'Run `mise install` in this repo, or install from https://supabase.com/docs/guides/cli.'
  );
}

if (!jsonMode) step(1, 'Authenticate with Supabase');
let token = await readAccessToken();
if (!token) {
  if (!jsonMode) {
    info('No access token found — opening the browser to log you in.');
    hint('If you prefer, you can cancel and set SUPABASE_ACCESS_TOKEN instead.');
  }
  await supaLoginInteractive();
  token = await readAccessToken();
  if (!token) bail('Supabase login did not produce an access token.');
}
if (!jsonMode) ok('Supabase access token present.');

if (!jsonMode) step(2, 'Pick or create a project');
const existing = await listProjects();
let project = null;

const options = [
  { label: `${style.bold('Create a new project')}`, value: { kind: 'new' } },
  ...existing.map((p) => ({
    label: `Use existing: ${style.bold(p.name)} ${style.dim(`(${p.id})`)}`,
    value: { kind: 'existing', project: p },
  })),
];

if (jsonMode && existing.length === 0) {
  bail('No existing projects found and --json mode cannot prompt to create one.');
}

const chosen = jsonMode
  ? { kind: 'existing', project: existing[0] }
  : await choose('Which project should this fork use?', options);

if (chosen.kind === 'new') {
  const orgs = await listOrgs();
  let orgId;
  if (orgs.length === 0) {
    bail(
      'No Supabase organizations found for your account.',
      'Create one at https://supabase.com/dashboard, then re-run.'
    );
  } else if (orgs.length === 1) {
    orgId = orgs[0].id;
    info(`Using your organization: ${style.bold(orgs[0].name)}`);
  } else {
    orgId = await choose(
      'Which organization?',
      orgs.map((o) => ({ label: `${o.name} ${style.dim(`(${o.id})`)}`, value: o.id }))
    );
  }
  const defaultName = `byo-chat-${Date.now().toString(36)}`;
  const name = await ask('Project name', { default: defaultName });
  const region = await ask('Region (see https://supabase.com/docs/guides/platform/regions)', {
    default: 'us-east-1',
  });
  const dbPassword = await ask('Database password (min 12 chars, save this somewhere!)', {
    secret: true,
  });
  if ((dbPassword || '').length < 12) bail('Database password too short.');

  info('Creating the project — this can take 60-90 seconds...');
  const created = await createProject({ name, orgId, region, dbPassword });
  info(`Project created: ${style.bold(created.name)} (${created.id}). Waiting for it to become healthy...`);
  project = await waitForProject(created.id);
  ok('Project is healthy.');
} else {
  project = chosen.project;
  info(`Using existing project: ${style.bold(project.name)} (${project.id})`);
}

if (!jsonMode) step(3, 'Apply schema.sql');
const schema = await readFile(SCHEMA_PATH, 'utf8');
try {
  await runSql(project.id, schema);
  ok('Schema applied.');
} catch (err) {
  warn('Running the schema via Management API failed.');
  hint('Falling back: run it yourself in Supabase SQL Editor with the contents of supabase/schema.sql.');
  if (!jsonMode) console.error(`    ${style.dim(err.message)}`);
}

if (!jsonMode) step(4, 'Whitelist your Pages URL in auth settings');
const slug = await getRepoSlug();
const url = pagesUrl(slug);
try {
  const current = await getAuthConfig(project.id);
  // uri_allow_list is a comma-separated string per Supabase Management API.
  const existingAllow = (current.uri_allow_list || '').split(',').map((s) => s.trim()).filter(Boolean);
  const wanted = [
    url,
    `${url}*`, // wildcard for the subpath
  ];
  const merged = Array.from(new Set([...existingAllow, ...wanted]));
  await updateAuthConfig(project.id, {
    site_url: current.site_url || url,
    uri_allow_list: merged.join(','),
  });
  ok(`Site URL and redirect allowlist now include ${style.bold(url)}`);
} catch (err) {
  warn(`Could not update auth URL config automatically: ${err.message}`);
  hint(
    `Open Supabase Dashboard → Authentication → URL Configuration and add "${url}" to Site URL and Redirect URLs.`
  );
}

if (!jsonMode) step(5, 'Fetch anon key');
const keys = await getProjectApiKeys(project.id);
const anon = keys.find((k) => k.name === 'anon' || k.tags?.includes('anon'));
if (!anon) bail('Could not locate the anon API key for this project.');
const supabaseUrl = `https://${project.id}.supabase.co`;

if (jsonMode) {
  process.stdout.write(
    JSON.stringify({
      supabaseUrl,
      supabaseAnonKey: anon.api_key,
      projectRef: project.id,
      pagesUrl: url,
    }) + '\n'
  );
} else {
  ok('Got the anon key.');
  console.log(
    `\n${style.green('Supabase is ready.')} Copy these if you need them:\n` +
      `  ${style.dim('Supabase URL:')} ${style.bold(supabaseUrl)}\n` +
      `  ${style.dim('Anon key    :')} ${style.bold(anon.api_key.slice(0, 12))}…${style.dim('(hidden)')}\n` +
      `  ${style.dim('Project ref :')} ${style.bold(project.id)}\n`
  );
}
