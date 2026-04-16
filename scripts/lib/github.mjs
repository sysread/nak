// Thin wrappers over the gh CLI. We use `gh api` everywhere so the script
// works with any gh version that supports `api`.
import { runCapture, runInherit, which } from './shell.mjs';

export async function ghAvailable() {
  return (await which('gh')) !== null;
}

export async function ghAuthStatus() {
  // `gh auth status` exits 0 when authed.
  const res = await runCapture('gh', ['auth', 'status']);
  return {
    ok: res.code === 0,
    hasPagesScope: /pages/.test(res.stderr) || /pages/.test(res.stdout),
    raw: res.stderr || res.stdout,
  };
}

export async function ghLoginInteractive() {
  // Inherit stdio — gh drives the browser + keypad flow itself.
  await runInherit('gh', ['auth', 'login', '--web', '--git-protocol', 'https']);
}

export async function ghRefreshScopes(scopes) {
  const args = ['auth', 'refresh'];
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
