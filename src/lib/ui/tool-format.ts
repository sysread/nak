/**
 * Generic JSON -> markdown formatter for the tool-call detail
 * panel. The panel was rendering a single `json` fenced block per
 * call, which means long string fields couldn't wrap - users had to
 * horizontally scroll through `\n`-escaped one-liners to read a web-
 * search citation or a memory note. This module produces a TOML-ish
 * markdown rendering where each nested object/array element gets a
 * `**bracket-path**` section header and its scalar fields become a
 * wrapping bullet list. Long strings get promoted to their own block
 * (blockquote for prose, fenced for multi-line text) so they reflow
 * to the panel width instead of overflowing.
 *
 * The companion file `./tool-calls.ts` wires this into the
 * arguments/result render path; `src/lib/tools/types.ts` lets
 * individual tools override the generic shape via optional
 * `formatArgs` / `formatResult` schema fields when a tool's payload
 * has a domain-specific pretty form (e.g. cooklang source belongs
 * in a fenced block, not a bullet).
 *
 * Pure functions only - no runes, no DOM. Tested at
 * `tests/tool-format.test.ts`.
 */

/**
 * Length above which a single-line string is considered "long
 * enough to deserve its own block" - bumped out of the bullet list
 * and rendered as a blockquote so it can wrap freely. 120 chars
 * matches roughly the width of the detail panel at desktop sizes;
 * anything narrower would need horizontal scroll inside the bullet.
 */
const LONG_STRING_THRESHOLD = 120;

/**
 * Cap on how many items of a large array we render before tailing
 * with a "and N more" placeholder. A long memory-search result with
 * fifty rows is unreadable rendered in full; the user can flip the
 * view to JSON if they need the exhaustive list.
 */
const ARRAY_TRUNCATE_AT = 25;

function isPrimitive(v: unknown): boolean {
  return (
    v === null ||
    typeof v === 'string' ||
    typeof v === 'number' ||
    typeof v === 'boolean'
  );
}

/**
 * Strings that span multiple lines or exceed the bullet-width
 * threshold get bumped out of the inline `key: value` shape into
 * their own block. Multi-line wins the choice between blockquote
 * and fence: a payload that already has newlines was structured
 * by the producer, and a fence preserves that structure verbatim.
 */
function isLongString(s: string): boolean {
  return s.includes('\n') || s.length > LONG_STRING_THRESHOLD;
}

/**
 * URLs render as `<scheme://...>` so marked's autolink rule
 * picks them up and produces a clickable anchor; otherwise long
 * URLs sit in a bullet as bare text and don't link out.
 */
function looksLikeUrl(s: string): boolean {
  return /^https?:\/\/\S+$/.test(s);
}

/**
 * Identifier-ish strings (no whitespace, contains a digit or a
 * hyphen-style separator) render as inline code so id-vs-prose
 * is visually distinct in a bullet list. Snake-case all-letter
 * tokens like `mentioned_in` or `confidence_tag` look like enum
 * values, which read better as plain prose than as code; the
 * heuristic excludes them.
 */
function looksLikeIdentifier(s: string): boolean {
  if (!/^[\w-]+$/.test(s)) return false;
  if (/\d/.test(s)) return true;
  // Hyphen with no underscore tends to be id-shape (uuid-like);
  // pure underscore tokens tend to be enum values (English).
  return /-/.test(s) && !/_/.test(s);
}

/**
 * Markdown-escape the characters that would otherwise be
 * interpreted as inline syntax in a bullet's value position.
 * Asterisks (emphasis), backticks (code spans), and backslashes
 * (escape leader) always fire wherever they appear; underscores
 * only fire as emphasis when flanked by non-word characters
 * (CommonMark "intraword emphasis" rule), so a snake_case
 * identifier in the middle of prose stays unescaped while a
 * standalone `_italic_` run still gets neutralised. Whole
 * strings that get promoted to their own block (blockquote or
 * fence) bypass this and render verbatim.
 */
