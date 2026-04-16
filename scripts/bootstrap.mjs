#!/usr/bin/env node
// mise run setup — the full first-time wizard. Chains the subtasks and ends
// with a one-shot setup link that auto-populates the deployed PWA.
//
// Each phase prints what it's about to do and what to do if it fails, so
// the user can recover manually at any point.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { banner, info, ok, warn, bail, ask, confirm, style } from './lib/ui.mjs';
import { ghAvailable, ghAuthStatus } from './lib/github.mjs';
import { supaAvailable } from './lib/supabase.mjs';
import { getRepoSlug, pagesUrl } from './lib/repo.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

function runChild(script, args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(__dirname, script), ...args], {
      stdio: ['inherit', 'pipe', 'inherit'],
    });
    let stdout = '';
    child.stdout.on('data', (d) => {
      stdout += d.toString();
      process.stdout.write(d);
    });
    child.on('close', (code) =>
      code === 0
        ? resolve(stdout)
        : reject(new Error(`${script} exited with code ${code}`))
    );
  });
}

function runChildJson(script, args = []) {
  // Captures stdout silently; the child should emit a single JSON line
  // at the end when invoked with --json.
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(__dirname, script), ...args, '--json'], {
      stdio: ['inherit', 'pipe', 'inherit'],
    });
    let stdout = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`${script} exited with code ${code}`));
      const lastLine = stdout.trim().split('\n').pop() || '';
      try {
        resolve(JSON.parse(lastLine));
      } catch (e) {
        reject(new Error(`${script} did not emit JSON: ${lastLine}`));
      }
    });
  });
}

banner('Nak — first-time setup wizard');

console.log(
  `This wizard will:\n` +
    `  ${style.dim('1.')} enable GitHub Pages on your fork (if not already on),\n` +
    `  ${style.dim('2.')} create or link a Supabase project and apply the schema,\n` +
    `  ${style.dim('3.')} whitelist your Pages URL in Supabase auth config,\n` +
    `  ${style.dim('4.')} prompt for your Venice API key,\n` +
    `  ${style.dim('5.')} print a one-shot setup link that auto-fills the app.\n\n` +
    `You can rerun it anytime — all steps are idempotent.\n`
);

if (!(await confirm('Ready to start?', { default: true }))) {
  bail('Aborted by user.');
}

// --- Preflight ---------------------------------------------------------------
info('Checking prerequisites...');
if (!(await ghAvailable())) {
  bail(
    'gh CLI not found on PATH.',
    'Run `mise install` to fetch it via mise, or install from https://cli.github.com/.'
  );
}
if (!(await supaAvailable())) {
  bail(
    'supabase CLI not found on PATH.',
    'Run `mise install`, or install from https://supabase.com/docs/guides/cli.'
  );
}
ok('gh and supabase binaries are available.');

const slug = await getRepoSlug();
const siteUrl = pagesUrl(slug);
info(`Fork detected: ${style.bold(`${slug.owner}/${slug.repo}`)}`);
info(`Your deployed app will live at: ${style.bold(siteUrl)}`);

// --- Phase 1: Pages ----------------------------------------------------------
console.log(`\n${style.magenta('━━ Phase 1: GitHub Pages ━━')}`);
await runChild('setup-pages.mjs');

// --- Phase 2: Supabase -------------------------------------------------------
console.log(`\n${style.magenta('━━ Phase 2: Supabase ━━')}`);
const supa = await runChildJson('setup-supabase.mjs');

// --- Phase 3: Venice ---------------------------------------------------------
console.log(`\n${style.magenta('━━ Phase 3: Venice ━━')}`);
info('We need your Venice API key to call chat completions.');
info('Get one at: https://venice.ai/settings/api');
const veniceApiKey = await ask('Paste your Venice API key', { secret: true });
if (!veniceApiKey) bail('Venice API key is required.');

// --- Phase 4: build setup link -----------------------------------------------
console.log(`\n${style.magenta('━━ Phase 4: Setup link ━━')}`);
const payload = {
  supabaseUrl: supa.supabaseUrl,
  supabaseAnonKey: supa.supabaseAnonKey,
  veniceApiKey,
};
const b64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
const link = `${supa.pagesUrl}#setup=${b64}`;

console.log(
  `\n${style.green('All set.')} Open this link in your browser to finish setup:\n\n` +
    `  ${style.bold(style.cyan(link))}\n\n` +
    `The ${style.bold('#setup=…')} fragment is URL fragment, not query — it ${style.bold('never')} leaves your\n` +
    `machine in an HTTP request. The app reads it locally, pre-fills the Setup form,\n` +
    `and clears it from the address bar. You'll be asked to pick a master password\n` +
    `which encrypts the three values into localStorage.\n\n` +
    `If the Pages deploy is still running, wait ~2 minutes and refresh. You can watch\n` +
    `progress at: ${style.dim(`https://github.com/${slug.owner}/${slug.repo}/actions`)}\n`
);

if (process.stdout.isTTY) {
  warn(
    'Treat the link above like a password — anyone with it can log in as you ' +
      'until the master password is set. Close this terminal session when done.'
  );
}
