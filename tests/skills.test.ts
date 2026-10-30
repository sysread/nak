/**
 * Unit coverage for the Skills detail panel's UI primitives. Pure
 * functions - no runes, no DOM, no reactive state - tested via plain
 * vitest. The companion `src/screens/Skills.svelte` is the only
 * caller that wires these into Svelte reactivity; a port to another
 * framework would re-use this module untouched.
 *
 * The surface cases map one-for-one onto the skillsPanelSurface
 * precedence list, and the duplicate cases pin the two halves of the
 * 23505 story: the client-side lower(name) pre-check and the
 * server-side constraint failure mapped onto the same named status.
 */
import { describe, it, expect } from 'vitest';
import {
  MAX_SKILL_BODY_CHARS,
  MAX_SKILL_DESCRIPTION_CHARS,
  MAX_SKILL_NAME_CHARS,
} from '../src/lib/skills';
import {
  SEARCH_FILTERED_HINT,
  SKILL_NOT_FOUND_NOTICE,
  SKILL_REMOVED_ELSEWHERE_NOTICE,
  isDuplicateSkillNameError,
  lastAuthorLabel,
  panelEmptyMessage,
  searchExcludesOpenSkill,
  skillActionNotice,
  skillFormError,
  skillsPanelSurface,
} from '../src/lib/ui/skills';
import type { SkillSummary } from '../src/lib/supabase';

// --- fixtures ---------------------------------------------------------------

function summary(id: string, name: string): SkillSummary {
  return {
    id,
    name,
    description: 'when to use it',
    updated_at: '2026-10-29T00:00:00Z',
    last_author: 'user',
  };
}

const loadedRows = [summary('a', 'release-notes'), summary('b', 'Lasagna')];

// --- surface selection (the state matrix) -----------------------------------

describe('skillsPanelSurface', () => {
  it('renders the list when no skill is routed (the default surface)', () => {
    expect(
      skillsPanelSurface({ mode: 'list', routedSkill: null, openState: 'idle' }),
    ).toBe('list');
  });

  it('renders detail for a routed skill that resolved', () => {
    expect(
      skillsPanelSurface({ mode: 'list', routedSkill: 'a', openState: 'ok' }),
    ).toBe('detail');
  });

  it('renders edit only over a resolved skill', () => {
    expect(
      skillsPanelSurface({ mode: 'edit', routedSkill: 'a', openState: 'ok' }),
    ).toBe('edit');
  });

  it('renders create regardless of the routed id (the button clears it)', () => {
    // Belt-and-braces: startCreate clears route.skill, so a routed id
    // here would be inconsistent state - but create still wins so the
    // user's typed form never vanishes behind a stale URL param.
    expect(
      skillsPanelSurface({ mode: 'create', routedSkill: 'a', openState: 'ok' }),
    ).toBe('create');
  });

  it('renders loading while the open-skill fetch is in flight', () => {
    expect(
      skillsPanelSurface({ mode: 'list', routedSkill: 'a', openState: 'loading' }),
    ).toBe('loading');
  });

  it('collapses to the list when getSkill returned null (stale URL, deleted elsewhere, account switch)', () => {
    // The notice channel carries WHICH of those happened; the surface
    // is the list either way. Edit mode over a missing row must not
    // render a form with nothing to save against.
    expect(
      skillsPanelSurface({ mode: 'list', routedSkill: 'a', openState: 'missing' }),
    ).toBe('list');
    expect(
      skillsPanelSurface({ mode: 'edit', routedSkill: 'a', openState: 'missing' }),
    ).toBe('list');
  });

  it('collapses to the list when the open-skill fetch failed', () => {
    expect(
      skillsPanelSurface({ mode: 'list', routedSkill: 'a', openState: 'error' }),
    ).toBe('list');
  });
});

// --- a search filters the listing surfaces only ------------------------------

describe('searchExcludesOpenSkill', () => {
  it('is true when a search is active and the open id is outside the hits', () => {
    // This is the condition that shows the clear-the-search hint
    // alongside a still-rendered detail.
    expect(searchExcludesOpenSkill('lasagna', 'zz', loadedRows)).toBe(true);
  });

  it('is false when the open row is inside the results, or nothing is open', () => {
    expect(searchExcludesOpenSkill('lasagna', 'a', loadedRows)).toBe(false);
    expect(searchExcludesOpenSkill('lasagna', null, loadedRows)).toBe(false);
  });

  it('is false with no active search even when the id is outside the loaded window', () => {
    // The query gate: an open row past the loaded browse pages is
    // paging, not filtering, and must not get a search-flavored
    // hint.
    expect(searchExcludesOpenSkill('', 'zz', loadedRows)).toBe(false);
  });

  it('treats a whitespace-only query as no search', () => {
    expect(searchExcludesOpenSkill('   ', 'zz', loadedRows)).toBe(false);
  });
});

// --- action-status vocabulary ------------------------------------------------