function escapeInline(s: string): string {
  return s
    .replace(/([*`\\])/g, '\\$1')
    .replace(/(^|\W)_/g, '$1\\_')
    .replace(/_(\W|$)/g, '\\_$1');
}

function formatScalar(v: unknown): string {
  if (v === null) return '`null`';
  if (typeof v === 'boolean') return '`' + String(v) + '`';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'string') {
    if (v.length === 0) return '`""`';
    if (looksLikeUrl(v)) return '<' + v + '>';
    if (looksLikeIdentifier(v)) return '`' + v + '`';
    return escapeInline(v);
  }
  // Shouldn't be reachable - callers gate on isPrimitive - but
  // hand back something rather than throwing.
  return '`' + JSON.stringify(v) + '`';
}

/**
 * Render a multi-line or over-threshold string as its own block,
 * labelled with the parent key. Always a blockquote - never a
 * fence - because the whole point of promoting a string out of
 * the inline bullet is to let it wrap to the panel width, and
 * fenced ` ``` ` content sits inside `<pre>` which defeats
 * wrapping. Multi-line content is preserved by prefixing every
 * line with `> ` (paragraph breaks survive as blank `>` lines);
 * single-line content gets a single quoted line.
 *
 * Tools whose result is structured text where the line breaks
 * carry meaning (cooklang source, code, tracebacks, JSON-in-a-
 * string error payloads) should declare a `formatArgs` /
 * `formatResult` override on their schema and emit a fenced
 * block themselves. The generic path optimises for prose,
 * which is the common case in tool-call payloads.
 */
function formatLongStringBlock(label: string, v: string): string[] {
  const quoted = v
    .split('\n')
    .map((line) => (line.length > 0 ? '> ' + line : '>'))
    .join('\n');
  return ['**' + label + ':**', '', quoted];
}

/**
 * Empty containers render as a labelled placeholder so the user
 * sees there was nothing rather than wondering whether the field
 * was elided.
 */
function emptyContainerLine(path: string, label: string): string {
  return path ? '**' + path + ':** ' + label : label;
}

interface FormatState {
  out: string[];
}

function pushBlank(state: FormatState): void {
  if (state.out.length > 0 && state.out[state.out.length - 1] !== '') {
    state.out.push('');
  }
}

function pushLines(state: FormatState, lines: string[]): void {
  for (const line of lines) state.out.push(line);
}

function formatObject(
  obj: Record<string, unknown>,
  path: string,
  state: FormatState
): void {
  const keys = Object.keys(obj);
  if (keys.length === 0) {
    pushBlank(state);
    state.out.push(emptyContainerLine(path, '_(empty object)_'));
    return;
  }

  const scalarKeys: string[] = [];
  const longStringKeys: string[] = [];
  const nestedKeys: string[] = [];
  for (const k of keys) {
    const v = obj[k];
    if (isPrimitive(v)) {
      if (typeof v === 'string' && isLongString(v)) longStringKeys.push(k);
      else scalarKeys.push(k);
    } else {
      nestedKeys.push(k);
    }
  }

  if (path) {
    pushBlank(state);
    state.out.push('**' + path + '**');
    state.out.push('');
  }

  for (const k of scalarKeys) {
    state.out.push('- **' + k + ':** ' + formatScalar(obj[k]));
  }

  for (const k of longStringKeys) {
    pushBlank(state);
    pushLines(state, formatLongStringBlock(k, obj[k] as string));
  }

  for (const k of nestedKeys) {
    const childPath = path ? path + '.' + k : k;
    formatValue(obj[k], childPath, state);
  }
}

function formatArray(arr: unknown[], path: string, state: FormatState): void {
  if (arr.length === 0) {
    pushBlank(state);
    state.out.push(emptyContainerLine(path, '_(empty list)_'));
    return;
  }

  // An array of primitives renders as a bullet list under the
  // current path header. Mixed or object-bearing arrays iterate
  // with a `[i]` suffix on the path so each element gets its own
  // section header - emitting a `**path**` header above those
  // would just duplicate the path prefix of every per-item
  // header below.
  if (arr.every(isPrimitive)) {
    if (path) {
      pushBlank(state);
      state.out.push('**' + path + '**');
      state.out.push('');
    }
    const display = arr.slice(0, ARRAY_TRUNCATE_AT);
    for (const v of display) {
      if (typeof v === 'string' && isLongString(v)) {
        pushBlank(state);
        pushLines(state, formatLongStringBlock('item', v));
      } else {
        state.out.push('- ' + formatScalar(v));
      }
    }
    if (arr.length > ARRAY_TRUNCATE_AT) {
      state.out.push(
        '- _… and ' + (arr.length - ARRAY_TRUNCATE_AT) + ' more_'
      );
    }
    return;
  }

  const display = arr.slice(0, ARRAY_TRUNCATE_AT);
  display.forEach((item, i) => {
    const itemPath = path ? path + '[' + i + ']' : '[' + i + ']';
    formatValue(item, itemPath, state);
  });
  if (arr.length > ARRAY_TRUNCATE_AT) {
    pushBlank(state);
    state.out.push(
      '_… and ' + (arr.length - ARRAY_TRUNCATE_AT) + ' more items_'
    );
  }
}

function formatValue(
  v: unknown,
  path: string,
  state: FormatState
): void {
  if (isPrimitive(v)) {
    if (typeof v === 'string' && isLongString(v)) {
      pushBlank(state);
      pushLines(state, formatLongStringBlock(path || 'value', v));
      return;
    }
    if (path) {
      state.out.push('- **' + path + ':** ' + formatScalar(v));
      return;
    }
    state.out.push(formatScalar(v));
    return;
  }
  if (Array.isArray(v)) {
    formatArray(v, path, state);
    return;
  }
  if (typeof v === 'object' && v !== null) {
    formatObject(v as Record<string, unknown>, path, state);
    return;
  }
  // Unknown shape (undefined, function, symbol). JSON doesn't
  // carry these, but the formatter is called from a tool result
  // that may not always be JSON-clean - render a placeholder
  // rather than swallow.
  state.out.push(emptyContainerLine(path, '_(unrenderable)_'));
}

/**
 * Top-level entry point. Hand it any JSON-parsed value (object,
 * array, primitive) and get back a markdown string the
 * `<Markdown>` component can render. The output trims trailing
 * blank lines so adjacent fenced blocks in the detail panel
 * don't pick up stray gaps.
 */
export function formatJsonAsMarkdown(value: unknown): string {
  const state: FormatState = { out: [] };
  formatValue(value, '', state);
  // Drop trailing blank lines.
  while (state.out.length > 0 && state.out[state.out.length - 1] === '') {
    state.out.pop();
  }
  return state.out.join('\n');
}

/**
 * Convenience wrapper for the wire-shape case: a JSON-encoded
 * string from `call.function.arguments` or a tool-result row's
 * `content` column. Parses then formats; on parse failure falls
 * back to a fenced block of the raw string so the user can still
 * see what the model emitted (partial-stream args, non-JSON
 * tool returns).
 */
export function formatJsonStringAsMarkdown(raw: string): string {
  if (!raw) return '_(empty)_';
  try {
    const parsed = JSON.parse(raw) as unknown;
    return formatJsonAsMarkdown(parsed);
  } catch {
    return '```\n' + raw + '\n```';
  }
}
