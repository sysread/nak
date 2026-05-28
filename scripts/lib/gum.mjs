// gum widgets. Wraps the `gum` binary (charmbracelet/gum, installed via mise's
// aqua backend) for the interactive config flow in setup-supabase.mjs.
//
// gum draws its TUI on stderr and prints the chosen/entered result to stdout,
// so each runner inherits stdin (for the keyboard) and stderr (for the UI)
// while piping stdout to capture the result. A non-zero exit means the user
// cancelled (esc / ctrl-c, exit 130) or declined (confirm "no", exit 1); the
// helpers map that to null / false rather than throwing.
import { spawn } from 'node:child_process';
import { which } from './shell.mjs';

export async function gumAvailable() {
  return (await which('gum')) !== null;
}

function runGum(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('gum', args, { stdio: ['inherit', 'pipe', 'inherit'] });
    let stdout = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => resolve({ stdout: stdout.trim(), code }));
  });
}

/**
 * Single-select from `items` (an array of strings). Returns the chosen string,
 * or null if the user cancelled.
 */
export async function gumChoose(header, items) {
  const { stdout, code } = await runGum(['choose', '--header', header, ...items]);
  if (code !== 0 || stdout.length === 0) return null;
  return stdout;
}

/**
 * Free-text (or masked, when `password`) input. Returns the entered string, or
 * null if the user cancelled. An empty entry also returns null so callers can
 * treat "pressed enter on a blank field" as "no change".
 */
export async function gumInput({ header, placeholder = '', password = false } = {}) {
  const args = ['input', '--header', header];
  if (placeholder) args.push('--placeholder', placeholder);
  if (password) args.push('--password');
  const { stdout, code } = await runGum(args);
  if (code !== 0 || stdout.length === 0) return null;
  return stdout;
}
