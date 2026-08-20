#!/usr/bin/env node
// mise run restore — restore a Supabase project from a backup archive.
//
// Target selection (same as backup):
//   NAK_TARGET=local  (default) — the local Supabase stack. Wipes and
//   restarts the stack before applying the backup.
//   NAK_TARGET=linked — the linked cloud project. DANGEROUS: drops the
//   public schema and truncates auth.users before applying the backup.
//   Requires explicit confirmation.
//
// Restore flow:
//   1. Choose a backup archive (gum, newest first).
//   2. Extract to a temp directory.
//   3. (Local) Stop + restart the stack for a clean slate.
//      (Linked) Drop public schema, truncate auth.users.
//   4. Apply schema dump (pg_dump --schema-only output).
//   5. Apply data dump (pg_dump --data-only output).
//   6. Apply storage.sql (repo schema.sql — recreates storage policies
//      and bucket definitions that pg_dump excludes).
//   7. Upload storage objects to each bucket.
//   8. Clean up the temp directory.
//
// Post-restore: redeploy edge functions with `mise run functions-deploy`.
// Auth config (email templates, provider settings) is not in the backup
// and must be reconfigured in the Supabase dashboard if needed.
import { readdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { runInherit, runCapture, which } from './lib/shell.mjs';
import { banner, step, info, ok, warn, bail, confirm, style } from './lib/ui.mjs';
import { gumAvailable, gumChoose } from './lib/gum.mjs';

const REPO_ROOT = resolve(import.meta.dirname, '..');
const BACKUPS_DIR = join(REPO_ROOT, 'backups');

// Bucket names are not hardcoded — restore reads them from the
// backup's manifest or discovers them from the extracted storage/
// directory. This prevents drift if buckets are added or removed
// between backup and restore time.

const target = (process.env.NAK_TARGET || 'local').trim();
if (target !== 'local' && target !== 'linked') {
  bail(`NAK_TARGET must be "local" or "linked", got "${target}"`);
}
const targetFlag = `--${target}`;
const targetLabel = target === 'linked' ? 'LINKED CLOUD PROJECT' : 'local stack';

banner(`Nak — restore (${targetLabel})`);

// Preflight.
if (!(await which('supabase'))) {
  bail('supabase CLI not found', 'Run through mise (mise run restore) or install the CLI.');
}

// --- Step 1: Choose a backup ---
step(1, 'Choose a backup archive');

if (!existsSync(BACKUPS_DIR)) {
  bail('No backups/ directory found', 'Run `mise run backup` first.');
}

const archives = readdirSync(BACKUPS_DIR)
  .filter((f) => f.endsWith('.tar.gz'))
  .sort()
  .reverse(); // newest first (timestamp prefix sorts chronologically)

if (archives.length === 0) {
  bail('No backup archives found in backups/', 'Run `mise run backup` first.');
}

let chosenArchive;
// NAK_BACKUP env var allows non-interactive archive selection (useful
// for scripts and testing). Set it to the filename in backups/.
if (process.env.NAK_BACKUP) {
  chosenArchive = process.env.NAK_BACKUP;
  if (!archives.includes(chosenArchive)) {
    bail(`NAK_BACKUP="${chosenArchive}" not found in backups/`);
  }
  ok(`Selected (via NAK_BACKUP): ${chosenArchive}`);
} else {
  const canGum = await gumAvailable();
  if (canGum && process.stdin.isTTY) {
    // gum choose: header text, then the archive list. gum prints the
    // chosen value to stdout. Only use gum when stdin is a real TTY;
    // gum opens /dev/tty directly and fails on piped stdin.
    const picked = await gumChoose('Select a backup (newest first):', archives);
    if (!picked) bail('No backup selected.');
    chosenArchive = picked;
  } else {
    // Fallback: numbered list via stdin.
    console.log('  Available backups (newest first):');
    archives.forEach((f, i) => console.log(`    ${i + 1}. ${f}`));
    const answer = await import('node:readline/promises').then((rl) => {
      const r = rl.createInterface({ input: process.stdin, output: process.stdout });
      return r.question('  Pick a number: ').then((a) => { r.close(); return a; });
    });
    const idx = parseInt(answer, 10) - 1;
    if (isNaN(idx) || idx < 0 || idx >= archives.length) {
      bail('Invalid selection.');
    }
    chosenArchive = archives[idx];
  }
}

const archivePath = join(BACKUPS_DIR, chosenArchive);
ok(`Selected: ${chosenArchive}`);

// --- Step 2: Extract ---
step(2, 'Extracting archive');
const extractedName = chosenArchive.replace(/\.tar\.gz$/, '');
const workDir = join(BACKUPS_DIR, extractedName);
{
  const { code, stderr } = await runCapture('tar', [
    '-xzf', archivePath, '-C', BACKUPS_DIR,
  ]);
  if (code !== 0) bail(`Extraction failed (exit ${code})`, stderr.slice(0, 500));
  if (!existsSync(workDir)) {
    bail(`Expected extracted directory not found: ${workDir}`);
  }
  ok('Extracted');
}

// Read manifest if present.
let manifest = null;
{
  const manifestPath = join(workDir, 'manifest.json');
  if (existsSync(manifestPath)) {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    info(`Backup created: ${manifest.created || 'unknown'}`);
    info(`Backup target:  ${manifest.target || 'unknown'}`);
  }
}

// --- Step 3: Prepare target database ---
if (target === 'linked') {
  step(3, 'WARNING: preparing linked cloud project');
  warn('This will DROP the public schema and TRUNCATE auth.users on the');
  warn('linked cloud project. All production data will be replaced.');
  warn('');
  const sure = await confirm('Are you absolutely sure?');
  if (!sure) bail('Restore cancelled.');
  const really = await confirm('Last chance — confirm production wipe?');
  if (!really) bail('Restore cancelled.');

  info('Dropping public schema...');
  const { code, stderr } = await runCapture('supabase', [
    'db', 'query', targetFlag,
    '-c', 'drop schema public cascade; create schema public;',
  ]);
  if (code !== 0) {
    bail('Failed to drop public schema', stderr.slice(0, 500));
  }
  ok('Public schema dropped and recreated');

  info('Truncating auth.users...');
  const { code: tCode, stderr: tErr } = await runCapture('supabase', [
    'db', 'query', targetFlag,
    '-c', 'truncate table auth.users cascade;',
  ]);
  if (tCode !== 0) {
    // Non-fatal: the data dump uses session_replication_role = replica
    // and may handle duplicates. But truncating avoids conflicts.
    warn(`auth.users truncate failed (non-fatal): ${tErr.trim().slice(0, 200)}`);
  } else {
    ok('auth.users truncated');
  }
} else {
  step(3, 'Resetting local stack');
  info('Stopping local stack (wiping all data)...');
  await runInherit('supabase', ['stop', '--no-backup']);

  info('Starting fresh local stack...');
  // supabase start can take a while (image pulls on first run). Inherit
  // stdio so the developer sees progress.
  await runInherit('supabase', ['start']);
  ok('Fresh local stack ready');
}

// --- Step 4: Apply schema dump ---
step(4, 'Applying schema dump');
{
  const schemaPath = join(workDir, 'schema.sql');
  if (!existsSync(schemaPath)) bail('schema.sql not found in backup.');

  if (target === 'local') {
    // Direct psql to the local Postgres (faster than the Management API).
    info('psql -h 127.0.0.1 -p 54322 -U postgres < schema.sql');
    const { code, stderr } = await runCapture('psql', [
      '-h', '127.0.0.1', '-p', '54322', '-U', 'postgres',
      '-f', schemaPath,
    ], { env: { ...process.env, PGPASSWORD: 'postgres' } });
    if (code !== 0) {
      bail('Schema apply failed', stderr.slice(0, 500));
    }
  } else {
    info('supabase db query --linked -f schema.sql');
    const { code, stderr } = await runCapture('supabase', [
      'db', 'query', targetFlag, '-f', schemaPath,
    ]);
    if (code !== 0) bail('Schema apply failed', stderr.slice(0, 500));
  }
  ok('Schema applied');
}

// --- Step 5: Apply data dump ---
step(5, 'Applying data dump');
{
  const dataPath = join(workDir, 'data.sql');
  if (!existsSync(dataPath)) bail('data.sql not found in backup.');

  if (target === 'local') {
    info('psql -h 127.0.0.1 -p 54322 -U postgres < data.sql');
    const { code, stderr } = await runCapture('psql', [
      '-h', '127.0.0.1', '-p', '54322', '-U', 'postgres',
      '-f', dataPath,
    ], { env: { ...process.env, PGPASSWORD: 'postgres' } });
    if (code !== 0) {
      bail('Data apply failed', stderr.slice(0, 500));
    }
  } else {
    info('supabase db query --linked -f data.sql');
    const { code, stderr } = await runCapture('supabase', [
      'db', 'query', targetFlag, '-f', dataPath,
    ]);
    if (code !== 0) bail('Data apply failed', stderr.slice(0, 500));
  }
  ok('Data applied');
}

// --- Step 6: Apply storage.sql (repo schema.sql — storage policies) ---
step(6, 'Applying storage policies (storage.sql)');
{
  const storageSchemaPath = join(workDir, 'storage.sql');
  if (!existsSync(storageSchemaPath)) {
    warn('storage.sql not found in backup — storage policies will be missing.');
    warn('Run `mise run sync` to apply them from the repo.');
  } else {
    if (target === 'local') {
      info('psql < storage.sql');
      const { code, stderr } = await runCapture('psql', [
        '-h', '127.0.0.1', '-p', '54322', '-U', 'postgres',
        '-f', storageSchemaPath,
      ], { env: { ...process.env, PGPASSWORD: 'postgres' } });
      if (code !== 0) {
        // Non-fatal: the main schema and data are already applied.
        // Storage policies are important but not data-loss-critical.
        warn(`storage.sql apply had errors (non-fatal): ${stderr.trim().slice(0, 200)}`);
        warn('Run `mise run sync` to apply storage policies from the repo.');
      } else {
        ok('Storage policies applied');
      }
    } else {
      info('supabase db query --linked -f storage.sql');
      const { code, stderr } = await runCapture('supabase', [
        'db', 'query', targetFlag, '-f', storageSchemaPath,
      ]);
      if (code !== 0) {
        warn(`storage.sql apply had errors (non-fatal): ${stderr.trim().slice(0, 200)}`);
        warn('Run `mise run sync` to apply storage policies from the repo.');
      } else {
        ok('Storage policies applied');
      }
    }
  }
}

// --- Step 7: Upload storage objects ---
step(7, 'Uploading storage objects');
// Discover buckets from the extracted backup: prefer the manifest's
// list, fall back to subdirectories of storage/. This handles
// backups made before/after bucket changes without a hardcoded list.
const storageRoot = join(workDir, 'storage');
let restoreBuckets = [];
if (manifest?.buckets && Array.isArray(manifest.buckets)) {
  restoreBuckets = manifest.buckets;
} else if (existsSync(storageRoot)) {
  const { readdirSync } = await import('node:fs');
  restoreBuckets = readdirSync(storageRoot, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
}
if (restoreBuckets.length === 0) {
  info('No storage buckets in backup, skipping upload');
} else {
  // The data dump already restored storage.objects metadata rows.
  // The file upload will recreate them, so truncate first to avoid
  // duplicates. The bucket definitions (storage.buckets) are NOT
  // affected - they survive the truncate because they are separate.
  info('Clearing storage.objects metadata (file upload recreates it)...');
  if (target === 'local') {
    const { code, stderr } = await runCapture('psql', [
      '-h', '127.0.0.1', '-p', '54322', '-U', 'postgres',
      '-c', 'truncate table storage.objects cascade;',
    ], { env: { ...process.env, PGPASSWORD: 'postgres' } });
    if (code !== 0) warn(`storage.objects truncate failed (non-fatal): ${stderr.trim().slice(0, 200)}`);
  } else {
    const { code, stderr } = await runCapture('supabase', [
      'db', 'query', targetFlag,
      '-c', 'truncate table storage.objects cascade;',
    ]);
    if (code !== 0) warn(`storage.objects truncate failed (non-fatal): ${stderr.trim().slice(0, 200)}`);
  }
}
{
  for (const bucket of restoreBuckets) {
    const bucketDir = join(workDir, 'storage', bucket);
    if (!existsSync(bucketDir)) {
      info(`Bucket "${bucket}": no data in backup, skipping`);
      continue;
    }

    // Check if the directory has any contents (files or subdirectories).
    let hasObjects = false;
    try {
      const { readdirSync } = await import('node:fs');
      hasObjects = readdirSync(bucketDir).length > 0;
    } catch {
      hasObjects = false;
    }

    if (!hasObjects) {
      info(`Bucket "${bucket}": empty in backup, skipping`);
      continue;
    }

    info(`Uploading to bucket: ${bucket}`);
    // The destination URL needs a trailing slash for recursive upload,
    // same as the download direction in backup.mjs.
    const { code, stderr } = await runCapture('supabase', [
      'storage', 'cp', '-r', bucketDir, `ss:///${bucket}/`,
      targetFlag, '--experimental', '-j', '4',
    ]);

    if (code !== 0) {
      warn(`Bucket "${bucket}" upload had issues: ${stderr.trim().slice(0, 200)}`);
    } else {
      ok(`Bucket "${bucket}" uploaded`);
    }
  }
}

// --- Step 8: Cleanup ---
step(8, 'Cleaning up');
{
  rmSync(workDir, { recursive: true, force: true });
  ok('Temp files removed');
}

console.log(`\n${style.green('Restore complete.')}`);
console.log(style.dim('  Next steps:'));
console.log(style.dim('  - Redeploy edge functions:  mise run functions-deploy'));
console.log(style.dim('  - For local dev:             mise run dev-start'));
if (target === 'linked') {
  console.log(style.dim('  - Verify auth config in the Supabase dashboard (email templates, providers)'));
}
