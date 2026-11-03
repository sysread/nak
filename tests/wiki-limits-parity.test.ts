// Parity guard: the edge-side wiki limits module mirrors the limits the
// browser's src/lib/wiki.ts declares (the tag pair is re-exported from
// the shared module; the other four remain browser-canonical copies).
// A one-sided edit must fail here instead of drifting at runtime.
import { describe, it, expect } from 'vitest';
import {
  MAX_WIKI_TITLE_CHARS,
  MAX_WIKI_CONTENT_CHARS,
  MAX_WIKI_RECORD_CONTENT_CHARS,
  MAX_WIKI_RECORD_TAGS,
  MAX_WIKI_RECORD_TAG_CHARS,
  MAX_WIKI_CHANGELOG_MESSAGE_CHARS,
} from '../src/lib/wiki';
import {
  MAX_WIKI_TITLE_CHARS as S_TITLE,
  MAX_WIKI_CONTENT_CHARS as S_CONTENT,
  MAX_WIKI_RECORD_CONTENT_CHARS as S_RECORD_CONTENT,
  MAX_WIKI_RECORD_TAGS as S_TAGS,
  MAX_WIKI_RECORD_TAG_CHARS as S_TAG_CHARS,
  MAX_WIKI_CHANGELOG_MESSAGE_CHARS as S_CHANGELOG,
} from '../supabase/functions/_shared/wiki-limits';

describe('wiki limits parity: src/lib/wiki.ts vs $shared/wiki-limits', () => {
  it('every mirrored limit matches its twin', () => {
    expect(MAX_WIKI_TITLE_CHARS).toBe(S_TITLE);
    expect(MAX_WIKI_CONTENT_CHARS).toBe(S_CONTENT);
    expect(MAX_WIKI_RECORD_CONTENT_CHARS).toBe(S_RECORD_CONTENT);
    expect(MAX_WIKI_CHANGELOG_MESSAGE_CHARS).toBe(S_CHANGELOG);
  });

  it('the re-exported tag pair matches the shared module it comes from', () => {
    // src/lib/wiki.ts re-exports these from $shared/wiki-limits, so the
    // pair is equal by construction - the pin exists to catch a future
    // edit that flips it back to a local copy with a drifted value.
    expect(MAX_WIKI_RECORD_TAGS).toBe(S_TAGS);
    expect(MAX_WIKI_RECORD_TAG_CHARS).toBe(S_TAG_CHARS);
  });
});
