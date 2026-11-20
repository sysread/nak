#!/usr/bin/env node
// mise run user-edit — create a Supabase user, or reset an existing user's
// password, on the project linked by `mise run supabase-init`. Reads the
// project ref from .nak/state.json (or SUPABASE_PROJECT_REF) and the access
// token from the supabase CLI login (or SUPABASE_ACCESS_TOKEN). The admin key
// for the GoTrue calls comes from SUPABASE_SECRET_KEY when set, else the
// legacy service-role key fetched over the Management API; neither is written
// to disk.
//
// After a successful create/reset, prints a one-shot invite link
// (#setup=<base64> fragment over the fork's Pages URL) that pre-fills the
// app's Setup screen on the invitee's browser - the same link shape the
// bootstrap wizard prints.
//
// Args (all optional; missing ones are prompted interactively):
//   --email <addr>       skip the email prompt
//   --password <pw>      skip the password prompt; visible to `ps` and shell
//                        history, so prefer the interactive prompt for
//                        anything you intend to keep
//
// On 422 (email already exists) the script offers to reset that user's
// password to the value just collected — same flow as the wizard's
// "Create the main user account" step in scripts/setup-supabase.mjs. The
// inner try-create-then-422-reset block is duplicated rather than shared;
// extract a helper if a third caller appears.
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
  style,
} from './lib/ui.mjs';
import {
  supaAvailable,
  readAccessToken,
  getProjectApiKeys,
  adminCreateUser,
  adminListUsers,
  adminUpdateUserPassword,
} from './lib/supabase.mjs';
import { loadState } from './lib/state-file.mjs';
import { getRepoSlug, pagesUrl } from './lib/repo.mjs';

let argEmail = null;
let argPassword = null;
for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i];
  const next = process.argv[i + 1];
  if (arg === '--email' && next) {
    argEmail = next;
    i++;
  } else if (arg === '--password' && next) {
    argPassword = next;
    i++;
  } else if (arg === '-h' || arg === '--help') {
    console.log(
      'Usage: mise run user-edit -- [--email <addr>] [--password <pw>]\n' +
        '\n' +
        'Creates a Supabase user on the linked project, or resets that\n' +
        "user's password if the email already exists. Missing args are\n" +
        'collected interactively.'
    );
    process.exit(0);
  } else {
    bail(
      `Unknown arg: ${arg}`,
      'Usage: mise run user-edit -- [--email <addr>] [--password <pw>]'
    );
  }
}

banner('Supabase user-edit');

if (!(await supaAvailable())) {
  bail(
    'supabase CLI not found.',
    'Run `mise install`, or install from https://supabase.com/docs/guides/cli.'
  );
}

const token = await readAccessToken();
if (!token) {
  bail(
    'No Supabase access token.',
    'Run `mise run supabase-init` first, or export SUPABASE_ACCESS_TOKEN.'
  );
}

const state = await loadState();
const projectRef =
  process.env.SUPABASE_PROJECT_REF?.trim() || state?.supabase?.projectRef;
if (!projectRef) {
  bail(
    'No linked Supabase project.',
    'Run `mise run supabase-init` first to create or link one.'
  );
}

const supabaseUrl = `https://${projectRef}.supabase.co`;
info(`Project: ${style.bold(projectRef)}`);

step(1, 'Resolve the admin + client keys');
// The key list serves two purposes: the service-role-class key for the GoTrue
// admin calls below, and the publishable key for the invite link printed at
// the end - so fetch it even when SUPABASE_SECRET_KEY skips the fallback.
const keys = await getProjectApiKeys(projectRef);

