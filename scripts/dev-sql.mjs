#!/usr/bin/env node
/*
 * Run an ad-hoc SQL statement against the LOCAL Supabase stack via psql.
 *
 * Why this exists: the MCP Supabase tools and the app's own client all
 * point at the linked CLOUD project. During local QA (mise run dev-start)
 * there is no first-class way to read the local database - so verifying
 * "did the row actually land / what does this thread's payload look like"
 * meant opening Studio by hand. This task closes that gap for both humans
 * and agents driving a local QA pass.
 *
 * Safety: the connection target comes from `supabase status` and is
 * loopback-guarded exactly like scripts/dev-local.mjs. A dev machine
 * routinely has cloud credentials in its environment; this task refuses
 * to run against anything but 127.0.0.1 / ::1 / localhost so a stray
 * access token can never turn a "quick local query" into a prod write.
 *
 * SQL source: the statement is taken from the command-line arguments, or
 * read from stdin when no argument is given. Both forms:
 *
 *   mise run dev-sql "select count(*) from public.threads"
 *   echo "select id, title from public.threads limit 5" | mise run dev-sql
 *
 * Exit code is psql's, so a failing query fails the task.
 */
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

function fail(msg, hint) {
  process.stderr.write(`dev-sql: ${msg}\n`);
  if (hint) process.stderr.write(`         ${hint}\n`);
  process.exit(1);
}

// `supabase status -o json` emits uppercase keys (DB_URL, ...). Read it
// defensively so a CLI shape change fails loudly here, not silently.
function localDbUrl() {
  const res = spawnSync('supabase', ['status', '-o', 'json'], {
    encoding: 'utf8',
  });
  if (res.status !== 0) {
    fail(
      'could not read `supabase status`.',
      (res.stderr || '').trim() || 'Is the local stack up? Run mise run dev-start.'
    );
  }
  let s;
  try {
    s = JSON.parse(res.stdout);
  } catch {
    fail('`supabase status -o json` did not return JSON.', 'Check your supabase CLI version.');
  }
  if (!s.DB_URL) fail('supabase status is missing DB_URL.', 'CLI output shape changed.');
  assertLoopback('DB_URL', s.DB_URL);
  return s.DB_URL;
}

// A connection target is safe only when its host is a loopback literal -
// same guard as scripts/dev-local.mjs. Refuses to touch a remote host.
function assertLoopback(label, url) {
  let host;
  try {
    host = new URL(url).hostname.replace(/^\[|\]$/g, '');
  } catch {
    fail(`could not parse ${label} as a URL.`, 'Refusing an unverifiable target.');
  }
  if (host !== 'localhost' && host !== '127.0.0.1' && host !== '::1') {
    fail(
      `${label} points at ${host}, which is not loopback.`,
      'This task only ever touches the local stack.'
    );
  }
}

function readSql() {
  const fromArgs = process.argv.slice(2).join(' ').trim();
  if (fromArgs.length > 0) return fromArgs;
  const fromStdin = readFileSync(0, 'utf8').trim();
  if (fromStdin.length > 0) return fromStdin;
  fail('no SQL given.', 'Pass it as an argument or on stdin.');
}

const dbUrl = localDbUrl();
const sql = readSql();
// ON_ERROR_STOP so a bad statement exits non-zero; client-min-messages
// keeps the idempotency-guard NOTICE flood out of one-off query output.
const child = spawn(
  'psql',
  [dbUrl, '-v', 'ON_ERROR_STOP=1', '-c', sql],
  { stdio: 'inherit', env: { ...process.env, PGOPTIONS: '--client-min-messages=warning' } }
);
child.on('exit', (code) => process.exit(code ?? 0));
child.on('error', (err) => fail(`failed to launch psql: ${err.message}`, 'Install libpq (brew install libpq).'));
