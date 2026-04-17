#!/usr/bin/env node
// mise run supabase-init — creates (or links) a Supabase project, applies
// the schema, configures auth URL allowlist for the fork's Pages URL, and
// prints the Supabase URL + anon key.
//
// Can be chained from bootstrap.mjs by passing `--output <path>`; the script
// writes the result as JSON to that path (in addition to printing a summary
// to the terminal) so the caller can read it back without intercepting stdio.
import { readFile, writeFile } from 'node:fs/promises';
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
  confirm,
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
  adminCreateUser,
  adminListUsers,
  adminUpdateUserPassword,
} from './lib/supabase.mjs';
import { buildAuthConfigPatch } from './lib/auth-config.mjs';
import { getRepoSlug, pagesUrl } from './lib/repo.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = join(__dirname, '..', 'supabase', 'schema.sql');

// Parse --output <path> if present. Everything else is interactive.
let outputPath = null;
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--output' && process.argv[i + 1]) {
    outputPath = process.argv[i + 1];
    i++;
  }
}

banner('Supabase setup');

if (!(await supaAvailable())) {
  bail(
    'supabase CLI not found.',
    'Run `mise install`, or install from https://supabase.com/docs/guides/cli.'
  );
}

step(1, 'Authenticate with Supabase');
let token = await readAccessToken();
if (!token) {
  info('No access token found — opening the browser to log you in.');
  hint('If you prefer, cancel and export SUPABASE_ACCESS_TOKEN instead.');
  await supaLoginInteractive();
  token = await readAccessToken();
  if (!token) bail('Supabase login did not produce an access token.');
}
ok('Supabase access token present.');

step(2, 'Pick or create a project');
const existing = await listProjects();
const options = [
  { label: style.bold('Create a new project'), value: { kind: 'new' } },
  ...existing.map((p) => ({
    label: `Use existing: ${style.bold(p.name)} ${style.dim(`(${p.id})`)}`,
    value: { kind: 'existing', project: p },
  })),
];
const chosen = await choose('Which project should this fork use?', options);

let project;
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
  const defaultName = `nak-${Date.now().toString(36)}`;
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

step(3, 'Apply schema.sql');
const schema = await readFile(SCHEMA_PATH, 'utf8');
try {
  await runSql(project.id, schema);
  ok('Schema applied.');
} catch (err) {
  warn('Running the schema via Management API failed.');
  hint('Falling back: paste supabase/schema.sql into the SQL Editor yourself.');
  console.error(`    ${style.dim(err.message)}`);
}

step(4, 'Configure auth');
const slug = await getRepoSlug();
const url = pagesUrl(slug);
info(
  'Pick a sign-up policy for this project. You can change it later in ' +
    'Supabase → Authentication → Providers → Email.'
);
const allowSignups = await choose('Allow public sign-ups for this project?', [
  {
    label:
      style.bold('No') +
      ' — only admin-created accounts can sign in (recommended for personal use)',
    value: false,
  },
  {
    label:
      style.bold('Yes') +
      ' — anyone who knows the URL can create an account',
    value: true,
  },
]);
let requireConfirmation = false;
if (allowSignups) {
  requireConfirmation = await confirm(
    'Require email confirmation on sign-up? (needs working SMTP)',
    { default: false }
  );
}

const supabaseUrl = `https://${project.id}.supabase.co`;

try {
  const current = await getAuthConfig(project.id);
  const patch = buildAuthConfigPatch({
    currentConfig: current,
    pagesUrl: url,
    allowSignups,
    requireConfirmation,
  });
  await updateAuthConfig(project.id, patch);
  ok(
    `Auth configured: sign-ups ${style.bold(allowSignups ? 'enabled' : 'disabled')}, ` +
      `email confirmation ${style.bold(patch.mailer_autoconfirm ? 'off' : 'on')}.`
  );
  info(`Site URL and redirect allowlist now include ${style.bold(url)}`);
} catch (err) {
  warn(`Could not update auth config automatically: ${err.message}`);
  hint(
    `Open Supabase Dashboard → Authentication → URL Configuration and add "${url}" to Site URL and Redirect URLs.`
  );
  hint(
    'Also toggle "Confirm email" and "Enable sign-ups" in Authentication → Providers → Email.'
  );
}

step(5, 'Create the main user account');
info(
  'This seeds your login directly on the Supabase project using the ' +
    'service-role key. The email is auto-confirmed, so you can sign in ' +
    'immediately with no email round-trip.'
);
info(
  `${style.dim('Tip:')} the service-role key stays on your machine — it is never ` +
    'written to the app or the setup link.'
);

const keys = await getProjectApiKeys(project.id);
const anon = keys.find((k) => k.name === 'anon' || k.tags?.includes('anon'));
const serviceRole = keys.find(
  (k) => k.name === 'service_role' || k.tags?.includes('service_role')
);
if (!anon) bail('Could not locate the anon API key for this project.');

const wantsUser = await confirm('Create a main user account now?', { default: true });
if (wantsUser) {
  if (!serviceRole) {
    warn('Could not locate the service_role key — skipping user creation.');
    hint(
      'Create a user manually in Supabase → Authentication → Users, or rerun the wizard later.'
    );
  } else {
    const email = await ask('Email');
    if (!email || !email.includes('@')) bail('Email is required.');
    const password = await ask('Password (min 8 chars)', { secret: true });
    if ((password || '').length < 8) bail('Password is too short.');

    try {
      await adminCreateUser(supabaseUrl, serviceRole.api_key, { email, password });
      ok(`User ${style.bold(email)} created. You can sign in immediately.`);
    } catch (err) {
      if (err.status === 422) {
        info(`A user with email ${style.bold(email)} already exists.`);
        const reset = await confirm('Reset their password to the value you just typed?', {
          default: false,
        });
        if (reset) {
          try {
            const users = await adminListUsers(supabaseUrl, serviceRole.api_key);
            const existingUser = users.find(
              (u) => u.email?.toLowerCase() === email.toLowerCase()
            );
            if (!existingUser) {
              warn('Could not locate the existing user to reset.');
            } else {
              await adminUpdateUserPassword(
                supabaseUrl,
                serviceRole.api_key,
                existingUser.id,
                password
              );
              ok(`Password reset for ${style.bold(email)}.`);
            }
          } catch (e) {
            warn(`Password reset failed: ${e.message}`);
            hint('Reset the password manually in Supabase → Authentication → Users.');
          }
        } else {
          info('Leaving the existing user untouched.');
        }
      } else {
        warn(`Could not create the user automatically: ${err.message}`);
        hint('Create one manually in Supabase → Authentication → Users.');
      }
    }
  }
} else {
  info('Skipping user creation.');
  if (!allowSignups) {
    warn(
      'Heads up: you disabled sign-ups but did not create a user. ' +
        'Re-run this task or add a user manually before you can sign in.'
    );
  } else {
    hint('You can sign up from the app once it is deployed.');
  }
}

const result = {
  supabaseUrl,
  supabaseAnonKey: anon.api_key,
  projectRef: project.id,
  pagesUrl: url,
};

if (outputPath) {
  await writeFile(outputPath, JSON.stringify(result), 'utf8');
}

console.log(
  `\n${style.green('Supabase is ready.')}\n` +
    `  ${style.dim('Supabase URL:')} ${style.bold(supabaseUrl)}\n` +
    `  ${style.dim('Anon key    :')} ${style.bold(anon.api_key.slice(0, 12))}…${style.dim(' (hidden)')}\n` +
    `  ${style.dim('Project ref :')} ${style.bold(project.id)}\n`
);
