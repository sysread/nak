// Lockstep guard for the skills char-limit pair. src/lib/skills.ts
// is the canonical constants file; supabase/functions/_shared/
// skills-limits.ts is the Deno-island mirror the edge tools import
// (the edge function cannot load browser modules). Both are
// importable from vitest - the mirror is pure constants - so the
// pair is asserted directly. A drift otherwise surfaces only as the
// edge tool rejecting a value the panel accepts (or vice versa),
// with nothing pointing at the mirror; the mirror's own header
// commits to staying a complete copy, and this pin makes that
// commitment checkable.
import { describe, expect, it } from 'vitest';
import * as canonical from '../src/lib/skills';
import * as mirror from '../supabase/functions/_shared/skills-limits';

// Sorted export names both files must carry - catches a constant
// added to one file but not the other (the partial-mirror drift the
// mirror's header warns about).
const EXPECTED_KEYS = [
  'MAX_SKILL_BODY_CHARS',
  'MAX_SKILL_DESCRIPTION_CHARS',
  'MAX_SKILL_INDEX_CHARS',
  'MAX_SKILL_INDEX_ENTRIES',
  'MAX_SKILL_NAME_CHARS',
];

describe('skills limits Deno-island mirror', () => {
  it('exports the same constant set as the canonical file', () => {
    expect(Object.keys(mirror).sort()).toEqual(EXPECTED_KEYS);
    expect(Object.keys(canonical).sort()).toEqual(EXPECTED_KEYS);
  });

  it('mirrors every constant value exactly', () => {
    expect(mirror.MAX_SKILL_NAME_CHARS).toBe(canonical.MAX_SKILL_NAME_CHARS);
    expect(mirror.MAX_SKILL_DESCRIPTION_CHARS).toBe(
      canonical.MAX_SKILL_DESCRIPTION_CHARS,
    );
    expect(mirror.MAX_SKILL_BODY_CHARS).toBe(canonical.MAX_SKILL_BODY_CHARS);
    expect(mirror.MAX_SKILL_INDEX_ENTRIES).toBe(canonical.MAX_SKILL_INDEX_ENTRIES);
    expect(mirror.MAX_SKILL_INDEX_CHARS).toBe(canonical.MAX_SKILL_INDEX_CHARS);
  });
});
