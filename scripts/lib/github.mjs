// Thin wrappers over the gh CLI. We use `gh api` everywhere so the script
// works with any gh version that supports `api`.
import { runCapture, runInherit, which } from './shell.mjs';

const GH_HOSTNAME = 'github.com';

// Scopes the wizard needs:
//   - `repo`     — admin access to the repo, which covers Pages management.
//                  Every default `gh auth login` already has this.
//   - `workflow` — required to dispatch the Deploy workflow via the API.
//                  Default login usually includes it; refresh if missing.
// There is no standalone `pages` OAuth scope — Pages is part of `repo`.
export const REQUIRED_SCOPES = ['repo', 'workflow'];

export async function ghAvailable() {
  return (await which('gh')) !== null;
}

function extractScopes(text) {
  // `gh auth status` prints a line like:
  //   - Token scopes: 'gist', 'read:org', 'repo', 'workflow'
  const m = text.match(/Token scopes:\s*([^\n]+)/);
  if (!m) return [];
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
}

export async function ghAuthStatus() {
  // `gh auth status` exits 0 when authed; it writes scope info to stderr.
  const res = await runCapture('gh', ['auth', 'status']);
  const blob = `${res.stderr}\n${res.stdout}`;
  const scopes = extractScopes(blob);
  const missing = REQUIRED_SCOPES.filter((s) => !scopes.includes(s));
  return {
    ok: res.code === 0,
    scopes,
    missingScopes: missing,
    hasAllScopes: missing.length === 0,
    raw: blob,
  };
}

export async function ghLoginInteractive() {
  await runInherit('gh', [
    'auth',
    'login',
    '--web',
    '--hostname',
    GH_HOSTNAME,
    '--git-protocol',
    'https',
  ]);
}

export async function ghRefreshScopes(scopes) {
  const args = ['auth', 'refresh', '--hostname', GH_HOSTNAME];
  for (const s of scopes) args.push('-s', s);
  await runInherit('gh', args);
}

export async function ghApi(method, path, fields = []) {
  const args = ['api', '--method', method, path];
  for (const [k, v] of fields) {
    args.push('-f', `${k}=${v}`);
  }
  const res = await runCapture('gh', args);
  return res;
}

export async function ghApiJson(method, path, fields = []) {
  const res = await ghApi(method, path, fields);
  if (res.code !== 0) {
    const err = new Error(`gh api ${method} ${path} failed: ${res.stderr.trim()}`);
    err.stderr = res.stderr;
    err.stdout = res.stdout;
    err.code = res.code;
    throw err;
  }
  try {
    return JSON.parse(res.stdout);
  } catch {
    return res.stdout;
  }
}
