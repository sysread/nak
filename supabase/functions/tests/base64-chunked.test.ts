// Unit tests for the chunked, yielding base64 helper (M3 of the
// upscaler-liveness plan). The load-bearing property is byte-identity with
// a one-shot encode plus the between-slices yield that keeps the
// orchestrator's heartbeat interval serviced during multi-MB conversions.
import { assertEquals } from '@std/assert';
import { base64FromBytesChunked } from '../_shared/venice.ts';

/** One-shot reference encode. */
function referenceBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function deterministicBytes(len: number): Uint8Array {
  const bytes = new Uint8Array(len);
  // Cheap LCG: covers all byte values, differs per position.
  let x = 12345;
  for (let i = 0; i < len; i += 1) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    bytes[i] = (x >>> 16) & 0xff;
  }
  return bytes;
}

Deno.test('base64FromBytesChunked is byte-identical to a one-shot encode across lengths', async () => {
  // 1 and 2 exercise final-slice padding; 3 is exact; 24,577 crosses the
  // slice boundary by one byte; 0 is the empty edge.
  for (const len of [0, 1, 2, 3, 4, 24_575, 24_576, 24_577, 100_000]) {
    const bytes = deterministicBytes(len);
    assertEquals(await base64FromBytesChunked(bytes), referenceBase64(bytes), `len=${len}`);
  }
});

Deno.test('base64FromBytesChunked yields between slices, never inside one', async () => {
  const yields: number[] = [];
  const bytes = deterministicBytes(24_576 * 3 + 7); // 4 slices (3 full + tail)
  await base64FromBytesChunked(bytes, () => {
    yields.push(bytes.length);
    return Promise.resolve();
  });
  // Between 4 slices = 3 yields (none after the final slice).
  assertEquals(yields.length, 3);
});

Deno.test('base64FromBytesChunked encodes the empty array to an empty string', async () => {
  assertEquals(await base64FromBytesChunked(new Uint8Array(0)), '');
});
