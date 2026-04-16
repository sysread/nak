// Shell helpers. Keeps all child_process noise in one place.
import { spawn } from 'node:child_process';

/** Run a command, inheriting stdio (useful for interactive flows). */
export function runInherit(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: 'inherit', ...opts });
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`${cmd} ${args.join(' ')} exited ${code}`))
    );
  });
}

/**
 * Run a command and capture stdout/stderr. Resolves with { stdout, stderr, code }.
 * Never throws on non-zero exit; callers decide what to do.
 */
export function runCapture(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      ...opts,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => resolve({ stdout, stderr, code }));
  });
}

export async function which(bin) {
  const res = await runCapture(process.platform === 'win32' ? 'where' : 'which', [bin]);
  return res.code === 0 ? res.stdout.trim().split('\n')[0] : null;
}
