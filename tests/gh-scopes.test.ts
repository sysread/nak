import { describe, it, expect } from 'vitest';
// @ts-expect-error — .mjs has no declarations, test behavior only
import { REQUIRED_SCOPES } from '../scripts/lib/github.mjs';

describe('REQUIRED_SCOPES', () => {
  it('includes repo (covers Pages admin)', () => {
    expect(REQUIRED_SCOPES).toContain('repo');
  });
  it('includes workflow (for dispatching the deploy workflow)', () => {
    expect(REQUIRED_SCOPES).toContain('workflow');
  });
  it('does NOT include a nonexistent `pages` scope', () => {
    // pages is not a GitHub OAuth scope; Pages admin is part of repo.
    expect(REQUIRED_SCOPES).not.toContain('pages');
  });
});
