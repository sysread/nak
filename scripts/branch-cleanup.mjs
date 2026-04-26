#!/usr/bin/env node
// mise run branch-cleanup - delete remote branches under a given prefix that
// haven't been touched in N days. Defaults to `claude/*` (the convention for
// branches Claude Code on the web creates) and 10 days.
//
// Branches are deleted from origin regardless of merge status. The script
// always prints the list and asks for confirmation first; pass --yes to skip
// the prompt for scripted use.
//
// Args (all optional):
//   --days N         age threshold in days (default 10)
//   --prefix STR     remote branch prefix to match (default "claude/")
//   --yes, -y        skip the confirmation prompt
//   -h, --help       this message
//
// What it does NOT do:
//   - Touch local branches. `git branch -d <name>` is the user's call once
//     the remote is gone.
//   - Filter by merge status. The whole point is to garbage-collect stale
//     work-in-progress branches, which never merged.
import { banner, step, info, ok, warn, bail, confirm, style } from './lib/ui.mjs';
import { runCapture } from './lib/shell.mjs';

let days = 10;
let prefix = 'claude/';
let skipConfirm = false;

for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i];
  const next = process.argv[i + 1];
  if (arg === '--days' && next) {
    const n = parseInt(next, 10);
    if (!Number.isInteger(n) || n < 0) {
      bail(`--days must be a non-negative integer, got: ${next}`);
    }
    days = n;
    i++;
  } else if (arg === '--prefix' && next) {
    prefix = next;
    i++;
  } else if (arg === '--yes' || arg === '-y') {
    skipConfirm = true;
  } else if (arg === '-h' || arg === '--help') {
    console.log(
      'Usage: mise run branch-cleanup -- [--days N] [--prefix STR] [--yes]\n' +
        '\n' +
        'Lists remote branches under origin/<prefix>* whose latest commit is\n' +
        'older than N days and (after confirmation) deletes them from origin.\n' +
        'Defaults: --days 10, --prefix "claude/". Branches are deleted\n' +
        'regardless of merge status; local branches are not touched.'
    );
    process.exit(0);
  } else {
    bail(
      `Unknown arg: ${arg}`,
      'Usage: mise run branch-cleanup -- [--days N] [--prefix STR] [--yes]'
    );
  }
}

banner('Branch cleanup');
info(`Prefix: ${style.bold(prefix)}    Older than: ${style.bold(`${days}d`)}`);

step(1, 'Refresh remote-tracking refs (fetch --prune)');
const fetched = await runCapture('git', ['fetch', '--prune', 'origin']);
if (fetched.code !== 0) {
  bail(`git fetch --prune origin failed:\n${fetched.stderr.trim()}`);
}
ok('In sync with origin.');

step(2, 'Scan for stale branches');
// %(committerdate:unix) is the most recent commit's commit-date (not author
// date) as a Unix epoch. Tab as the field separator since refnames can't
// contain tabs but they can contain spaces.
const fer = await runCapture('git', [
  'for-each-ref',
  '--format=%(committerdate:unix)\t%(refname:short)',
  `refs/remotes/origin/${prefix}`,
]);
if (fer.code !== 0) {
  bail(`git for-each-ref failed:\n${fer.stderr.trim()}`);
}

const cutoff = Math.floor(Date.now() / 1000) - days * 86400;
const candidates = [];
for (const line of fer.stdout.split('\n')) {
  if (!line.trim()) continue;
  const [tsRaw, refShort] = line.split('\t');
  const ts = parseInt(tsRaw, 10);
  if (!Number.isFinite(ts)) continue;
  // refShort is "origin/<branch>"; the actual branch on origin is the rest.
  const branch = refShort.replace(/^origin\//, '');
  // Skip the symbolic origin/HEAD pointer (usually -> origin/main).
  if (branch === 'HEAD') continue;
  if (ts > cutoff) continue;
  candidates.push({ branch, ts });
}

if (candidates.length === 0) {
  ok(`No remote branches under "${prefix}" older than ${days} days. Nothing to do.`);
  process.exit(0);
}

candidates.sort((a, b) => a.ts - b.ts); // oldest first

console.log('');
console.log(
  `  ${style.bold(`Found ${candidates.length} branch(es)`)} older than ${days} days:`
);
console.log('');
const now = Date.now() / 1000;
for (const { branch, ts } of candidates) {
  const ageDays = Math.floor((now - ts) / 86400);
  const date = new Date(ts * 1000).toISOString().slice(0, 10);
  console.log(`    ${style.dim(date)}  ${style.dim(`(${ageDays}d)`)}  ${branch}`);
}
console.log('');
warn('These will be deleted from origin regardless of merge status.');

if (!skipConfirm) {
  const go = await confirm('Delete all of the above from origin?', { default: false });
  if (!go) {
    info('Aborted. No branches deleted.');
    process.exit(0);
  }
}

step(3, 'Delete from origin');
// One `git push --delete` with all branches: a single network round-trip,
// and git lists per-ref status in its output. If any ref is rejected the
// command exits non-zero; the stderr names the offender.
const branches = candidates.map((c) => c.branch);
const res = await runCapture('git', ['push', 'origin', '--delete', ...branches]);
if (res.code !== 0) {
  // Surface git's own per-ref report so the user can see which branch
  // was rejected and why (protected branch, already gone, etc.).
  console.log(res.stdout);
  console.log(res.stderr);
  bail('git push --delete reported errors; some branches may have been deleted.');
}
ok(`Deleted ${branches.length} branch(es) from origin.`);
