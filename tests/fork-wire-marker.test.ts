// Guards on withForkPointMarker (src/lib/chat/prompt-assembly.ts) -
// the wire-only FORK POINT splice for a fresh fork's chat turns.
//
// This is the one piece of the fork chat framing a browser-driving QA
// bot cannot see (it lives in the request payload, never the DOM), so
// the unit test IS its verification: the marker lands exactly at the
// inherited/own seam, self-attributes its source, and disappears the
// moment the fork is renamed.

import { describe, expect, it } from 'vitest';
import { withForkPointMarker } from '../src/lib/chat/prompt-assembly';
import { forkTitle } from '../src/lib/forking';
import type { VeniceMessage } from '../src/lib/venice';

const markedTitle = forkTitle('Sourdough basics', 1);

function wire(...contents: string[]): VeniceMessage[] {
  return contents.map((content, i) => ({
    role: i % 2 === 0 ? 'user' : 'assistant',
    content,
  }));
}

describe('withForkPointMarker', () => {
  it('splices a system marker row at the inherited/own seam', () => {
    const conversation = wire('p-user', 'p-asst', 'own-user');
    const rows = [
      { thread_id: 'parent' },
      { thread_id: 'parent' },
      { thread_id: 'own' },
    ];
    const out = withForkPointMarker(conversation, rows, 'own', markedTitle);
    expect(out).toHaveLength(4);
    expect(out[0].content).toBe('p-user');
    expect(out[1].content).toBe('p-asst');
    expect(out[2].role).toBe('system');
    expect(out[3].content).toBe('own-user');
  });

  it('marker copy names nak and the boundary direction', () => {
    const out = withForkPointMarker(
      wire('p', 'o'),
      [{ thread_id: 'parent' }, { thread_id: 'own' }],
      'own',
      markedTitle
    );
    const marker = String(out[1].content);
    expect(marker).toContain('FORK POINT');
    // Provenance-marked: an unexplained instruction-shaped insertion
    // reads as prompt injection to hardened models.
    expect(marker).toContain('nak');
    expect(marker).toContain('inherited from the parent conversation');
  });

  it('returns the conversation untouched - same reference - once the fork is renamed', () => {
    const conversation = wire('p', 'o');
    const rows = [{ thread_id: 'parent' }, { thread_id: 'own' }];
    expect(withForkPointMarker(conversation, rows, 'own', 'Rye experiments')).toBe(
      conversation
    );
  });

  it('no-ops without inherited rows or without a resolvable title', () => {
    const conversation = wire('a', 'b');
    const ownRows = [{ thread_id: 'own' }, { thread_id: 'own' }];
    expect(withForkPointMarker(conversation, ownRows, 'own', markedTitle)).toBe(
      conversation
    );
    const forkRows = [{ thread_id: 'parent' }, { thread_id: 'own' }];
    expect(withForkPointMarker(conversation, forkRows, 'own', undefined)).toBe(
      conversation
    );
  });

  it('does not mutate the input conversation when it splices', () => {
    const conversation = wire('p', 'o');
    const out = withForkPointMarker(
      conversation,
      [{ thread_id: 'parent' }, { thread_id: 'own' }],
      'own',
      markedTitle
    );
    expect(conversation).toHaveLength(2);
    expect(out).not.toBe(conversation);
  });
});
