/**
 * UI-behavior primitives for the inline `ask_user` card. Pure
 * functions only - no runes, no Svelte imports, no DOM. The
 * companion `src/components/AskUserCard.svelte` composes these
 * with its own framework-native reactivity (the `$state` for the
 * "Other" textarea, the focus-on-next-tick handler, the chip /
 * textarea event bindings, the markup).
 *
 * The persisted-row shape this module reads from lives in
 * `src/lib/tools/ask_user.ts` - `AskUserAnsweredContent` for the
 * answered/abandoned payloads, `AskUserOption` for the original
 * options, `AskUserVia` for the routing tag.
 */

import type {
  AskUserOption,
  AskUserAnsweredContent,
  AskUserVia,
} from '$lib/ask-user';

/**
 * The line shown under the question in the "answered" state.
 *
 * Three-step fallback because the persisted row can land in any
 * of these shapes depending on which write path produced it:
 *
 *   1. `answer.answer` is the canonical free-text string the
 *      user (or the option-pick handler) saved. Live path always
 *      writes this; prefer it whenever present and non-empty.
 *   2. If `answer.answer` is null/empty but `option_index` is
 *      set, recover the chosen text by looking up the label in
 *      the original options array. Defensive - only the
 *      historical broken-write path produces this shape, but
 *      surfacing the label is strictly better than rendering
 *      nothing.
 *   3. Otherwise empty string. The caller renders the surrounding
 *      "Answered:" prefix unconditionally; an empty answer reads
 *      as a malformed row but at least doesn't crash.
 */
export function answeredText(
  answer: AskUserAnsweredContent | null,
  options: readonly AskUserOption[],
): string {
  if (!answer) return '';
  if (typeof answer.answer === 'string' && answer.answer.length > 0) {
    return answer.answer;
  }
  if (
    typeof answer.option_index === 'number' &&
    options[answer.option_index]
  ) {
    return options[answer.option_index].label;
  }
  return '';
}

/**
 * User-facing tag for the abandoned state. Each `via` value maps
 * to a distinct reason the question never got answered, and the
 * user should be able to tell them apart on a re-read of the
 * conversation:
 *
 *   - `abandoned_on_refresh`         - page reload before submit
 *   - `abandoned_on_new_send`        - user sent a new message
 *                                       instead of answering
 *   - `cancelled_by_sibling_ask_user` - a second ask_user fired
 *                                       in the same turn and
 *                                       superseded this one
 *
 * The `default` branch catches future `AskUserVia` values and
 * the literal `'option'` / `'free_form'` cases that should never
 * land here (those are the answered states, not abandoned) -
 * rendering "(skipped)" is the safe fallback.
 */
export function abandonedLabel(via: AskUserVia | undefined): string {
  switch (via) {
    case 'abandoned_on_refresh':
      return '(skipped on reload)';
    case 'abandoned_on_new_send':
      return '(skipped - sent a new message instead)';
    case 'cancelled_by_sibling_ask_user':
      return '(cancelled - another question was asked at the same time)';
    default:
      return '(skipped)';
  }
}
