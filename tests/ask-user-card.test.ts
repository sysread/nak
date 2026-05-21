/**
 * Unit coverage for the ask-user-card UI primitives. Pure
 * functions - no runes, no DOM - tested via plain vitest. The
 * companion `src/components/AskUserCard.svelte` composes these
 * with the chip / textarea event handlers and the markup.
 */
import { describe, it, expect } from 'vitest';
import type {
  AskUserAnsweredContent,
  AskUserOption,
} from '../src/lib/tools/ask_user';
import { ASK_USER_ANSWERED_FLAG } from '../src/lib/tools/ask_user';
import { answeredText, abandonedLabel } from '../src/lib/ui/ask-user-card';

function answered(
  partial: Partial<AskUserAnsweredContent>,
): AskUserAnsweredContent {
  return {
    [ASK_USER_ANSWERED_FLAG]: true,
    answer: null,
    via: 'free_form',
    ...partial,
  };
}

const OPTIONS: readonly AskUserOption[] = [
  { label: 'Yes', description: 'Confirm and proceed.' },
  { label: 'No', description: 'Back out.' },
];

describe('answeredText', () => {
  it('returns empty string for a null payload', () => {
    expect(answeredText(null, OPTIONS)).toBe('');
  });

  it('prefers the persisted answer text when present', () => {
    const a = answered({ answer: 'free-form reply', via: 'free_form' });
    expect(answeredText(a, OPTIONS)).toBe('free-form reply');
  });

  it('prefers the answer text even when option_index is set', () => {
    // The live option-pick path writes BOTH answer (label) and
    // option_index, so the lookup-by-index fallback should only
    // fire when answer is genuinely missing.
    const a = answered({ answer: 'Yes', via: 'option', option_index: 0 });
    expect(answeredText(a, OPTIONS)).toBe('Yes');
  });

  it('falls back to option label when answer is null but option_index is set', () => {
    // Defensive recovery for a historical broken-write path that
    // saved option_index without the answer text. Surfacing the
    // label is strictly better than rendering nothing.
    const a = answered({ answer: null, via: 'option', option_index: 1 });
    expect(answeredText(a, OPTIONS)).toBe('No');
  });

  it('falls back to option label when answer is an empty string', () => {
    const a = answered({ answer: '', via: 'option', option_index: 0 });
    expect(answeredText(a, OPTIONS)).toBe('Yes');
  });

  it('returns empty string when option_index points past the options array', () => {
    const a = answered({ answer: null, via: 'option', option_index: 99 });
    expect(answeredText(a, OPTIONS)).toBe('');
  });

  it('returns empty string when neither answer nor option_index can resolve', () => {
    const a = answered({ answer: null, via: 'free_form' });
    expect(answeredText(a, OPTIONS)).toBe('');
  });
});

describe('abandonedLabel', () => {
  it('renders the reload-specific tag', () => {
    expect(abandonedLabel('abandoned_on_refresh')).toBe('(skipped on reload)');
  });

  it('renders the new-send-specific tag', () => {
    expect(abandonedLabel('abandoned_on_new_send')).toBe(
      '(skipped - sent a new message instead)',
    );
  });

  it('renders the sibling-cancellation tag', () => {
    expect(abandonedLabel('cancelled_by_sibling_ask_user')).toBe(
      '(cancelled - another question was asked at the same time)',
    );
  });

  it('falls back to a generic tag for the answered-state via values', () => {
    // 'option' and 'free_form' are answered states that should
    // never reach this function; if they do, the safe shape is a
    // neutral "(skipped)" rather than a confident wrong label.
    expect(abandonedLabel('option')).toBe('(skipped)');
    expect(abandonedLabel('free_form')).toBe('(skipped)');
  });

  it('falls back to a generic tag for undefined via', () => {
    expect(abandonedLabel(undefined)).toBe('(skipped)');
  });
});
