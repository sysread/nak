#!/usr/bin/env node
// mise run dev-start — an isolated, ephemeral local dev environment for nak.
// Brings up a local Supabase stack, provisions it, runs the Vite dev server
// in the foreground, and tears the stack down when the server exits.
//
// Why this exists: nak's only backend is one Supabase project, and the app
// reads its endpoint from runtime config (encrypted localStorage), not a
// build-time env var. There is no built-in isolation - point the app at
// your cloud project and every schema experiment mutates it. dev-start
// makes the isolated thing the easy thing: one command yields a working,
// throwaway Postgres+Auth+Realtime(+Storage) on localhost with the schema
// applied, a login seeded, and an importable credentials file written.
// Pointing at the real project is still possible, but only as a deliberate
// manual act (enter the prod keys in the app's settings UI). The cloud sync
// path (scripts/sync.mjs, mise run supabase-init) is untouched and still
// targets the linked project via the Management API.
//
// Lifecycle: dev-start owns the stack for the session. On exit - Ctrl-C, a
// Vite crash, or a kill signal - it runs `supabase stop`, so the setup does
// not outlive the command. If a stack is already running (e.g. a previous
// dev-start crashed without cleaning up) it is reused, then stopped on this
// run's exit. `supabase stop` preserves the database between sessions, so
// dev data survives a restart; only the containers go down. `mise run
// dev-stop` is the manual cleanup for a crash that skipped teardown.
//
// Single source of truth: the schema is applied straight from
// supabase/schema.sql via psql, exactly as the cloud path applies the same
// file. There are deliberately no supabase/migrations - splitting the schema
// into a migrations tree would fork it from the file the deploy workflow
// re-applies. Provisioning is idempotent, so reuse and restart are safe.
import { spawn } from 'node:child_process';
import { writeFileSync, watch } from 'node:fs';
import { resolve, dirname, basename } from 'node:path';
import { runInherit, runCapture, which } from './lib/shell.mjs';
import { banner, step, info, ok, warn, hint, bail, ask, style } from './lib/ui.mjs';

const REPO_ROOT = resolve(import.meta.dirname, '..');
const SCHEMA_PATH = resolve(REPO_ROOT, 'supabase/schema.sql');
const CONFIG_OUT = resolve(REPO_ROOT, 'nak-local-config.json');

// Seeded login. Overridable so a project owner can mirror their real
// email locally, but the defaults are fine for a throwaway stack.
const DEV_EMAIL = process.env.NAK_DEV_EMAIL || 'dev@nak.local';
const DEV_PASSWORD = process.env.NAK_DEV_PASSWORD || 'devpass123';

// ---------------------------------------------------------------------------
// Preflight: the local stack is a Docker Compose bundle. mise provisions the
// supabase CLI, but nothing can provision the Docker daemon - so check it
// explicitly and fail with a fixable message rather than a Compose stack trace.
// ---------------------------------------------------------------------------
async function preflight() {
  step(1, 'Preflight');
  if (!(await which('supabase'))) {
    bail('supabase CLI not on PATH.', 'Run `mise install` (it is pinned in .mise.toml), or see https://supabase.com/docs/guides/cli.');
  }
  ok('supabase CLI present');

  const docker = await runCapture('docker', ['info']);
  if (docker.code !== 0) {
    bail(
      'Docker is not running.',
      'The local Supabase stack runs in Docker. Start Docker Desktop (or colima/OrbStack) and re-run.'
    );
  }
  ok('Docker daemon reachable');
}

// ---------------------------------------------------------------------------
// Bring the stack up. Probe first: when a stack is already running we reuse
// it (a previous dev-start that crashed without cleanup, typically) rather
// than erroring or double-starting. The returned `startedByUs` is not used
// to decide teardown - exit always stops the stack - but it keeps the
// console message honest about whether this run booted the containers.
// ---------------------------------------------------------------------------
async function ensureStack() {
  step(2, 'Local Supabase stack');
  const status = await runCapture('supabase', ['status', '-o', 'json']);
  if (status.code === 0) {
    info('reusing the stack already running (it will be stopped on exit)');
    return { ...(await readStatus()), startedByUs: false };
  }
  info('starting stack (first run pulls several GB of images - this is slow once)');
  await runInherit('supabase', ['start']);
  ok('stack started');
  return { ...(await readStatus()), startedByUs: true };
}

