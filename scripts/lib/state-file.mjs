// .nak/state.json — small gitignored blob the wizard writes after the first
// run so repeatable tasks (sync, re-deploy, etc.) don't have to re-ask the
// user to identify the same project/repo every time.
//
// Currently stores:
//   supabase.projectRef  — the ref of the linked Supabase project
//
// More fields can be added without changing the read/write shape. Everything
// here is non-secret (it's just a pointer to a project you own), so leaving
// it out of git simply keeps one developer's state out of another's repo.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE_DIR = join(__dirname, '..', '..', '.nak');
const STATE_PATH = join(STATE_DIR, 'state.json');

export async function loadState() {
  if (!existsSync(STATE_PATH)) return null;
  try {
    const raw = await readFile(STATE_PATH, 'utf8');
    const json = JSON.parse(raw);
    return typeof json === 'object' && json !== null ? json : null;
  } catch {
    return null;
  }
}

export async function saveState(next) {
  if (!existsSync(STATE_DIR)) await mkdir(STATE_DIR, { recursive: true });
  await writeFile(STATE_PATH, JSON.stringify(next, null, 2) + '\n', 'utf8');
}

export const __paths = { STATE_DIR, STATE_PATH };
