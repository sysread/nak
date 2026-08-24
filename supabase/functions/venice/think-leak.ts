// Relocation of leaked reasoning at the persistence boundary. The
// chat context injects priming as `<think>` blocks, and Venice
// normally separates the reasoning channel from content - but a
// degraded backend occasionally echoes a think block INTO the content
// channel (observed on deepseek-v4-flash while it was also emitting
// glitch tokens; Mistral was clean the same session). Persisting that
// leak pollutes every downstream reader: the transcript renders the
// model's scratch, and the summary/wiki/reflection workers ingest it
// as answer text. The trigger is provider-side; this module is the
// defense at the one seam every persisted reply passes through.

/**
 * Move a LEADING `<think>...</think>` span (or several back to back)
 * from a reply's content into its reasoning. Conservative on purpose:
 * only spans at the very start of the content qualify - that is where
 * a reasoning-channel leak lands, while a think tag later in the body
 * is far more likely to be quoted text or code the user asked about.
 * An unterminated leading `<think>` (no closing tag) is left alone
 * for the same reason: without the close there is no safe boundary.
 * Returns the inputs unchanged (same references) when nothing leaked.
 *
 * Either tag's leading `<` is optional: the same degraded backends
 * that leak the span also drop characters, and leaks arriving as bare
 * `think>` (opener missing its `<`) were observed on 3 of 8
 * deepseek-v4-flash turns in one QA session. The closer gets the same
 * tolerance so a span glitched on both ends still relocates. The
 * leading-span-only rule is what keeps this from eating quoted tags
 * mid-reply.
 */
export function splitLeakedThink(
  content: string,
  reasoning: string,
): { content: string; reasoning: string } {
  let rest = content;
  const moved: string[] = [];
  for (;;) {
    const m = rest.match(/^\s*<?think>([\s\S]*?)<?\/think>\s*/);
    if (!m) break;
    moved.push(m[1].trim());
    rest = rest.slice(m[0].length);
  }
  if (moved.length === 0) return { content, reasoning };
  const leaked = moved.filter((s) => s.length > 0).join('\n\n');
  return {
    content: rest,
    reasoning: reasoning.length > 0 && leaked.length > 0
      ? `${reasoning}\n\n${leaked}`
      : reasoning.length > 0
        ? reasoning
        : leaked,
  };
}
