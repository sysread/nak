#!/usr/bin/env node
// mise run update-venice-skills - refresh the vendored Venice API skills in
// .claude/skills/ from upstream veniceai/skills.
//
// The vendored skills are reference docs for the Venice wire shape nak talks
// to. They are a curated subset of the upstream catalog (a chat frontend
// doesn't need the audio/image/video/wallet surfaces), copied verbatim except
// for cross-links. See .claude/skills/README.md for the rationale.
//
// CURATED below is the single source of truth for WHICH skills are vendored.
// To add or drop a surface, edit that array and re-run this task; the script
// copies exactly that set, prunes any venice-* dir that's no longer in it, and
// rewrites links accordingly.
//
// Link handling mirrors what README.md documents: links among the curated set
// stay relative (`../venice-x/SKILL.md`) so they resolve in place; links that
// point at a NON-curated upstream skill are rewritten to an absolute upstream
// URL so a session that wants an unvendored surface is sent to the source
// instead of hitting a dangling path. Because "excluded" is derived as "not in
// CURATED", this stays correct even when upstream adds new surfaces.
//
// What it does NOT do:
//   - Commit. It leaves the working tree dirty for you to review and commit.
//   - Touch any .claude/skills file outside the venice-* dirs + LICENSE +
//     the commit pin line in README.md.
import { mkdtemp, rm, cp, readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { banner, step, info, ok, warn, bail } from './lib/ui.mjs';
import { runCapture } from './lib/shell.mjs';

const UPSTREAM_URL = 'https://github.com/veniceai/skills.git';
const UPSTREAM_BRANCH = 'main';
// Subdir within the upstream repo that holds one folder per skill.
const UPSTREAM_SKILLS_SUBDIR = 'skills';

// The curated subset. nak is a chat frontend over the Venice wire shape, so
// only the surfaces its request path exercises are vendored. Excluded on
// purpose: audio (speech/music/transcription), image generate/edit, video,
// characters, augment, crypto-rpc, x402 wallet payments.
const CURATED = [
  'venice-api-overview',
  'venice-auth',
  'venice-chat',
  'venice-responses',
  'venice-embeddings',
  'venice-models',
  'venice-errors',
  'venice-api-keys',
  'venice-billing',
];

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SKILLS_DIR = join(REPO_ROOT, '.claude', 'skills');

async function cloneUpstream() {
  const tmp = await mkdtemp(join(tmpdir(), 'venice-skills-'));
  step(1, `Cloning ${UPSTREAM_URL} (${UPSTREAM_BRANCH})`);
  const res = await runCapture('git', [
    'clone', '--depth', '1', '--branch', UPSTREAM_BRANCH, UPSTREAM_URL, tmp,
  ]);
  if (res.code !== 0) {
    await rm(tmp, { recursive: true, force: true });
    bail(`git clone failed:\n${res.stderr.trim()}`);
  }
  const sha = (await runCapture('git', ['-C', tmp, 'rev-parse', 'HEAD'])).stdout.trim();
  ok(`Upstream at ${sha.slice(0, 12)}`);
  return { tmp, sha };
}

// Copy each curated skill's folder verbatim, then prune any vendored venice-*
// dir that's no longer in CURATED so the tree matches the list exactly.
async function syncSkillFolders(tmp) {
  const upstreamSkills = join(tmp, UPSTREAM_SKILLS_SUBDIR);
  step(2, `Copying ${CURATED.length} curated skills`);
  for (const name of CURATED) {
    const src = join(upstreamSkills, name);
    const skillFile = join(src, 'SKILL.md');
    const exists = await readFile(skillFile).then(() => true).catch(() => false);
    if (!exists) {
      bail(`Curated skill '${name}' has no SKILL.md upstream. ` +
        `It may have been renamed or removed - update CURATED in this script.`);
    }
    const dst = join(SKILLS_DIR, name);
    await rm(dst, { recursive: true, force: true });
    await cp(src, dst, { recursive: true });
    info(name);
  }
  await pruneStaleSkills();
}

async function pruneStaleSkills() {
  const entries = await readdir(SKILLS_DIR, { withFileTypes: true });
  for (const e of entries) {
    if (e.isDirectory() && e.name.startsWith('venice-') && !CURATED.includes(e.name)) {
      warn(`Pruning ${e.name} (no longer in curated set)`);
      await rm(join(SKILLS_DIR, e.name), { recursive: true, force: true });
    }
  }
}

async function copyLicense(tmp) {
  await cp(join(tmp, 'LICENSE'), join(SKILLS_DIR, 'LICENSE'));
}

// Rewrite relative links that point at a NON-curated skill to an absolute
// upstream URL. Links among the curated set are left relative.
async function rewriteExcludedLinks() {
  step(3, 'Rewriting links to non-curated surfaces');
  const linkRe = /\.\.\/(venice-[a-z0-9-]+)\/SKILL\.md/g;
  let rewritten = 0;
  for (const name of CURATED) {
    const file = join(SKILLS_DIR, name, 'SKILL.md');
    const body = await readFile(file, 'utf8');
    const next = body.replace(linkRe, (match, target) =>
      CURATED.includes(target)
        ? match
        : `https://github.com/veniceai/skills/blob/${UPSTREAM_BRANCH}/${UPSTREAM_SKILLS_SUBDIR}/${target}/SKILL.md`
    );
    if (next !== body) {
      await writeFile(file, next);
      rewritten++;
    }
  }
  ok(`Rewrote excluded links in ${rewritten} file(s)`);
}

// Bump the "Vendored at upstream commit `<sha>`" pin in README so the
// provenance note tracks what was actually copied.
async function updateReadmePin(sha) {
  const readme = join(SKILLS_DIR, 'README.md');
  const body = await readFile(readme, 'utf8');
  const pinRe = /(Vendored at upstream commit `)[0-9a-f]{7,40}(`)/;
  if (!pinRe.test(body)) {
    warn('README commit pin not found - skipping pin update.');
    return;
  }
  await writeFile(readme, body.replace(pinRe, `$1${sha}$2`));
  ok(`README pinned to ${sha.slice(0, 12)}`);
}

async function main() {
  banner('Update vendored Venice API skills');
  await mkdir(SKILLS_DIR, { recursive: true });
  const { tmp, sha } = await cloneUpstream();
  try {
    await syncSkillFolders(tmp);
    await copyLicense(tmp);
    await rewriteExcludedLinks();
    await updateReadmePin(sha);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
  ok('Done. Review the working tree (git diff) and commit if it looks right.');
}

main().catch((err) => bail(err.message));