// Parse `supabase status -o json` into the endpoints we need. The CLI emits
// uppercase keys (API_URL, DB_URL, ANON_KEY, SERVICE_ROLE_KEY); read them
// defensively so a CLI version that renames one fails loudly here rather
// than silently writing an undefined into the config file.
async function readStatus() {
  const res = await runCapture('supabase', ['status', '-o', 'json']);
  if (res.code !== 0) {
    bail('Could not read `supabase status`.', res.stderr.trim() || 'Is the stack up?');
  }
  let s;
  try {
    s = JSON.parse(res.stdout);
  } catch {
    bail('`supabase status -o json` did not return JSON.', 'Check your supabase CLI version.');
  }
  const missing = ['API_URL', 'DB_URL', 'ANON_KEY', 'SERVICE_ROLE_KEY'].filter((k) => !s[k]);
  if (missing.length) {
    bail(`supabase status is missing: ${missing.join(', ')}`, 'CLI output shape changed; update this script.');
  }
  // Refuse to operate on anything but a loopback target. This script applies
  // the schema and seeds a user with the service-role key - operations that
  // would be catastrophic against the real project. A dev machine commonly
  // has prod credentials in its environment (direnv injecting an access
  // token, etc.), so guard on the endpoint itself rather than trusting that
  // `supabase status` could only ever return localhost.
  assertLoopback('DB_URL', s.DB_URL);
  assertLoopback('API_URL', s.API_URL);
  return { apiUrl: s.API_URL, dbUrl: s.DB_URL, anonKey: s.ANON_KEY, serviceRoleKey: s.SERVICE_ROLE_KEY };
}

// A connection target is safe only when its host is a loopback literal.
// localhost is accepted alongside the IPv4/IPv6 loopback addresses the
// Supabase CLI emits.
function assertLoopback(label, url) {
  let host;
  try {
    host = new URL(url).hostname.replace(/^\[|\]$/g, '');
  } catch {
    bail(`Could not parse ${label} as a URL.`, 'Refusing to proceed against an unverifiable target.');
  }
  const loopback = host === 'localhost' || host === '127.0.0.1' || host === '::1';
  if (!loopback) {
    bail(
      `${label} points at ${host}, which is not loopback.`,
      'This task only ever touches a local stack. Refusing to run against a remote host.'
    );
  }
}

// ---------------------------------------------------------------------------
// Apply the schema. Straight psql against the local DB as the postgres
// superuser - the auth schema and the supabase_realtime publication that
// schema.sql references already exist post-start, and the file creates its
// own extensions (pgcrypto, vector) before first use. ON_ERROR_STOP makes a
// bad statement abort loudly (same stance as the deploy workflow: a failed
// schema apply should be impossible to miss). client-min-messages=warning
// silences the NOTICE flood from the "if not exists" idempotency guards.
// ---------------------------------------------------------------------------
async function applySchema(dbUrl) {
  step(3, 'Apply schema');
  if (!(await which('psql'))) {
    bail('psql not on PATH.', 'Install libpq/postgres client tools (brew install libpq, then link psql).');
  }
  info(`psql -f ${style.dim('supabase/schema.sql')}`);
  await runSchemaSql(dbUrl);
  ok('schema applied');
}

// The bare psql apply, shared by the startup step and the live watcher. This
// is the local equivalent of what `mise run sync` does to the cloud project -
// re-apply supabase/schema.sql - minus sync's cloud-only steps (project
// resolution and the Pages-URL auth-allowlist merge), which have no local
// meaning. ON_ERROR_STOP aborts on the first bad statement so a syntax error
// surfaces loudly; client-min-messages=warning hides the idempotency NOTICEs.
function runSchemaSql(dbUrl) {
  return runInherit('psql', [dbUrl, '-v', 'ON_ERROR_STOP=1', '-f', SCHEMA_PATH], {
    env: { ...process.env, PGOPTIONS: '--client-min-messages=warning' },
  });
}

// ---------------------------------------------------------------------------
// Live schema re-apply. Watching the file makes a schema.sql edit land in the
// running local stack without a restart - the local counterpart of running
// `mise run sync` after a schema change. Re-apply is additive-idempotent
// (the same contract as the cloud sync), so a failure here is non-fatal: the
// dev session keeps running and the next save retries. The destructive-change
// caveat carries over too - a re-apply adds new objects but does not drop a
// column you removed from the file; that still needs `supabase stop
// --no-backup`. The directory watch (rather than watching the file inode)
// survives editors that save by atomic rename.
// ---------------------------------------------------------------------------
function watchSchema(dbUrl) {
  let timer = null;
  let applying = false;
  const fire = () => {
    clearTimeout(timer);
    timer = setTimeout(reapply, 400);
  };
  const reapply = async () => {
    if (applying) {
      fire(); // a save landed mid-apply; retry once the current run finishes
      return;
    }
    applying = true;
    info('schema.sql changed - re-applying to the local stack...');
    try {
      await runSchemaSql(dbUrl);
      ok('schema re-applied');
    } catch (err) {
      warn(`schema re-apply failed: ${err.message}`);
      hint('Fix the SQL and save again; the dev session keeps running.');
    } finally {
      applying = false;
    }
  };
  const base = basename(SCHEMA_PATH);
  watch(dirname(SCHEMA_PATH), (_event, filename) => {
    if (filename === base) fire();
  });
  info(`watching ${style.dim('supabase/schema.sql')} - edits re-apply to the local stack live`);
}

