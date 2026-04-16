// Covers the pure parser in scripts/lib/repo.mjs. The file lives under
// scripts/ but exports named functions we can import directly.
import { describe, it, expect } from 'vitest';
// @ts-expect-error — .mjs has no declarations, we test behavior only
import { parseGitHubRemote, pagesUrl } from '../scripts/lib/repo.mjs';

describe('parseGitHubRemote', () => {
  it('parses https remotes with .git suffix', () => {
    expect(parseGitHubRemote('https://github.com/alice/nak.git')).toEqual({
      owner: 'alice',
      repo: 'nak',
    });
  });
  it('parses https remotes without .git suffix', () => {
    expect(parseGitHubRemote('https://github.com/alice/nak')).toEqual({
      owner: 'alice',
      repo: 'nak',
    });
  });
  it('parses ssh remotes', () => {
    expect(parseGitHubRemote('git@github.com:alice/nak.git')).toEqual({
      owner: 'alice',
      repo: 'nak',
    });
  });
  it('parses ssh remotes with a host alias from ~/.ssh/config', () => {
    expect(parseGitHubRemote('git@github-truffle:alice/nak')).toEqual({
      owner: 'alice',
      repo: 'nak',
    });
  });
  it('parses ssh:// form', () => {
    expect(parseGitHubRemote('ssh://git@github.com/alice/nak.git')).toEqual({
      owner: 'alice',
      repo: 'nak',
    });
  });
  it('throws on unparseable remotes', () => {
    expect(() => parseGitHubRemote('not a url at all')).toThrow();
  });
});

describe('pagesUrl', () => {
  it('returns a subpath for project pages', () => {
    expect(pagesUrl({ owner: 'alice', repo: 'nak' })).toBe('https://alice.github.io/nak/');
  });
  it('returns the root for user/org pages repos', () => {
    expect(pagesUrl({ owner: 'alice', repo: 'alice.github.io' })).toBe(
      'https://alice.github.io/'
    );
  });
  it('is case-insensitive for the user-pages detection', () => {
    expect(pagesUrl({ owner: 'Alice', repo: 'ALICE.github.io' })).toBe(
      'https://Alice.github.io/'
    );
  });
});
