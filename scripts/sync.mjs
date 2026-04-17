#!/usr/bin/env node
// mise run sync — bring the linked Supabase project in line with the repo's
// current schema and Pages URL. Idempotent and prompt-free once setup has
// linked the project.
//
// What it does:
//   1. Resolves the Supabase project from .nak/state.json (writes it on
//      first run if missing).
//   2. Re-applies supabase/schema.sql (every statement uses IF NOT EXISTS,
//      so this is safe on already-migrated projects).
//   3. Merges this fork's Pages URL into the Supabase auth allowlist.
//
// What it does NOT do (on purpose):
//   - Ask you to re-pick a sign-up policy or re-create users. Those are
//     one-time setup decisions — change them in the Supabase dashboard.
//   - Touch GitHub Pages or workflow permissions. Those live in
//     `mise run pages-enable`.
//   - Prompt for passwords or keys.
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { banner, step, info, ok, warn, hint, bail, choose, style } from './lib/ui.mjs';
import {
  supaAvailable,
  supaLoginInteractive,
  readAccessToken,
  listProjects,
  getAuthConfig,
  updateAuthConfig,
  runSql,
} from './lib/supabase.mjs';
import { getRepoSlug, pagesUrl } from './lib/repo.mjs';
import { loadState, saveState } from './lib/state-file.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = join(__dirname, '..', 'supabase', 'schema.sql');

banner('Nak — sync');

if (!(await supaAvailable())) {
  bail(
    'supabase CLI not found.',
    'Run `mise install`, or install from https://supabase.com/docs/guides/cli.'
  );
}

step(1, 'Resolve Supabase project');
let token = await readAccessToken();
if (!token) {
  info('No Supabase access token found — logging you in.');
  await supaLoginInteractive();
  token = await readAccessToken();
  if (!token) bail('Supabase login did not produce an access token.');
}

const state = await loadState();
let projectRef = state?.supabase?.projectRef ?? null;
let project = null;

if (projectRef) {
  // Verify the project still exists under this account.
  try {
    const all = await listProjects();
    project = all.find((p) => p.id === projectRef) ?? null;
  } catch (err) {
    warn(`Could not list projects: ${err.message}`);
  }
  if (!project) {
    warn(`Project ${style.bold(projectRef)} not found in your Supabase account.`);
    projectRef = null;
  }
}

if (!project) {
  info('Picking a project to remember for future syncs…');
  const existing = await listProjects();
  if (existing.length === 0) {
    bail(
      'No Supabase projects on this account.',
      'Run `mise run setup` to create one from scratch.'
    );
  }
  project =
    existing.length === 1
      ? existing[0]
      : await choose(
          'Which project should Nak sync against?',
          existing.map((p) => ({
            label: `${style.bold(p.name)} ${style.dim(`(${p.id})`)}`,
            value: p,
          }))
        );
  await saveState({ ...(state ?? {}), supabase: { projectRef: project.id } });
  ok(`Linked project saved to .nak/state.json.`);
}

ok(`Using project ${style.bold(project.name)} (${project.id}).`);

step(2, 'Apply schema.sql');
const schema = await readFile(SCHEMA_PATH, 'utf8');
try {
  await runSql(project.id, schema);
  ok('Schema applied (all statements are IF NOT EXISTS, so no-op on up-to-date projects).');
} catch (err) {
  warn(`Schema apply failed: ${err.message}`);
  hint('Fallback: paste supabase/schema.sql into the Supabase SQL Editor yourself.');
}

step(3, 'Merge Pages URL into auth allowlist');
const slug = await getRepoSlug();
const url = pagesUrl(slug);
try {
  const current = await getAuthConfig(project.id);
  const allow = String(current.uri_allow_list || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const wanted = [url, `${url}*`];
  const missing = wanted.filter((w) => !allow.includes(w));
  if (missing.length === 0) {
    ok(`Allowlist already contains ${style.bold(url)}.`);
  } else {
    const merged = Array.from(new Set([...allow, ...wanted]));
    await updateAuthConfig(project.id, {
      site_url: current.site_url || url,
      uri_allow_list: merged.join(','),
    });
    ok(`Added ${style.bold(url)} to the auth allowlist.`);
  }
} catch (err) {
  warn(`Could not verify auth allowlist: ${err.message}`);
  hint('Open Supabase Dashboard → Authentication → URL Configuration to check.');
}

console.log(`\n${style.green('In sync.')}\n`);