// ---------------------------------------------------------------------------
// Seed a confirmed user via the GoTrue admin API (email confirmations are
// off in config.toml, but email_confirm:true keeps this correct if that
// flips). Creating the user fires the on_auth_user_created trigger, which
// materializes the profiles row the app expects. A repeat run gets a 422
// "already registered" - that is success for our purposes, not an error.
// ---------------------------------------------------------------------------
async function seedUser(apiUrl, serviceRoleKey) {
  step(4, 'Seed login');
  const res = await fetch(`${apiUrl}/auth/v1/admin/users`, {
    method: 'POST',
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ email: DEV_EMAIL, password: DEV_PASSWORD, email_confirm: true }),
  });
  if (res.ok) {
    ok(`created ${style.bold(DEV_EMAIL)}`);
    return;
  }
  const body = await res.text();
  if (res.status === 422 || /already.*registered|already.*exists/i.test(body)) {
    ok(`login ${style.bold(DEV_EMAIL)} already exists`);
    return;
  }
  bail(`Failed to seed user (${res.status}).`, body.slice(0, 300));
}

// ---------------------------------------------------------------------------
// Collect the Venice key. The local stack does not proxy Venice - the app
// calls it directly with whatever key the config carries - so without a key
// chat and embeddings will fail even though login works. Prefer the env var
// for non-interactive runs; otherwise prompt (blank is allowed, leaving a
// replaceable placeholder so the import still validates).
// ---------------------------------------------------------------------------
const VENICE_PLACEHOLDER = 'REPLACE_WITH_VENICE_KEY';

async function collectVeniceKey() {
  if (process.env.VENICE_API_KEY) return process.env.VENICE_API_KEY.trim();
  if (process.stdout.isTTY) {
    const key = await ask('Venice API key (blank to fill in later)', { secret: true });
    if (key) return key;
  }
  warn(`No Venice key given - writing placeholder "${VENICE_PLACEHOLDER}".`);
  hint('Edit nak-local-config.json before importing, or set it later in Settings.');
  return VENICE_PLACEHOLDER;
}

// ---------------------------------------------------------------------------
// Opportunistic: the Venice edge-functions work moves the key into a
// project-global app_config table. When that table exists (i.e. this is the
// rebased edge branch), mirror the key into it so the shared-key path is
// exercised locally too. Guarded entirely in SQL so an unseeded branch (no
// table) or a future shape change degrades to a notice, never an abort - the
// app's local-key fallback keeps working regardless.
// ---------------------------------------------------------------------------
async function seedAppConfig(dbUrl, veniceKey) {
  if (veniceKey === VENICE_PLACEHOLDER) return;
  const sql = `do $$
begin
  if to_regclass('public.app_config') is not null then
    insert into public.app_config (id, venice_api_key) values (true, ${pgLiteral(veniceKey)})
      on conflict (id) do update set venice_api_key = excluded.venice_api_key;
    raise notice 'app_config seeded';
  end if;
exception when others then
  raise notice 'app_config present but seed skipped: %', sqlerrm;
end $$;`;
  const res = await runCapture('psql', [dbUrl, '-v', 'ON_ERROR_STOP=1', '-c', sql], {
    env: { ...process.env, PGOPTIONS: '--client-min-messages=notice' },
  });
  if (/app_config seeded/.test(res.stderr)) ok('mirrored key into app_config (shared-key path)');
}

