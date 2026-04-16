// Tiny terminal UI helpers. No external dependencies.
import readline from 'node:readline/promises';
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
  const rl = readline.createInterface({ input, output, terminal: true });
  const suffix = def ? ` [${def}]` : '';
  const prompt = `  ${style.cyan('?')} ${question}${suffix} `;
  try {
    if (secret) {
      // Mute output while the user types. readline doesn't natively support
      // this, so swap output.write with a no-op until newline.
      const origWrite = output.write.bind(output);
      rl.output = {
        ...output,
        write: (chunk, enc, cb) => {
          const s = typeof chunk === 'string' ? chunk : chunk.toString(enc || 'utf8');
          if (s.includes('\n')) origWrite('\n', enc, cb);
          else if (cb) cb();
          return true;
        },
      };
      // Write the prompt once, un-muted.
      origWrite(prompt);
      const answer = (await rl.question('')).trim();
      return answer || (def ?? '');
    }
    const answer = (await rl.question(prompt)).trim();
    return answer || (def ?? '');
  } finally {
    rl.close();
  }
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
