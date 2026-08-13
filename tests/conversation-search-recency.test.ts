// Guards on the recency controls in the conversation_search wire schema
// (src/lib/tools/conversation_search.schema.ts).
//
// The regression these exist for: the tool ranked purely by cosine
// similarity, which has no time dimension. Asked for "a conversation
// from the last few days about meal planning", the model searched by
// topic, got back ten semantically-nearest threads from May and July,
// and correctly reported that none were recent - because there was no
// way to express the time frame at all. The target thread, updated the
// day before, ranked 22nd of 478 on topic alone.
//
// The schema text is the whole interface here: the model only knows to
// reach for these because the description tells it to, so the wording
// is as load-bearing as the parameters.

import { describe, expect, it } from 'vitest';
import {
  conversationSearchSchema,
  CONVERSATION_SEARCH_MAX_WITHIN_DAYS,
} from '../src/lib/tools/conversation_search.schema';

const props = conversationSearchSchema.parameters.properties as Record<
  string,
  { type: string; description: string; minimum?: number; maximum?: number }
>;

describe('conversation_search recency controls', () => {
  it('exposes a hard window and a soft preference as separate knobs', () => {
    // Separate on purpose. A filter answers "it was on Tuesday"; a
    // preference answers "we talked about it recently". Collapsing them
    // into one control forces the caller to over- or under-constrain.
    expect(props.within_days.type).toBe('integer');
    expect(props.prefer_recent.type).toBe('boolean');
  });

  it('bounds within_days so a nonsense value cannot reach the query', () => {
    expect(props.within_days.minimum).toBe(1);
    expect(props.within_days.maximum).toBe(CONVERSATION_SEARCH_MAX_WITHIN_DAYS);
  });

  it('neither control is required - a plain topical search still works', () => {
    expect(conversationSearchSchema.parameters.required).toEqual(['query']);
  });

  it('warns that ranking ignores time unless asked', () => {
    // Without this the model has no reason to suspect that a query
    // mentioning "yesterday" will happily return a year-old thread.
    expect(conversationSearchSchema.description).toMatch(/RANKING IS BY TOPIC ONLY/);
  });

  it('tells the model which control fits a requirement vs a lean', () => {
    // The failure mode if it picks wrong: within_days on a vague
    // "recently" silently drops the right answer; prefer_recent on a
    // hard "yesterday" silently keeps a year-old one.
    expect(props.within_days.description).toMatch(/hard filter/i);
    expect(props.prefer_recent.description).toMatch(/without\s+excluding/i);
  });

  it('sets expectations that the preference is gentle', () => {
    // It is +0.05 against a top-10 band of ~0.04. A model expecting it
    // to surface a weak-but-recent thread would misread empty results
    // as "we never discussed this".
    expect(props.prefer_recent.description).toMatch(/NOT lift a weak match/);
  });

  it('gives concrete numbers for the phrases users actually say', () => {
    // "a few days" -> 3 is the exact case that failed. Leaving the model
    // to invent a number is how "recently" becomes within_days: 1.
    expect(props.within_days.description).toMatch(/few days.*\b3\b/);
    expect(props.within_days.description).toMatch(/last\s*week.*\b7\b/);
  });
});
