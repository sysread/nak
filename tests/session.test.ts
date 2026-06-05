import { describe, it, expect, beforeEach } from 'vitest';
import {
  getSessionThreadId,
  setSessionThreadId,
  clearSessionThreadId,
  __test,
} from '../src/lib/session';

describe('session', () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  it('returns null when no thread id is saved', () => {
    expect(getSessionThreadId()).toBeNull();
  });

  it('round-trips an active thread id', () => {
    setSessionThreadId('thread-123');
    expect(getSessionThreadId()).toBe('thread-123');
  });

  it('writes under the expected key', () => {
    setSessionThreadId('thread-123');
    expect(sessionStorage.getItem(__test.KEY)).toBe('thread-123');
  });

  it('setSessionThreadId(null) clears the id', () => {
    setSessionThreadId('thread-123');
    setSessionThreadId(null);
    expect(getSessionThreadId()).toBeNull();
  });

  it('clearSessionThreadId drops the id', () => {
    setSessionThreadId('thread-xyz');
    clearSessionThreadId();
    expect(getSessionThreadId()).toBeNull();
  });

  it('treats an empty string as null', () => {
    sessionStorage.setItem(__test.KEY, '');
    expect(getSessionThreadId()).toBeNull();
  });
});
