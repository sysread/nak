// Shared thread-title sanitiser for both title-writing paths: the
// background auto-title unit (agents/auto_title.ts) and the model-driven
// update_title tool (tools/update_title.ts). One copy because the two paths
// have to produce byte-identical titles - the model reads the saved title
// back on the next round, and any divergence between the paths shows up as
// the model "thinking" it named the thread something the drawer doesn't
// display. Keeping the rule in one place is the structural guarantee of that
// parity.

// Mirror of TITLE_MAX_CHARS in src/lib/tools/update_title.schema.ts - the
// storage-side cap shared by tool-driven renames and the auto-title unit, so
// every path lands titles with the same shape.
const TITLE_MAX_CHARS = 80;

// Wrapping/leading junk to peel off the front of a title: whitespace, ASCII
// and Unicode "smart" quotes, Markdown emphasis/code markers (* _ `), and
// the line-prefix markers a model reaches for when it formats the title as a
// heading or quote (# >). Anchored at the start, so interior characters
// (the * in "A* search", the # in "C# basics") survive.
const LEADING_JUNK = /^[\s"'“”‘’*_`#>~]+/;

// Trailing junk: whitespace, quotes, Markdown emphasis/strikethrough markers,
// and the sentence-ending punctuation models add despite the prompt. No # or
// > here - those are only meaningful as line prefixes, and a trailing # is a
// real title character ("Issue #" style). Anchored at the end.
const TRAILING_JUNK = /[\s"'“”‘’*_`~.!?]+$/;

/**
 * Trim, collapse to the first non-empty line, strip wrapping quotes and
 * Markdown formatting plus trailing punctuation, cap length, and upper-case
 * the first character. The model's raw output is the only source for an
 * auto-generated title, so this is where it gets made presentable.
 *
 * Markdown stripping: the chat surface primes the model to use **bold** and
 * *italics* in its prose, and the small auto-title model wraps titles the
 * same way ("**Crested Butte Weekend**"); the prompts forbid it but prompt
 * instructions are advisory, so the strip is the actual guarantee. Only the
 * wrapping markers are removed (anchored runs) - emphasis a model puts around
 * one interior word is rare in a 3-6 word title and not worth the risk of
 * mangling legitimate punctuation mid-string.
 *
 * First-line split: the model sometimes ignores the "concise 3-6 word title"
 * instruction and stuffs its full response into the argument ("Holy Spirit
 * Origins in Christianity\n\nThe concept of the ..."). A straight 80-char
 * slice would store a multi-line string whose second line is a truncated
 * paragraph - the sidebar renders that as wrapped garbage. Taking only the
 * first non-empty line recovers the intended title in the common case.
 *
 * First-letter capitalization: the title-gen prompt says title-case is fine
 * but not required, so instruction-loose models routinely emit lowercase
 * ("troubleshooting the refrigerator"). We force the first character to
 * uppercase so every model-generated title lands looking the same. Only the
 * first character is touched; "iOS upgrade" style mid-word casing survives.
 */
export function sanitizeTitle(raw: string): string {
  const firstLine =
    raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? '';
  const trimmed = firstLine
    .replace(LEADING_JUNK, '')
    .replace(TRAILING_JUNK, '')
    .trim()
    .slice(0, TITLE_MAX_CHARS);
  if (trimmed.length === 0) return trimmed;
  return trimmed.charAt(0).toLocaleUpperCase() + trimmed.slice(1);
}
