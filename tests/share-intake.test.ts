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
  it('returns empty text and no files for an empty payload list', async () => {
    expect(await formatSharesForComposer([])).toEqual({ text: '', files: [] });
  });

  it('emits title, text, and url on their own lines', async () => {
    const out = await formatSharesForComposer([
      payload({ title: 'Hello', text: 'world', url: 'https://example.com' }),
    ]);
    expect(out.text).toBe('Hello\n\nworld\n\nhttps://example.com');
    expect(out.files).toEqual([]);
  });

  it('deduplicates a url that is already inside the text body', async () => {
    const out = await formatSharesForComposer([
      payload({ text: 'read this: https://example.com — cool', url: 'https://example.com' }),
    ]);
    // URL appears exactly once.
    expect(out.text.match(/https:\/\/example\.com/g)?.length).toBe(1);
    expect(out.files).toEqual([]);
  });

  it('inlines a text file inside a fenced code block with a language hint', async () => {
    const out = await formatSharesForComposer([
      payload({ files: [textFile('example.ts', 'const x = 1;', 'text/typescript')] }),
    ]);
    expect(out.text).toContain('[shared file: example.ts');
    expect(out.text).toMatch(/```ts\nconst x = 1;\n```/);
    expect(out.files).toEqual([]);
  });

  it('extends the fence when the file body contains a triple-backtick run', async () => {
    const body = '```\nalready fenced\n```';
    const out = await formatSharesForComposer([
      payload({ files: [textFile('snippet.md', body, 'text/markdown')] }),
    ]);
    // Must use a four-backtick fence so the inner run doesn't close it early.
    expect(out.text).toContain('````markdown\n```\nalready fenced\n```\n````');
  });

  it('routes binary files to the attachments array rather than the text body', async () => {
    const out = await formatSharesForComposer([
      payload({ files: [binaryFile('cat.png', 4096, 'image/png')] }),
    ]);
    expect(out.text).toBe('');
    expect(out.files).toHaveLength(1);
    expect(out.files[0].name).toBe('cat.png');
    expect(out.files[0].type).toBe('image/png');
    expect(out.files[0].size).toBe(4096);
  });

  it('routes oversized text files to the attachments array instead of truncating', async () => {
    const big = 'x'.repeat(300 * 1024);
    const out = await formatSharesForComposer([
      payload({ files: [textFile('huge.txt', big)] }),
    ]);
    // Oversized text doesn't land in the prompt - the attachment
    // pipeline enforces the per-file cap and runs text extraction.
    expect(out.text).toBe('');
    expect(out.files).toHaveLength(1);
    expect(out.files[0].name).toBe('huge.txt');
    expect(out.files[0].size).toBe(300 * 1024);
  });

  it('mixes inlined text and attached binary from a single payload', async () => {
    const out = await formatSharesForComposer([
      payload({
        text: 'look at this photo',
        files: [
          textFile('caption.txt', 'hello', 'text/plain'),
          binaryFile('cat.png', 1024, 'image/png'),
        ],
      }),
    ]);
    expect(out.text).toContain('look at this photo');
    expect(out.text).toMatch(/```txt\nhello\n```/);
    expect(out.text).not.toContain('cat.png');
    expect(out.files.map((f) => f.name)).toEqual(['cat.png']);
  });

  it('joins multiple payloads with a horizontal rule so they stay visually distinct', async () => {
    const out = await formatSharesForComposer([
      payload({ text: 'first' }),
      payload({ text: 'second' }),
    ]);
    expect(out.text).toBe('first\n\n---\n\nsecond');
  });

  it('pools files across payloads and preserves arrival order', async () => {
    const out = await formatSharesForComposer([
      payload({ files: [binaryFile('one.png', 1, 'image/png')] }),
      payload({ files: [binaryFile('two.png', 1, 'image/png')] }),
    ]);
    expect(out.text).toBe('');
    expect(out.files.map((f) => f.name)).toEqual(['one.png', 'two.png']);
  });

  it('recognizes application/json as text-like via the MIME whitelist', async () => {
    const out = await formatSharesForComposer([
      payload({ files: [textFile('data.json', '{"a":1}', 'application/json')] }),
    ]);
    expect(out.text).toMatch(/```json\n\{"a":1\}\n```/);
  });

  it('falls back to the file extension when the MIME type is empty', async () => {
    const out = await formatSharesForComposer([
      payload({ files: [textFile('script.py', 'print("hi")', '')] }),
    ]);
    expect(out.text).toMatch(/```py\nprint\("hi"\)\n```/);
  });
});