// Prefer the modern secret key from the environment; fall back to the
// legacy service_role key via the Management API so existing setups keep
// working. Either way this is a service-role-class secret (bypasses RLS) used
// only for the GoTrue admin calls below - the app never sees it.
let adminKey = process.env.SUPABASE_SECRET_KEY?.trim();
if (adminKey) {
  ok('Using SUPABASE_SECRET_KEY from the environment.');
} else {
  // Prefer the project's modern secret key (type 'secret'); fall back to the
  // legacy service_role key so this keeps working both before the new keys
  // exist and after the legacy ones are disabled.
  const secretKey =
    keys.find((k) => k.type === 'secret') ||
    keys.find((k) => k.name === 'service_role' || k.tags?.includes('service_role'));
  if (!secretKey) {
    bail(
      'No secret key available for this project.',
      'Set SUPABASE_SECRET_KEY, or check the project in the Supabase dashboard and retry.'
    );
  }
  adminKey = secretKey.api_key;
  ok(`Fetched the project's ${secretKey.type === 'secret' ? 'secret' : 'legacy service-role'} key.`);
}

// Publishable key for the invite link - same preference order the wizard
// uses (modern 'publishable' type, legacy 'anon' fallback).
const clientKey =
  keys.find((k) => k.type === 'publishable') ||
  keys.find((k) => k.name === 'anon' || k.tags?.includes('anon'));

step(2, 'Collect credentials');
const email = argEmail ?? (await ask('Email'));
if (!email || !email.includes('@')) bail('Email is required.');

let password;
if (argPassword !== null) {
  if (argPassword.length < 8) bail('Password must be at least 8 chars.');
  password = argPassword;
  warn('Using --password from the command line; remember to clear your shell history.');
} else {
  password = await askSecretTwice('Password (min 8 chars)', { minLength: 8 }).catch(
    (err) => bail(err.message)
  );
}

step(3, 'Create or reset');
try {
  await adminCreateUser(supabaseUrl, adminKey, { email, password });
  ok(`User ${style.bold(email)} created. You can sign in immediately.`);
} catch (err) {
  if (err.status !== 422) {
    bail(`Could not create the user: ${err.message}`);
  }
  info(`A user with email ${style.bold(email)} already exists.`);
  const reset = await confirm('Reset their password to the value you just typed?', {
    default: false,
  });
  if (!reset) {
    info('Leaving the existing user untouched.');
    process.exit(0);
  }
  let users;
  try {
    users = await adminListUsers(supabaseUrl, adminKey);
  } catch (e) {
    bail(`Could not list users to find the existing record: ${e.message}`);
  }
  const existing = users.find(
    (u) => u.email?.toLowerCase() === email.toLowerCase()
  );
  if (!existing) {
    bail(
      'Could not locate the existing user to reset.',
      'Reset the password manually in Supabase -> Authentication -> Users.'
    );
  }
  try {
    await adminUpdateUserPassword(
      supabaseUrl,
      adminKey,
      existing.id,
      password
    );
    ok(`Password reset for ${style.bold(email)}.`);
  } catch (e) {
    warn(`Password reset failed: ${e.message}`);
    hint('Reset the password manually in Supabase -> Authentication -> Users.');
    process.exit(1);
  }
}

step(4, 'Invite link');
// The #setup=<base64> fragment pre-fills the app's Setup screen in the
// invitee's browser (Setup.svelte decodes it, then strips it from the address
// bar). Same shape the bootstrap wizard prints. It carries only the Supabase
// URL and publishable key - neither is a secret.
if (!clientKey) {
  warn('No publishable key found; skipping the invite link.');
  hint('The user can still configure manually on the Setup screen.');
} else {
  try {
    const slug = await getRepoSlug();
    const payload = {
      supabaseUrl,
      supabasePublishableKey: clientKey.api_key,
    };
    const b64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    const link = `${pagesUrl(slug)}#setup=${b64}`;
    ok(`Invite link for ${style.bold(email)}:`);
    console.log(`\n  ${style.bold(style.cyan(link))}\n`);
    hint(
      'Send this link along with the email + password above. It pre-fills the\n' +
        'Supabase config in their browser (the fragment never leaves the machine\n' +
        'in an HTTP request, and the app clears it from the address bar); they\n' +
        'only have to click "Save and continue" and sign in.'
    );
  } catch (err) {
    warn(`Could not build a setup link: ${err.message}`);
    hint('Is `origin` a GitHub remote? The user can still configure manually.');
  }
}
