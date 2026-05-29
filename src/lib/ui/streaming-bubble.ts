/**
 * UI-behavior primitives for the streaming assistant bubble shown while
 * the chat-loop is producing a turn.
 *
 * Pure functions only - no runes, no Svelte imports, no DOM access. The
 * reactive streaming buffers live on ExchangeSlot; this module owns the
 * "is there anything to show in the response card" predicate so the
 * .svelte template stays glue (it gates a card, it doesn't decide what
 * counts as content).
 */

/**
 * Whether the streaming assistant card has anything to render. The card
 * holds the response content - the reasoning panel, the streaming
 * markdown, the subconscious-priming checklist, and the rate-limit wait
 * row. The "still working" throbber lives OUTSIDE the card (as a
 * standalone row below it), so it is deliberately not part of this
 * predicate.
 *
 * Why gate the card at all: the chat-loop clears both streaming buffers
 * at every round boundary (onAssistantPersisted), and the subconscious
 * checklist is dismissed once the reply starts. That leaves real windows
 * where none of the four content sources is present - the inter-round
 * gap while tools execute or the next round opens, and the initial
 * pre-first-delta window right after the user hits send. Without this
 * gate the card would render as an empty bordered box in those gaps;
 * with it, only the standalone throbber shows until content arrives.
 *
 * The subconscious checklist is "present" only while it has rows AND
 * hasn't been dismissed yet - same condition the template's checklist
 * `{#if}` uses, so the card's lifetime matches the checklist's fade.
 */
export function streamingCardHasContent(
  slot: {
    streamingReasoning: string;
    streamingText: string;
    subconsciousDismissed: boolean;
    rateLimitWaitUntil: number | null;
  },
  subconsciousRowCount: number
): boolean {
  return (
    slot.streamingReasoning.length > 0 ||
    slot.streamingText.length > 0 ||
    (!slot.subconsciousDismissed && subconsciousRowCount > 0) ||
    slot.rateLimitWaitUntil !== null
  );
}
