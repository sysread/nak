/**
 * Unit coverage for the recovery-banner selector. Pure function - no
 * runes, no DOM - tested via plain vitest. The companion
 * `src/screens/Chat.svelte` feeds it `displayedError`, the orphaned-draft
 * state, and `incompleteTurnTail` and renders the single descriptor it
 * returns; this proves the precedence (error > interrupted-draft >
 * cut-off) and the copy/variant each source maps to.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  selectRecoveryBanner,
  CUT_OFF_BANNER_TEXT,
  INTERRUPTED_BANNER_TEXT,
  type RecoveryBannerSources,
} from '../src/lib/ui/recovery-banner';

function sources(over: Partial<RecoveryBannerSources> = {}): RecoveryBannerSources {
  return { error: null, interruptedDraft: null, cutOff: null, ...over };
}

describe('selectRecoveryBanner', () => {
  it('returns null when no source is active (healthy tail)', () => {
    expect(selectRecoveryBanner(sources())).toBeNull();
  });

  it('maps the error source to a red alert variant, passing heading/text/retry/dismiss through', () => {
    const retry = vi.fn();
    const dismiss = vi.fn();
    const banner = selectRecoveryBanner(
      sources({ error: { heading: 'Rate limited', text: 'Try again soon.', retry, dismiss } }),
    );
    expect(banner).toEqual({
      variant: 'error',
      heading: 'Rate limited',
      text: 'Try again soon.',
      retry,
      dismiss,
    });
  });

  it('carries an error with no retry (non-recoverable) but keeps dismiss', () => {
    const dismiss = vi.fn();
    const banner = selectRecoveryBanner(sources({ error: { text: 'Auth expired.', dismiss } }));
    expect(banner?.variant).toBe('error');
    expect(banner?.retry).toBeUndefined();
    expect(banner?.dismiss).toBe(dismiss);
  });

  it('maps an interrupted draft to the muted incomplete variant with its own copy + dismiss', () => {
    const retry = vi.fn();
    const dismiss = vi.fn();
    const banner = selectRecoveryBanner(sources({ interruptedDraft: { retry, dismiss } }));
    expect(banner).toEqual({
      variant: 'incomplete',
      text: INTERRUPTED_BANNER_TEXT,
      retry,
      dismiss,
    });
  });

  it('maps a cut-off tail to the incomplete variant with retry but no dismiss', () => {
    const retry = vi.fn();
    const banner = selectRecoveryBanner(sources({ cutOff: { retry } }));
    expect(banner).toEqual({ variant: 'incomplete', text: CUT_OFF_BANNER_TEXT, retry });
    expect(banner?.dismiss).toBeUndefined();
  });

  it('prefers the error over both recovery sources', () => {
    const banner = selectRecoveryBanner(
      sources({
        error: { text: 'boom', dismiss: vi.fn() },
        interruptedDraft: { retry: vi.fn(), dismiss: vi.fn() },
        cutOff: { retry: vi.fn() },
      }),
    );
    expect(banner?.variant).toBe('error');
    expect(banner?.text).toBe('boom');
  });

  it('prefers the interrupted draft over a cut-off tail (the overlap that used to stack two banners)', () => {
    const banner = selectRecoveryBanner(
      sources({ interruptedDraft: { retry: vi.fn(), dismiss: vi.fn() }, cutOff: { retry: vi.fn() } }),
    );
    expect(banner?.text).toBe(INTERRUPTED_BANNER_TEXT);
    expect(banner?.dismiss).toBeDefined();
  });
});
