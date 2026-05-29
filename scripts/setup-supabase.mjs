#!/usr/bin/env node
// mise run supabase-init — creates (or links) a Supabase project, applies
// the schema, configures auth URL allowlist for the fork's Pages URL, and
// prints the Supabase URL + publishable key.
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
  askSecretTwice,
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
import { loadState, saveState } from './lib/state-file.mjs';
import { gumAvailable, gumChoose, gumInput } from './lib/gum.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = join(__dirname, '..', 'supabase', 'schema.sql');

// Application config stored in the project-global app_config table (see
// supabase/schema.sql - one shared row, not keyed to a user). Data-driven so
// adding a field is a single entry here: the config step renders a gum input
// per field and upserts it via the Management API. Column names come from this
// list (never from user input), so they are safe to interpolate into SQL;
// values are escaped in writeConfigField.
const CONFIG_FIELDS = [
  {
    column: 'venice_api_key',
    label: 'Venice API key',
    description:
      'shared key the edge function and browser use for Venice calls (Admin-tier needed for the Usage view)',
    hint:
      'Use a Venice ADMIN API key: the in-app Usage (billing) view calls Venice billing, which 401s on a standard key. A standard key still works for chat and embeddings. Keys: https://venice.ai/settings/api',
    secret: true,
  },
];

async function readAppConfig(ref) {
  const cols = CONFIG_FIELDS.map((f) => f.column).join(', ');
  const rows = await runSql(ref, `select ${cols} from public.app_config where id = true;`);
  return Array.isArray(rows) ? (rows[0] ?? {}) : {};
}

