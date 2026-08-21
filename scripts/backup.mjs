#!/usr/bin/env node
// mise run backup — dump the database (schema + data) and download all
// storage objects into a timestamped tar.gz under backups/.
//
// Target selection:
//   NAK_TARGET=local  (default) — the local Supabase stack from mise run
//   dev-start. The stack must be running.
//   NAK_TARGET=linked — the linked cloud project. Requires `supabase
//   link` to have been run (or SUPABASE_PROJECT_REF in the environment).
//
// What gets backed up:
//   schema.sql  — pg_dump --schema-only (public tables, functions,
//   triggers, policies, indexes, sequences)
//   data.sql    — pg_dump --data-only (all schemas: public data, auth
//   users, storage bucket defs + object metadata, cron jobs)
//   storage.sql — a copy of supabase/schema.sql from the repo, included
//   because pg_dump excludes the storage schema and its RLS policies.
//   schema.sql is idempotent and recreates storage policies + bucket
//   defs on restore without conflicting with the data dump.
//   storage/    — one subdirectory per bucket, downloaded via
//   `supabase storage cp -r`. Bucket names are discovered at backup
//   time by listing the running instance.
//   manifest.json — metadata for verification (timestamp, target, sizes,
//   bucket list).
//
// What is NOT backed up (redeploy from the repo instead):
//   - Edge functions (mise run functions-deploy)
//   - Auth config (email templates, provider settings — dashboard only)
import { mkdirSync, writeFileSync, copyFileSync, existsSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { runCapture, which } from './lib/shell.mjs';
import { banner, step, info, ok, warn, bail, style } from './lib/ui.mjs';

const REPO_ROOT = resolve(import.meta.dirname, '..');
const BACKUPS_DIR = join(REPO_ROOT, 'backups');
const SCHEMA_SOURCE = join(REPO_ROOT, 'supabase', 'schema.sql');

// Buckets are discovered at backup time by listing the running
// instance, not hardcoded. This prevents silent data loss if a new
// bucket is added to schema.sql without updating this script.
async function listBuckets(targetFlag) {
  const { stdout, code, stderr } = await runCapture('supabase', [
    'storage', 'ls', 'ss:///', targetFlag, '--experimental',
  ]);
  if (code !== 0) {
    bail(
      'Failed to list storage buckets',
      stderr.trim().slice(0, 300) || 'Is the Supabase stack running?',
    );
  }
  // Output is one bucket name per line with a trailing slash:
  //   attachments/
  //   recipe-images/
  // Strip the slash and filter blank lines.
  return stdout
    .trim()
    .split('\n')
    .map((l) => l.trim().replace(/\/$/, ''))
    .filter(Boolean);
}

const target = (process.env.NAK_TARGET || 'local').trim();
if (target !== 'local' && target !== 'linked') {
  bail(`NAK_TARGET must be "local" or "linked", got "${target}"`);
}
const targetFlag = `--${target}`;
const targetLabel = target === 'linked' ? 'linked cloud project' : 'local stack';

banner(`Nak — backup (${targetLabel})`);

// Preflight: supabase CLI must be available.
if (!(await which('supabase'))) {
  bail('supabase CLI not found', 'Run through mise (mise run backup) or install the CLI.');
}

// Timestamp: yyyy-mm-dd-HH-MM-SS in local time (the developer's wall
// clock, not UTC — backups are a human activity and the timestamp is
// for the human to read).
const now = new Date();
const pad = (n) => String(n).padStart(2, '0');
const ts =
  `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
  `-${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;

// Archive name includes the target so local and linked backups
// are distinguishable at a glance and restore can filter by target.
const workDir = join(BACKUPS_DIR, `${ts}-${target}`);
const archivePath = `${workDir}.tar.gz`;

if (existsSync(archivePath)) {
  bail(`Backup already exists: ${archivePath}`);
}

mkdirSync(workDir, { recursive: true });
mkdirSync(join(workDir, 'storage'), { recursive: true });

// --- Step 1: DB schema dump ---
step(1, 'Dumping database schema');
{
  const schemaPath = join(workDir, 'schema.sql');
  info(`supabase db dump ${targetFlag} --schema-only -> schema.sql`);
  const { code, stderr } = await runCapture('supabase', [
    'db', 'dump', targetFlag, '-f', schemaPath,
  ]);
  if (code !== 0) {
    bail(`Schema dump failed (exit ${code})`, stderr.slice(0, 500));
  }
  ok(`Schema dumped`);
}

// --- Step 2: DB data dump ---
step(2, 'Dumping database data (all schemas including auth + storage metadata)');
{
  const dataPath = join(workDir, 'data.sql');
  info(`supabase db dump ${targetFlag} --data-only -> data.sql`);
  const { code, stderr } = await runCapture('supabase', [
    'db', 'dump', targetFlag, '--data-only', '-f', dataPath,
  ]);
  if (code !== 0) {
    bail(`Data dump failed (exit ${code})`, stderr.slice(0, 500));
  }
  ok(`Data dumped`);
}

// --- Step 3: Copy schema.sql (for storage policies) ---
step(3, 'Including repo schema.sql (storage policies + idempotent schema)');
{
  if (!existsSync(SCHEMA_SOURCE)) {
    warn('supabase/schema.sql not found — storage policies will not be in the backup');
  } else {
    copyFileSync(SCHEMA_SOURCE, join(workDir, 'storage.sql'));
    ok('Copied schema.sql -> storage.sql');
  }
}

// --- Step 4: Download storage objects ---
step(4, 'Downloading storage objects');
const buckets = await listBuckets(targetFlag);
info(`Discovered ${buckets.length} bucket${buckets.length === 1 ? '' : 's'}: ${buckets.join(', ')}`);
{
  for (const bucket of buckets) {
    // The CLI creates the bucket name as a subdirectory under the
    // destination, so we pass the storage/ parent, not a per-bucket
    // directory. Source URL needs a trailing slash for recursion.
    info(`Bucket: ${bucket}`);

    const { code, stderr } = await runCapture('supabase', [
      'storage', 'cp', '-r', `ss:///${bucket}/`, join(workDir, 'storage'),
      targetFlag, '--experimental', '-j', '4',
    ]);

    if (code !== 0) {
      // An empty bucket makes the CLI exit non-zero with
      // "Object not found: /<bucket>/" on stderr. That is not an
      // error - there is simply nothing to copy. Distinguish it
      // from a genuine failure so an empty bucket does not read as
      // a data-loss warning.
      const clean = stderr
        .replace(/^WARN:.*$/gm, '')
        .trim();
      if (/Object not found/i.test(clean)) {
        info(`Bucket "${bucket}" is empty`);
      } else {
        warn(`Bucket "${bucket}" skipped: ${clean.slice(0, 300) || 'no objects or error'}`);
      }
    } else {
      // Count downloaded files on disk (CLI prints progress to stderr,
      // not stdout, so counting stdout lines is unreliable).
      const bucketDir = join(workDir, 'storage', bucket);
      const { readdirSync, statSync } = await import('node:fs');
      let fileCount = 0;
      function countFiles(dir) {
        for (const entry of readdirSync(dir)) {
          const full = join(dir, entry);
          if (statSync(full).isDirectory()) countFiles(full);
          else fileCount++;
        }
      }
      try { countFiles(bucketDir); } catch { fileCount = 0; }
      if (fileCount > 0) {
        ok(`Downloaded ${fileCount} object${fileCount === 1 ? '' : 's'}`);
      } else {
        info(`Bucket "${bucket}" is empty`);
      }
    }
  }
}

// --- Step 5: Write manifest ---
step(5, 'Writing manifest');
{
  const manifest = {
    timestamp: ts,
    target,
    created: now.toISOString(),
    buckets,
    files: {
      schema: 'schema.sql',
      data: 'data.sql',
      storageSchema: existsSync(join(workDir, 'storage.sql')) ? 'storage.sql' : null,
    },
  };
  writeFileSync(join(workDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  ok('Manifest written');
}

// --- Step 6: Archive ---
step(6, 'Creating tar.gz archive');
{
  info(`tar -czf ${ts}.tar.gz`);
  const { code, stderr } = await runCapture('tar', [
    '-czf', archivePath,
    '-C', BACKUPS_DIR,
    ts,
  ]);
  if (code !== 0) {
    bail(`tar failed (exit ${code})`, stderr.slice(0, 500));
  }

  // Clean up the unzipped directory — only the archive remains.
  rmSync(workDir, { recursive: true, force: true });
  ok(`Archive: ${archivePath}`);
}

console.log(`\n${style.green('Done.')}${style.dim(' To restore: mise run restore')}`);
