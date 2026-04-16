import { describe, it, expect } from 'vitest';
import { encrypt, decrypt, __test } from '../src/lib/crypto';

describe('crypto', () => {
  it('uses >= 600k PBKDF2 iterations', () => {
    expect(__test.PBKDF2_ITERATIONS).toBeGreaterThanOrEqual(600_000);
  });

  it('round-trips a UTF-8 string', async () => {
    const msg = 'hello 🌍 — secrets here';
    const ct = await encrypt(msg, 'correct horse battery staple');
    const pt = await decrypt(ct, 'correct horse battery staple');
    expect(pt).toBe(msg);
  });

  it('produces different ciphertext for identical plaintext (random salt/IV)', async () => {
    const a = await encrypt('same', 'pw');
    const b = await encrypt('same', 'pw');
    expect(a).not.toBe(b);
  });

  it('fails cleanly on wrong password', async () => {
    const ct = await encrypt('secret', 'right-pw');
    await expect(decrypt(ct, 'wrong-pw')).rejects.toThrow(/wrong password|corrupted/i);
  });

  it('rejects empty password', async () => {
    await expect(encrypt('x', '')).rejects.toThrow();
    await expect(decrypt('abc', '')).rejects.toThrow();
  });

  it('rejects tampered ciphertext', async () => {
    const ct = await encrypt('secret', 'pw');
    const bytes = atob(ct);
    // Flip the last byte (inside the GCM tag).
    const tampered =
      bytes.slice(0, -1) + String.fromCharCode(bytes.charCodeAt(bytes.length - 1) ^ 0x01);
    const tamperedB64 = btoa(tampered);
    await expect(decrypt(tamperedB64, 'pw')).rejects.toThrow();
  });

  it('rejects ciphertext that is too short', async () => {
    await expect(decrypt(btoa('short'), 'pw')).rejects.toThrow(/too short/i);
  });

  it('rejects non-base64 ciphertext', async () => {
    await expect(decrypt('@@@not base64@@@', 'pw')).rejects.toThrow();
  });
});
