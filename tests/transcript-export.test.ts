import { describe, expect, it } from 'vitest';
import {
  buildTranscriptMarkdown,
  canExportTranscript,
  transcriptExportFilename,
} from '../src/lib/ui/transcript-export';
import type { Attachment, Message } from '../src/lib/supabase';

function msg(over: Partial<Message>): Message {
  return {
    id: 'm1',
    thread_id: 't1',
    role: 'user',
    content: 'hello',
    created_at: '2026-07-01T12:30:00Z',
    ...over,
  } as Message;
}

// Mirror the builder's local-timezone formatting so the assertions hold
// in any TZ the test runner happens to use.
function localStamp(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}

describe('transcriptExportFilename', () => {
  it('slugifies the title', () => {
    expect(
      transcriptExportFilename({ id: 'abcdef1234', title: 'Fixing the CI Deploy!' }),
    ).toBe('fixing-the-ci-deploy.md');
  });

  it('falls back to an id prefix for empty or all-symbol titles', () => {
    expect(transcriptExportFilename({ id: 'abcdef1234', title: '???' })).toBe(
      'abcdef12.md',
    );
    expect(transcriptExportFilename({ id: 'abcdef1234', title: '  ' })).toBe(
      'abcdef12.md',
    );
  });

  it('caps the slug at 60 chars without a trailing hyphen', () => {
    const name = transcriptExportFilename({ id: 'x'.repeat(12), title: 'a '.repeat(80) });
    expect(name.length).toBeLessThanOrEqual(63);
    expect(name).not.toContain('-.md');
  });
});

describe('buildTranscriptMarkdown', () => {
  const thread = { title: 'Trip planning', created_at: '2026-06-30T08:00:00Z' };

  it('emits title, created line, and one section per visible turn', () => {
    const md = buildTranscriptMarkdown(thread, [
      msg({ role: 'user', content: 'Where to?' }),
      msg({ id: 'm2', role: 'assistant', content: 'Lisbon.', created_at: '2026-07-01T12:31:00Z' }),
    ]);
    expect(md).toContain('# Trip planning');
    expect(md).toContain(`Created: ${localStamp('2026-06-30T08:00:00Z')}`);
    expect(md).toContain(`## User - ${localStamp('2026-07-01T12:30:00Z')}`);
    expect(md).toContain(`## Assistant - ${localStamp('2026-07-01T12:31:00Z')}`);
    expect(md).toContain('Where to?');
    expect(md).toContain('Lisbon.');
    expect(md.endsWith('\n')).toBe(true);
  });

  it('drops system, tool, and empty assistant rows', () => {
    const md = buildTranscriptMarkdown(thread, [
      msg({ role: 'system', content: 'prompt' }),
      msg({ role: 'tool', content: '{"ok":true}' }),
      msg({ role: 'assistant', content: '   ' }),
      msg({ role: 'user', content: 'kept' }),
    ]);
    expect(md).not.toContain('prompt');
    expect(md).not.toContain('"ok"');
    expect(md.match(/^## /gm)).toHaveLength(1);
    expect(md).toContain('kept');
  });

  it('notes user attachments by filename', () => {
    const md = buildTranscriptMarkdown(thread, [
      msg({
        attachments: [
          { filename: 'plan.pdf' } as Attachment,
          { filename: 'map.png' } as Attachment,
        ],
      }),
    ]);
    expect(md).toContain('*Attachments: plan.pdf, map.png*');
  });

  it('appends a Sources list and rewrites ^N^ markers on cited messages', () => {
    const md = buildTranscriptMarkdown(thread, [
      msg({
        role: 'assistant',
        content: 'Lisbon is sunny.^1^ Porto too.^2^',
        citations: [
          { index: 1, title: 'Lisbon weather', url: 'https://a.example/x', date: '2026-06-01' },
          { index: 2, url: 'https://b.example/y' },
        ],
      }),
    ]);
    expect(md).toContain('Lisbon is sunny.[1] Porto too.[2]');
    expect(md).not.toContain('^1^');
    expect(md).toContain('Sources:');
    expect(md).toContain('1. [Lisbon weather](https://a.example/x) - 2026-06-01');
    // Untitled/undated citations fall back to the bare URL, no dangling dash.
    expect(md).toContain('2. [https://b.example/y](https://b.example/y)\n');
  });

  it('leaves carets alone on messages without citations', () => {
    const md = buildTranscriptMarkdown(thread, [
      msg({ role: 'assistant', content: 'x^2^ means x squared' }),
    ]);
    expect(md).toContain('x^2^ means x squared');
    expect(md).not.toContain('Sources:');
  });

  it('falls back to Untitled conversation for a blank title', () => {
    const md = buildTranscriptMarkdown({ title: ' ', created_at: 'nonsense' }, []);
    expect(md).toContain('# Untitled conversation');
    // Unparseable timestamps pass through verbatim rather than NaN-ing.
    expect(md).toContain('Created: nonsense');
  });
});

describe('canExportTranscript', () => {
  it('requires a persisted thread, closed digest, and messages', () => {
    expect(canExportTranscript(null, false, 3)).toBe(false);
    expect(canExportTranscript({ isDraft: true }, false, 3)).toBe(false);
    expect(canExportTranscript({}, true, 3)).toBe(false);
    expect(canExportTranscript({}, false, 0)).toBe(false);
    expect(canExportTranscript({}, false, 3)).toBe(true);
  });
});
