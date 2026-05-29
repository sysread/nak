/**
 * Unit coverage for the Library-list UI primitives. Pure functions - no
 * runes, no DOM - tested via plain vitest. The companion
 * `src/components/LibraryList.svelte` composes these with its own debounced
 * `$effect` and the markup.
 */
import { describe, it, expect } from 'vitest';
import {
  SEARCH_DEBOUNCE_MS,
  scannerLabel,
  emptyMessage,
  formatBytes,
  statusLabel,
} from '../src/lib/ui/library-list';

describe('SEARCH_DEBOUNCE_MS', () => {
  it('matches the cross-drawer 200ms convention', () => {
    expect(SEARCH_DEBOUNCE_MS).toBe(200);
  });
});

describe('scannerLabel', () => {
  it('frames a typed query as a search', () => {
    expect(scannerLabel('policy')).toBe('Searching documents');
  });
  it('frames the empty-query load as loading', () => {
    expect(scannerLabel('')).toBe('Loading documents');
    expect(scannerLabel('   ')).toBe('Loading documents');
  });
});

describe('emptyMessage', () => {
  it('reports no matches for an active query', () => {
    expect(emptyMessage('zzz')).toBe('No matching documents.');
  });
  it('explains the cold Library for an empty query', () => {
    expect(emptyMessage('')).toContain('Upload a file');
  });
});

describe('formatBytes', () => {
  it('handles zero and non-finite input', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(-5)).toBe('0 B');
    expect(formatBytes(NaN)).toBe('0 B');
  });
  it('reports bytes under 1 KiB verbatim', () => {
    expect(formatBytes(512)).toBe('512 B');
  });
  it('uses binary units with one decimal', () => {
    expect(formatBytes(1024)).toBe('1 KB');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5 MB');
  });
});

describe('statusLabel', () => {
  it('labels in-progress and failed states', () => {
    expect(statusLabel('pending')).toBe('Processing');
    expect(statusLabel('failed')).toBe('Not searchable');
  });
  it('renders no badge for a successfully-indexed document', () => {
    expect(statusLabel('done')).toBe('');
  });
});
