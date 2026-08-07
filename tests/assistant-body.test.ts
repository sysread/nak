/**
 * Unit coverage for the assistant-body UI primitives. Pure
 * functions - no runes, no DOM - tested via plain vitest. The
 * companion `src/components/AssistantBody.svelte` composes
 * these with its own runes (`citationsOpen`, `flashCite`) and
 * the body-click delegation that intercepts markdown citation
 * refs.
 */
import { describe, it, expect } from 'vitest';
import {
  citationFlashDelay,
  citationsToggleTitle,
  hasCitationRefsInBody,
  isCitationsUnavailable,
  parseCitationRefHref,
  showCitationsControls,
  showMessageActions,
} from '../src/lib/ui/assistant-body';

describe('hasCitationRefsInBody', () => {
  it('is false for empty content', () => {
    expect(hasCitationRefsInBody('')).toBe(false);
  });

  it('detects a single-index reference', () => {
    expect(hasCitationRefsInBody('See ^1^ for details.')).toBe(true);
  });

  it('detects a multi-index reference', () => {
    expect(hasCitationRefsInBody('See ^1,2,3^ for details.')).toBe(true);
  });

  it('tolerates whitespace around commas (matches the markdown extension)', () => {
    expect(hasCitationRefsInBody('See ^1 , 2^ for details.')).toBe(true);
  });

  it('is false for prose containing a stray caret', () => {
    expect(hasCitationRefsInBody('x^2 is squared.')).toBe(false);
  });

  it('is false for a single bare caret', () => {
    expect(hasCitationRefsInBody('^^^')).toBe(false);
  });
});

describe('isCitationsUnavailable', () => {
  it('is true only when the body has refs but no stored citations', () => {
    expect(isCitationsUnavailable(true, false)).toBe(true);
  });

  it('is false when stored citations exist (the normal case)', () => {
    expect(isCitationsUnavailable(true, true)).toBe(false);
  });

  it('is false when the body has no refs (the common case)', () => {
    // No refs + no citations = nothing to surface at all. The
    // panel and toggle should not appear; the primitive must
    // not flag this as orphaned.
    expect(isCitationsUnavailable(false, false)).toBe(false);
  });
});

describe('showCitationsControls', () => {
  it('is true when stored citations exist', () => {
    expect(showCitationsControls(true, false)).toBe(true);
  });

  it('is true in the orphan-refs case so the "unavailable" notice surfaces', () => {
    expect(showCitationsControls(false, true)).toBe(true);
  });

  it('is false when neither side has anything to show', () => {
    expect(showCitationsControls(false, false)).toBe(false);
  });
});

describe('citationsToggleTitle', () => {
  it('says sources were not saved in the orphan-refs case, regardless of open state', () => {
    expect(citationsToggleTitle(false, true, 0)).toBe('Sources not saved on this message');
    expect(citationsToggleTitle(true, true, 0)).toBe('Sources not saved on this message');
  });

  it('offers the hide action while the panel is open', () => {
    expect(citationsToggleTitle(true, false, 3)).toBe('Hide sources');
  });

  it('advertises the pluralized source count while closed', () => {
    expect(citationsToggleTitle(false, false, 1)).toBe('1 source');
    expect(citationsToggleTitle(false, false, 3)).toBe('3 sources');
  });
});

describe('citationFlashDelay', () => {
  it('is 0 when the panel was already open (no slide to wait for)', () => {
    expect(citationFlashDelay(true)).toBe(0);
  });

  it('is 240 when the panel had to slide open first', () => {
    // The 220ms slide plus a 20ms cushion for layout to settle.
    // Flashing earlier reads as jank.
    expect(citationFlashDelay(false)).toBe(240);
  });
});

describe('parseCitationRefHref', () => {
  it('extracts the numeric index from #cite-N hrefs', () => {
    expect(parseCitationRefHref('#cite-1')).toBe(1);
    expect(parseCitationRefHref('#cite-42')).toBe(42);
  });

  it('returns null for hrefs that do not match the pattern', () => {
    expect(parseCitationRefHref('#other')).toBeNull();
    expect(parseCitationRefHref('cite-1')).toBeNull();
    expect(parseCitationRefHref('')).toBeNull();
  });

  it('returns null for non-numeric tails (defensive against future emitters)', () => {
    expect(parseCitationRefHref('#cite-')).toBeNull();
  });
});

describe('showMessageActions', () => {
  it('renders the bar for a normal reply with content', () => {
    expect(showMessageActions('Hello.', true)).toBe(true);
  });

  it('renders the bar for content even without a regenerate target', () => {
    // e.g. a caller that omits onRegenerate still gets copy/citations.
    expect(showMessageActions('Hello.', false)).toBe(true);
  });

  it('renders the bar for an empty body when a regenerate target exists', () => {
    // A turn aborted mid-tool-call persists tool_calls with no text;
    // the regenerate button is the escape hatch from the hung call.
    expect(showMessageActions('', true)).toBe(true);
  });

  it('hides the bar when there is neither content nor a regenerate target', () => {
    expect(showMessageActions('', false)).toBe(false);
  });
});
