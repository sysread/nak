// Tiny terminal UI helpers. No external dependencies.
import readline from 'node:readline/promises';
import { Writable } from 'node:stream';
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

// Masked secret entry. readline echoes every keystroke to its output stream;
// the previous approach monkeypatched the internal `_writeToOutput` to swap
// those for asterisks, but that hook is undefined on readline/promises (Node
// 20.x) and, even on the callback API, fights readline's full-line refresh
// under terminal:true. Instead, point readline's output at a sink that
// swallows the echo entirely: the secret is hidden (sudo-style - no echo, not
// even asterisks). The prompt is written to the real stdout up front, where
// readline never touches it; terminal:true keeps stdin in raw mode so the TTY
// itself doesn't echo either.
function askSecret(prompt, def) {
  const sink = new Writable({
    write(_chunk, _enc, cb) {
      cb();
    },
  });
  const rl = readline.createInterface({ input, output: sink, terminal: true });
  output.write(prompt);
  return rl.question('').then(
    (answer) => {
      output.write('\n');
      rl.close();
      return answer.trim() || (def ?? '');
    },
    (err) => {
      rl.close();
      throw err;
    }
  );
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

export async function choose(question, options, { defaultIndex = 0 } = {}) {
  const def =
    Number.isInteger(defaultIndex) && defaultIndex >= 0 && defaultIndex < options.length
      ? defaultIndex
      : 0;
  console.log(`  ${style.cyan('?')} ${question}`);
  options.forEach((opt, i) => {
    const marker = i === def ? style.dim(' (default)') : '';
    console.log(`      ${style.bold(String(i + 1))}. ${opt.label}${marker}`);
  });
  while (true) {
    const answer = await ask('  Pick a number', { default: String(def + 1) });
    const idx = parseInt(answer, 10) - 1;
    if (Number.isInteger(idx) && idx >= 0 && idx < options.length) {
      return options[idx].value;
    }
    warn('Not a valid choice. Try again.');
  }
}
