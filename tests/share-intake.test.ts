import { describe, it, expect } from 'vitest';
import { formatSharesForComposer } from '../src/lib/share-intake';
import type { SharedPayload } from '../src/lib/share-store';

function payload(partial: Partial<SharedPayload>): SharedPayload {
  return {
    ts: 0,
    title: '',
    text: '',
    url: '',
    files: [],
    ...partial,
  };
}

function textFile(name: string, content: string, type = 'text/plain'): SharedPayload['files'][number] {
  return { name, type, blob: new Blob([content], { type }) };
}

function binaryFile(name: string, size: number, type: string): SharedPayload['files'][number] {
  const bytes = new Uint8Array(size);
  return { name, type, blob: new Blob([bytes], { type }) };
}

describe('formatSharesForComposer', () => {
  it('returns empty string for an empty payload list', async () => {
    expect(await formatSharesForComposer([])).toBe('');
  });

  it('emits title, text, and url on their own lines', async () => {
    const out = await formatSharesForComposer([
      payload({ title: 'Hello', text: 'world', url: 'https://example.com' }),
    ]);
    expect(out).toBe('Hello\n\nworld\n\nhttps://example.com');
  });

  it('deduplicates a url that is already inside the text body', async () => {
    const out = await formatSharesForComposer([
      payload({ text: 'read this: https://example.com — cool', url: 'https://example.com' }),
    ]);
    // URL appears exactly once.
    expect(out.match(/https:\/\/example\.com/g)?.length).toBe(1);
  });

  it('inlines a text file inside a fenced code block with a language hint', async () => {
    const out = await formatSharesForComposer([
      payload({ files: [textFile('example.ts', 'const x = 1;', 'text/typescript')] }),
    ]);
    expect(out).toContain('[shared file: example.ts');
    expect(out).toMatch(/```ts\nconst x = 1;\n```/);
  });

  it('extends the fence when the file body contains a triple-backtick run', async () => {
    const body = '```\nalready fenced\n```';
    const out = await formatSharesForComposer([
      payload({ files: [textFile('snippet.md', body, 'text/markdown')] }),
    ]);
    // Must use a four-backtick fence so the inner run doesn't close it early.
    expect(out).toContain('````markdown\n```\nalready fenced\n```\n````');
  });

  it('describes binary files by name/type/size rather than inlining', async () => {
    const out = await formatSharesForComposer([
      payload({ files: [binaryFile('cat.png', 4096, 'image/png')] }),
    ]);
    expect(out).toContain('[shared file: cat.png, image/png, 4 KB]');
    expect(out).not.toContain('```');
  });

  it('refuses to inline an oversized text file and notes the size cap', async () => {
    const big = 'x'.repeat(300 * 1024);
    const out = await formatSharesForComposer([
      payload({ files: [textFile('huge.txt', big)] }),
    ]);
    expect(out).toMatch(/too large to inline/);
    // Header still present so the user sees something landed.
    expect(out).toContain('[shared file: huge.txt');
  });

  it('joins multiple payloads with a horizontal rule so they stay visually distinct', async () => {
    const out = await formatSharesForComposer([
      payload({ text: 'first' }),
      payload({ text: 'second' }),
    ]);
    expect(out).toBe('first\n\n---\n\nsecond');
  });

  it('recognizes application/json as text-like via the MIME whitelist', async () => {
    const out = await formatSharesForComposer([
      payload({ files: [textFile('data.json', '{"a":1}', 'application/json')] }),
    ]);
    expect(out).toMatch(/```json\n\{"a":1\}\n```/);
  });

  it('falls back to the file extension when the MIME type is empty', async () => {
    const out = await formatSharesForComposer([
      payload({ files: [textFile('script.py', 'print("hi")', '')] }),
    ]);
    expect(out).toMatch(/```py\nprint\("hi"\)\n```/);
  });
});