async function writeConfigField(ref, column, value) {
  // Escape single quotes by doubling - the correct escape for Postgres
  // standard-conforming strings (on by default; backslashes are literal). The
  // Management API query endpoint takes raw SQL with no parameter binding.
  const escaped = value.replace(/'/g, "''");
  await runSql(
    ref,
    `insert into public.app_config (id, ${column}) values (true, '${escaped}')
       on conflict (id) do update set ${column} = excluded.${column}, updated_at = now();`
  );
}

async function promptConfigField(field) {
  if (field.hint) hint(field.hint);
  const value = await gumInput({
    header: `Enter ${field.label}`,
    password: field.secret === true,
  });
  // gumInput returns null for a blank entry, treated as "no change". Reject
  // control characters - a pasted secret should never contain them, and they
  // would corrupt the SQL literal in writeConfigField.
  if (value !== null && [...value].some((c) => c.charCodeAt(0) < 0x20)) {
    warn('That value contains control characters; leaving it unchanged.');
    return null;
  }
  return value;
}

// Interactive editor for the app_config row. First-time (nothing set yet)
// walks through each field; once values exist it shows a gum menu of the
// fields with their set/unset state and a description, looping so several can
// be edited in one pass.
async function manageConfig(ref) {
  if (!(await gumAvailable())) {
    warn('gum is not installed, so the interactive config editor is unavailable.');
    hint('Run `mise install` to get it, then re-run this task to set the Venice API key.');
    return;
  }

  let current;
  try {
    current = await readAppConfig(ref);
  } catch (err) {
    warn(`Could not read app_config: ${err.message}`);
    hint('If the schema apply above failed, fix that first - app_config lives in schema.sql.');
    return;
  }

  if (!CONFIG_FIELDS.some((f) => current[f.column])) {
    info('No application config set yet - walking through each value.');
    for (const field of CONFIG_FIELDS) {
      const value = await promptConfigField(field);
      if (value !== null) {
        await writeConfigField(ref, field.column, value);
        ok(`${field.label} set.`);
      } else {
        warn(`${field.label} left unset.`);
      }
    }
    return;
  }

  const DONE = 'Done - continue setup';
  const labelFor = (f) =>
    `${f.label} (${current[f.column] ? 'set' : 'unset'}) - ${f.description}`;
  for (;;) {
    const chosen = await gumChoose('Which config value would you like to change?', [
      ...CONFIG_FIELDS.map(labelFor),
      DONE,
    ]);
    if (chosen === null || chosen === DONE) break;
    const field = CONFIG_FIELDS.find((f) => labelFor(f) === chosen);
    if (!field) break;
    const value = await promptConfigField(field);
    if (value !== null) {
      await writeConfigField(ref, field.column, value);
      current[field.column] = value;
      ok(`${field.label} updated.`);
    }
  }
}

// Seed the two Vault secrets the pg_cron embedding backfill reads at dispatch
// time (see supabase/schema.sql, nak_trigger_embed_backfill). Idempotent:
// updates the secret in place when it already exists, creates it otherwise.
// `project_url` is the edge-function base; `service_role_key` MUST be the legacy
// JWT key - the function gateway rejects a non-JWT (sb_secret_) bearer.
async function seedCronSecrets(ref, projectUrl, serviceRoleKey) {
  const esc = (v) => String(v).replace(/'/g, "''");
  await runSql(
    ref,
    `do $$
declare v_id uuid;
begin
  select id into v_id from vault.secrets where name = 'project_url';
  if v_id is null then
    perform vault.create_secret('${esc(projectUrl)}', 'project_url', 'nak: edge-function base URL for cron backfill');
  else
    perform vault.update_secret(v_id, '${esc(projectUrl)}', 'project_url');
  end if;
  select id into v_id from vault.secrets where name = 'service_role_key';
  if v_id is null then
    perform vault.create_secret('${esc(serviceRoleKey)}', 'service_role_key', 'nak: legacy JWT service-role key for cron->function auth');
  else
    perform vault.update_secret(v_id, '${esc(serviceRoleKey)}', 'service_role_key');
  end if;
end $$;`
  );
}

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
// A prior run records the linked project in .nak/state.json. On a re-run we
// default the picker to that project (and frame the rest of the wizard as an
// update) instead of steering toward a brand-new one.
const priorState = await loadState();
const priorRef = priorState?.supabase?.projectRef ?? null;
const existing = await listProjects();
const options = [
  { label: style.bold('Create a new project'), value: { kind: 'new' } },
  ...existing.map((p) => ({
    label: `Use existing: ${style.bold(p.name)} ${style.dim(`(${p.id})`)}`,
    value: { kind: 'existing', project: p },
  })),
];
// Default to the previously-linked project if it still exists; otherwise the
// first option (create new). options[0] is "new", so existing projects are
// offset by 1.
const priorOptionIndex = priorRef ? existing.findIndex((p) => p.id === priorRef) : -1;
if (priorOptionIndex >= 0) {
  info(
    `Previously linked project ${style.bold(existing[priorOptionIndex].name)} ` +
      'is the default below.'
  );
}
const chosen = await choose('Which project should this fork use?', options, {
  defaultIndex: priorOptionIndex >= 0 ? priorOptionIndex + 1 : 0,
});
const isExistingProject = chosen.kind === 'existing';

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
  const dbPassword = await askSecretTwice(
    'Database password (min 12 chars, save this somewhere!)',
    { minLength: 12 }
  ).catch((err) => bail(err.message));

  info('Creating the project — this can take 60-90 seconds...');
  const created = await createProject({ name, orgId, region, dbPassword });
  info(`Project created: ${style.bold(created.name)} (${created.id}). Waiting for it to become healthy...`);
  project = await waitForProject(created.id);
  ok('Project is healthy.');
} else {
  project = chosen.project;
  info(`Using existing project: ${style.bold(project.name)} (${project.id})`);
}

// Persist the linked project so `mise run sync` doesn't have to re-ask.
await saveState({ ...(priorState ?? {}), supabase: { projectRef: project.id } });

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

step(4, 'Set application config');
await manageConfig(project.id);

step(5, 'Configure auth');
const slug = await getRepoSlug();
const url = pagesUrl(slug);
// For an existing project, read the current auth config up front so the
// prompts below default to what is already set (an update, not a reset). New
// projects start from the recommended personal-use defaults: sign-ups off,
// confirmation off.
let currentAuth = null;
if (isExistingProject) {
  currentAuth = await getAuthConfig(project.id).catch((err) => {
    warn(`Could not read current auth config: ${err.message}`);
    return null;
  });
}
const currentAllowSignups = currentAuth ? !currentAuth.disable_signup : false;
const currentRequireConfirmation = currentAuth ? !currentAuth.mailer_autoconfirm : false;

info(
  (isExistingProject
    ? "Update the sign-up policy - defaults reflect the project's current setting. "
    : 'Pick a sign-up policy for this project. ') +
    'You can change it later in Supabase → Authentication → Providers → Email.'
);
const allowSignups = await choose(
  'Allow public sign-ups for this project?',
  [
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
  ],
  { defaultIndex: currentAllowSignups ? 1 : 0 }
);
let requireConfirmation = false;
if (allowSignups) {
  requireConfirmation = await confirm(
    'Require email confirmation on sign-up? (needs working SMTP)',
    { default: currentRequireConfirmation }
  );
}

const supabaseUrl = `https://${project.id}.supabase.co`;

try {
  const current = currentAuth ?? (await getAuthConfig(project.id));
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

step(6, 'Create the main user account');
info(
  'This seeds your login directly on the Supabase project using the secret ' +
    'key (SUPABASE_SECRET_KEY, or the legacy service-role key as a fallback). ' +
    'The email is auto-confirmed, so you can sign in immediately with no ' +
    'email round-trip.'
);
info(
  `${style.dim('Tip:')} the secret key stays on your machine — it is never ` +
    'written to the app or the setup link.'
);

const keys = await getProjectApiKeys(project.id);
// The Management API /api-keys response tags the modern keys with
// type 'publishable' / 'secret' (both named "default"); the legacy pair is
// type 'legacy', named 'anon' / 'service_role'. Prefer the modern keys and
// fall back to legacy, so projects that never created the new keys still work
// and disabling the legacy keys doesn't break this wizard.
const clientKey =
  keys.find((k) => k.type === 'publishable') ||
  keys.find((k) => k.name === 'anon' || k.tags?.includes('anon'));
const secretKey =
  keys.find((k) => k.type === 'secret') ||
  keys.find((k) => k.name === 'service_role' || k.tags?.includes('service_role'));
if (!clientKey) {
  bail('Could not locate a publishable (or legacy anon) API key for this project.');
}

// Key for the GoTrue admin calls (user creation/reset) below. Prefer the
// modern secret key from the environment (SUPABASE_SECRET_KEY); else the
// project's secret key fetched above; legacy service_role last. This is a
// service-role-class secret - it bypasses RLS and the app never sees it.
const adminKey = process.env.SUPABASE_SECRET_KEY?.trim() || secretKey?.api_key;

const wantsUser = await confirm('Create a main user account now?', { default: true });
if (wantsUser) {
  if (!adminKey) {
    warn('No secret key available (set SUPABASE_SECRET_KEY, or expose the legacy service_role key) — skipping user creation.');
    hint(
      'Create a user manually in Supabase → Authentication → Users, or rerun the wizard later.'
    );
  } else {
    const email = await ask('Email');
    if (!email || !email.includes('@')) bail('Email is required.');
    const password = await askSecretTwice('Password (min 8 chars)', {
      minLength: 8,
    }).catch((err) => bail(err.message));

    try {
      await adminCreateUser(supabaseUrl, adminKey, { email, password });
      ok(`User ${style.bold(email)} created. You can sign in immediately.`);
    } catch (err) {
      if (err.status === 422) {
        info(`A user with email ${style.bold(email)} already exists.`);
        const reset = await confirm('Reset their password to the value you just typed?', {
          default: false,
        });
        if (reset) {
          try {
            const users = await adminListUsers(supabaseUrl, adminKey);
            const existingUser = users.find(
              (u) => u.email?.toLowerCase() === email.toLowerCase()
            );
            if (!existingUser) {
              warn('Could not locate the existing user to reset.');
            } else {
              await adminUpdateUserPassword(
                supabaseUrl,
                adminKey,
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

step(7, 'Schedule background embedding backfill');
info(
  'Embedding backfill runs server-side on a pg_cron schedule that POSTs to the ' +
    'venice edge function. It authenticates with the legacy JWT service-role key, ' +
    'stored in Supabase Vault. Until both secrets are seeded the schedule no-ops.'
);
// Specifically the LEGACY JWT key: the function gateway validates the bearer as
// a JWT, and the modern opaque sb_secret_ key is not one (same reason the local
// realtime stack rejects sb_publishable_).
const legacyServiceRole =
  keys.find((k) => k.type === 'legacy' && k.name === 'service_role') ||
  keys.find((k) => k.name === 'service_role' || k.tags?.includes('service_role'));
if (!legacyServiceRole?.api_key) {
  warn('No legacy JWT service-role key available; cron backfill auth cannot be seeded.');
  hint(
    'Enable the legacy JWT keys in Supabase -> Project Settings -> API, then rerun this task. ' +
      'The modern sb_secret_ key will not work: the gateway rejects a non-JWT bearer.'
  );
} else {
  try {
    await seedCronSecrets(project.id, supabaseUrl, legacyServiceRole.api_key);
    ok('Cron backfill secrets seeded into Vault (project_url, service_role_key).');
  } catch (err) {
    warn(`Could not seed cron secrets: ${err.message}`);
    hint('Vault may be unavailable on this project; seed the secrets manually or rerun later.');
  }
}

const result = {
  supabaseUrl,
  supabasePublishableKey: clientKey.api_key,
  projectRef: project.id,
  pagesUrl: url,
};

if (outputPath) {
  await writeFile(outputPath, JSON.stringify(result), 'utf8');
}

console.log(
  `\n${style.green('Supabase is ready.')}\n` +
    `  ${style.dim('Supabase URL:')} ${style.bold(supabaseUrl)}\n` +
    `  ${style.dim('Publishable :')} ${style.bold(clientKey.api_key.slice(0, 12))}…${style.dim(' (hidden)')}\n` +
    `  ${style.dim('Project ref :')} ${style.bold(project.id)}\n`
);