// Single-quote escape for a SQL string literal. Control over the value is
// ours (env/prompt), so this is belt-and-suspenders against an apostrophe in
// a key, not untrusted input.
function pgLiteral(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

// ---------------------------------------------------------------------------
// Write the importable config. This is the exact shape Setup -> Import from
// JSON accepts (parseExportedConfig in src/lib/config.ts): kind/version plus
// the three keys. The master password is chosen in the browser at import
// time - it never touches this file, which is plaintext by the same design
// as the app's own export.
// ---------------------------------------------------------------------------
function writeConfig(apiUrl, anonKey, veniceKey) {
  step(5, 'Write importable config');
  const config = {
    kind: 'nak-config',
    version: 1,
    supabaseUrl: apiUrl,
    supabaseAnonKey: anonKey,
    veniceApiKey: veniceKey,
  };
  writeFileSync(CONFIG_OUT, `${JSON.stringify(config, null, 2)}\n`);
  ok(`wrote ${style.bold('nak-local-config.json')}`);
}

// Edge functions are a Deno island. When any exist (i.e. once the
// venice-edge-functions work lands), run `supabase functions serve` as a
// second supervised child so they are live alongside Vite - serve hot-reloads
// the Deno code on edit, so functions need no watcher of their own (unlike the
// schema, they are served, not applied). Gated on a function being present, so
// this is a no-op on a branch without any. Per-function verify_jwt and import
// maps come from config.toml; we pass no overriding flags.
async function serveFunctions() {
  const ls = await runCapture('bash', ['-c', 'ls supabase/functions/*/index.ts 2>/dev/null']);
  if (!(ls.code === 0 && ls.stdout.trim())) return;
  info('serving edge functions (supabase functions serve, hot-reload)');
  funcsChild = spawn('supabase', ['functions', 'serve'], { stdio: 'inherit' });
  funcsChild.on('error', (err) => warn(`could not start functions serve: ${err.message}`));
  // serve is a supporting service, not the lifecycle driver - Vite is. If it
  // dies on its own, warn but keep the session up (the frontend is unaffected);
  // restart dev-start to bring functions back. During teardown the exit is
  // expected, so stay quiet.
  funcsChild.on('close', (code) => {
    if (!shuttingDown) {
      warn(`functions serve exited (code ${code}); functions are no longer served - restart dev-start to resume them.`);
    }
  });
}

// Printed once, before the Vite server takes over the terminal, so the
// first-run import steps stay visible above the dev-server log. The import
// is a one-time act per browser - the local anon key and the config file
// are stable across sessions - so on later runs this is just a reminder.
function printGettingStarted() {
  console.log('');
  console.log(`  ${style.bold('First time:')} in the app, ${style.bold('Setup -> Import from JSON')} -> pick ${style.cyan('nak-local-config.json')},`);
  console.log(`  set any master password, then log in: ${style.bold(DEV_EMAIL)} / ${style.bold(DEV_PASSWORD)}`);
  console.log(`  Studio: ${style.cyan('http://127.0.0.1:54323')}   Stop everything: ${style.bold('Ctrl-C')}`);
  console.log('');
}

// ---------------------------------------------------------------------------
// Foreground lifecycle. The supervised children (Vite always; edge-function
// serve when functions exist) run with inherited stdio. Teardown (`supabase
// stop`) must run on every exit path - a clean Ctrl-C, a child crash, or a
// kill signal - so the stack never outlives the command. Ctrl-C reaches this
// process and the children (shared process group), so the signal handler and
// a child's `close` event can both fire; `shuttingDown` makes teardown run
// exactly once.
// ---------------------------------------------------------------------------
let viteChild = null;
let funcsChild = null;
let shuttingDown = false;

// Stop a child and wait for it to actually die before returning. Children are
// grandchildren via their launchers (e.g. node -> pnpm -> vite); if this
// process exits while one is still alive it reparents to init and keeps
// holding its port, breaking the "setup goes down on exit" contract. The
// timeout keeps a child that ignores SIGTERM from hanging teardown forever.
async function killChild(child) {
  if (!child || child.exitCode !== null) return;
  const closed = new Promise((res) => child.once('close', res));
  child.kill('SIGTERM');
  await Promise.race([closed, new Promise((res) => setTimeout(res, 5000))]);
}

async function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  await Promise.all([killChild(viteChild), killChild(funcsChild)]);
  console.log(`\n  ${style.dim('Stopping the local stack...')}`);
  // Best-effort: even if `supabase stop` fails (already down, daemon gone),
  // we still exit. `mise run dev-stop` is the manual fallback.
  await runInherit('supabase', ['stop']).catch(() => {});
  process.exit(code);
}

function runVite() {
  process.on('SIGINT', () => void shutdown(0));
  process.on('SIGTERM', () => void shutdown(0));
  console.log(`  ${style.green('Starting Vite.')} The dev server log follows; ${style.bold('Ctrl-C')} stops the server and the stack.\n`);
  viteChild = spawn('pnpm', ['dev'], { stdio: 'inherit' });
  viteChild.on('error', (err) => bail(`Failed to start Vite: ${err.message}`));
  // Vite exiting on its own (crash, or the user quit it) tears the stack down
  // too, preserving the "setup does not outlive the command" contract.
  viteChild.on('close', (code) => void shutdown(code ?? 0));
}

async function main() {
  banner('Nak - isolated local dev');
  await preflight();
  const { apiUrl, dbUrl, anonKey, serviceRoleKey } = await ensureStack();
  await applySchema(dbUrl);
  await seedUser(apiUrl, serviceRoleKey);
  const veniceKey = await collectVeniceKey();
  await seedAppConfig(dbUrl, veniceKey);
  writeConfig(apiUrl, anonKey, veniceKey);
  await serveFunctions();
  watchSchema(dbUrl);
  printGettingStarted();
  runVite();
}

main().catch((err) => {
  bail(err.message || String(err));
});
