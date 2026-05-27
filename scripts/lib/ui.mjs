// Tiny terminal UI helpers. No external dependencies.
import readline from 'node:readline/promises';
// The callback readline API is used only for masked secret entry: it exposes
// the internal `_writeToOutput` hook that asterisk-masking needs, which the
// promises API does NOT (it is undefined on Node 20.x and crashed every
// secret prompt). See askSecret below.
import readlineCb from 'node:readline';
import { stdin as input, stdout as output } from 'node:process';

const isTTY = output.isTTY;
const c = (code) => (s) => (isTTY ? `\x1b[${code}m${s}\x1b[0m` : s);

export const style = {
  bold: c('1'),
  dim: c('2'),
  red: c('31'),
  green: c('32'),
  yellow: c('33'),
  blue: c('34'),
  magenta: c('35'),
  cyan: c('36'),
};

export function banner(title) {
  const line = '━'.repeat(Math.max(8, title.length + 2));
  console.log(`\n${style.cyan(line)}`);
  console.log(` ${style.bold(title)}`);
  console.log(`${style.cyan(line)}\n`);
}

export function step(n, title) {
  console.log(`\n${style.bold(style.blue(`[Step ${n}]`))} ${style.bold(title)}`);
}

export function info(msg) {
  console.log(`  ${style.dim('›')} ${msg}`);
}

export function hint(msg) {
  console.log(`  ${style.dim('hint:')} ${style.dim(msg)}`);
}

export function ok(msg) {
  console.log(`  ${style.green('✓')} ${msg}`);
}

export function warn(msg) {
  console.log(`  ${style.yellow('!')} ${msg}`);
}

export function fail(msg) {
  console.log(`  ${style.red('✗')} ${msg}`);
}

export function bail(msg, recovery = null) {
  fail(msg);
  if (recovery) console.log(`\n  ${style.yellow('What to do:')} ${recovery}\n`);
  process.exit(1);
}

export async function ask(question, { default: def, secret = false } = {}) {
  const suffix = def ? ` [${def}]` : '';
  const prompt = `  ${style.cyan('?')} ${question}${suffix} `;
  if (secret) return askSecret(prompt, def);
  const rl = readline.createInterface({ input, output, terminal: true });
  try {
    const answer = (await rl.question(prompt)).trim();
    return answer || (def ?? '');
  } finally {
    rl.close();
  }
}

// Masked secret entry. Uses the callback readline API because it exposes the
// `_writeToOutput` hook the promises API lacks. The prompt is written first so
// it isn't masked; everything readline echoes afterward is replaced with '*'.
function askSecret(prompt, def) {
  return new Promise((resolve, reject) => {
    const rl = readlineCb.createInterface({ input, output, terminal: true });
    output.write(prompt);
    const originalWriteToOutput = rl._writeToOutput.bind(rl);
    rl._writeToOutput = (chunk) => {
      if (typeof chunk !== 'string' || chunk.length === 0) return originalWriteToOutput(chunk);
      // Newlines end the input — pass through untouched.
      if (chunk === '\n' || chunk === '\r' || chunk === '\r\n') return originalWriteToOutput(chunk);
      // Backspace sequences (readline uses '\b \b' to erase a char) — pass
      // through so the visual cursor moves back and erases the asterisk.
      if (chunk.charCodeAt(0) === 0x08) return originalWriteToOutput(chunk);
      // Everything else is one-or-more printable chars; show that many asterisks.
      return originalWriteToOutput('*'.repeat(chunk.length));
    };
    rl.question('', (answer) => {
      rl.close();
      resolve(answer.trim() || (def ?? ''));
    });
    rl.on('error', (err) => {
      rl.close();
      reject(err);
    });
  });
}

/**
 * Prompt twice for a secret and verify the two entries match. Retries up to
 * `attempts` times. Returns the matching value, or throws if exhausted.
 */
export async function askSecretTwice(question, { minLength = 0, attempts = 3 } = {}) {
  for (let i = 0; i < attempts; i++) {
    const a = await ask(question, { secret: true });
    if (a.length < minLength) {
      fail(`Must be at least ${minLength} characters.`);
      continue;
    }
    const b = await ask('Re-enter to confirm', { secret: true });
    if (a === b) return a;
    fail("Passwords don't match. Try again.");
  }
  throw new Error(`Gave up after ${attempts} mismatched attempts.`);
}

export async function confirm(question, { default: def = true } = {}) {
  const hint = def ? 'Y/n' : 'y/N';
  const a = (await ask(`${question} (${hint})`)).toLowerCase();
  if (!a) return def;
  return a.startsWith('y');
}

export async function choose(question, options) {
  console.log(`  ${style.cyan('?')} ${question}`);
  options.forEach((opt, i) => {
    console.log(`      ${style.bold(String(i + 1))}. ${opt.label}`);
  });
  while (true) {
    const answer = await ask('  Pick a number', { default: '1' });
    const idx = parseInt(answer, 10) - 1;
    if (Number.isInteger(idx) && idx >= 0 && idx < options.length) {
      return options[idx].value;
    }
    warn('Not a valid choice. Try again.');
  }
}