describe('skillActionNotice', () => {
  it('renders nothing when idle', () => {
    expect(skillActionNotice({ kind: 'idle' })).toBeNull();
  });

  it('names the in-flight states', () => {
    expect(skillActionNotice({ kind: 'saving' })).toEqual({
      text: 'Saving...',
      className: 'subtle',
    });
    expect(skillActionNotice({ kind: 'deleting' })).toEqual({
      text: 'Deleting...',
      className: 'subtle',
    });
  });

  it('surfaces the duplicate-name status as its own named error', () => {
    // The named 23505 status: its remedy (pick another name, or edit
    // the existing skill) differs from a generic failure, so the copy
    // names the collision rather than the RPC.
    expect(skillActionNotice({ kind: 'duplicate-name' })).toEqual({
      text: 'A skill with that name already exists. Names match case-insensitively.',
      className: 'error',
    });
  });

  it('prefixes errors with the action that failed', () => {
    expect(
      skillActionNotice({ kind: 'error', action: 'save', message: 'boom' }),
    ).toEqual({ text: "Couldn't save - boom", className: 'error' });
    expect(
      skillActionNotice({ kind: 'error', action: 'delete', message: 'boom' }),
    ).toEqual({ text: "Couldn't delete - boom", className: 'error' });
  });
});

describe('isDuplicateSkillNameError', () => {
  it('detects the unique-constraint failure in its wire guises', () => {
    // Postgres surfaces 23505 as message text by the time it reaches
    // the browser client; all three phrasings are the same failure.
    expect(isDuplicateSkillNameError('duplicate key value violates unique constraint "skills_name_key"')).toBe(true);
    expect(isDuplicateSkillNameError('error code 23505: something')).toBe(true);
    expect(isDuplicateSkillNameError('unique constraint on (user_id, lower(name))')).toBe(true);
  });

  it('passes non-duplicate failures through', () => {
    expect(isDuplicateSkillNameError('row-level security policy violated')).toBe(false);
    expect(isDuplicateSkillNameError('network request failed')).toBe(false);
  });
});

// --- form validation ---------------------------------------------------------

describe('skillFormError', () => {
  const cleanName = 'new-skill';
  const cleanDescription = 'When the release notes need drafting';
  const cleanBody = 'Do the thing.';

  it('accepts a clean draft', () => {
    expect(
      skillFormError(cleanName, cleanDescription, cleanBody, loadedRows),
    ).toBeNull();
  });

  it('reports the topmost offending field first', () => {
    expect(skillFormError('', '', '', loadedRows)).toEqual({
      kind: 'field',
      message: 'Name is required.',
    });
    expect(
      skillFormError('ok', '', '', loadedRows),
    ).toEqual({ kind: 'field', message: 'Description is required.' });
    expect(skillFormError('ok', 'ok', '', loadedRows)).toEqual({
      kind: 'field',
      message: 'Body is required.',
    });
  });

  it('enforces the per-field caps from the canonical constants', () => {
    expect(
      skillFormError('x'.repeat(MAX_SKILL_NAME_CHARS + 1), 'd', 'b', []),
    ).toEqual({
      kind: 'field',
      message: `Name must be ${MAX_SKILL_NAME_CHARS} chars or fewer.`,
    });
    expect(
      skillFormError('n', 'd'.repeat(MAX_SKILL_DESCRIPTION_CHARS + 1), 'b', []),
    ).toEqual({
      kind: 'field',
      message: `Description must be ${MAX_SKILL_DESCRIPTION_CHARS} chars or fewer.`,
    });
    expect(
      skillFormError('n', 'd', 'b'.repeat(MAX_SKILL_BODY_CHARS + 1), []),
    ).toEqual({
      kind: 'field',
      message: `Body must be ${MAX_SKILL_BODY_CHARS} chars or fewer.`,
    });
  });

  it('flags a duplicate name case-insensitively (the client-side 23505 pre-check)', () => {
    expect(skillFormError('Release-Notes', 'd', 'b', loadedRows)).toEqual({
      kind: 'duplicate-name',
    });
  });

  it('excludes the open skill from the duplicate check in edit mode', () => {
    // Keeping a skill's own name while editing its description is
    // not a collision with itself.
    expect(
      skillFormError('release-notes', 'd', 'b', loadedRows, 'a'),
    ).toBeNull();
  });

  it('still flags a rename onto another skill\'s name in edit mode', () => {
    expect(skillFormError('lasagna', 'd', 'b', loadedRows, 'a')).toEqual({
      kind: 'duplicate-name',
    });
  });
});

// --- display formatters + copy ------------------------------------------------

describe('lastAuthorLabel', () => {
  it('reads as the user or as Nak', () => {
    // The whole v1 edit trail: every write path stamps who made it.
    expect(lastAuthorLabel('user')).toBe('you');
    expect(lastAuthorLabel('assistant')).toBe('Nak');
  });
});

describe('panelEmptyMessage', () => {
  it('says "no matches" when a search excluded everything', () => {
    expect(panelEmptyMessage('lasagna')).toBe('No skills match "lasagna".');
  });

  it('explains the feature on a cold account', () => {
    expect(panelEmptyMessage('')).toBe(
      'Nothing here yet. Skills are reusable instructions for recurring tasks - create one with the New skill button.',
    );
  });

  it('treats whitespace-only queries as the empty case', () => {
    expect(panelEmptyMessage('   ')).toBe(panelEmptyMessage(''));
  });
});

describe('notice copy', () => {
  it('distinguishes not-found from removed-elsewhere', () => {
    // Two different causes for the same list-plus-notice surface: a
    // stale link vs a realtime DELETE that won over everything.
    expect(SKILL_NOT_FOUND_NOTICE).toContain("doesn't exist anymore");
    expect(SKILL_REMOVED_ELSEWHERE_NOTICE).toContain('removed elsewhere');
    expect(SEARCH_FILTERED_HINT).toContain('Clear the search');
  });
});
