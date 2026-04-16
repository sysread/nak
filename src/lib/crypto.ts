/**
 * Password-based authenticated encryption using Web Crypto.
 * AES-256-GCM with a PBKDF2(SHA-256) derived key.
 *
 * Ciphertext format (base64-encoded):
 *   [ 4 bytes version ][ 16 bytes salt ][ 12 bytes iv ][ ciphertext+tag ]
 *
 * Version is a u32 big-endian integer so the format can evolve.
 */

const VERSION = 1;
const SALT_BYTES = 16;
const IV_BYTES = 12;
// NIST / OWASP 2023+ guidance for PBKDF2-SHA256 is >= 600,000 iterations.
const PBKDF2_ITERATIONS = 600_000;
const KEY_BITS = 256;

function assertCrypto(): Crypto {
  const c = globalThis.crypto;
  if (!c || !c.subtle) {
    throw new Error('Web Crypto API is not available in this environment.');
  }
  return c;
}

function toBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function writeUint32BE(view: DataView, offset: number, value: number): void {
  view.setUint32(offset, value, false);
}

function readUint32BE(view: DataView, offset: number): number {
  return view.getUint32(offset, false);
}

async function deriveKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const subtle = assertCrypto().subtle;
  const material = await subtle.importKey(
    'raw',
    new TextEncoder().encode(password) as BufferSource,
    { name: 'PBKDF2' },
    false,
    ['deriveKey']
  );
  return subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: salt as BufferSource,
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256',
    },
    material,
    { name: 'AES-GCM', length: KEY_BITS },
    false,
    ['encrypt', 'decrypt']
  );
}

export async function encrypt(data: string, password: string): Promise<string> {
  if (typeof data !== 'string') throw new TypeError('data must be a string');
  if (typeof password !== 'string' || password.length === 0) {
    throw new TypeError('password must be a non-empty string');
  }
  const c = assertCrypto();
  const salt = c.getRandomValues(new Uint8Array(SALT_BYTES));
  const iv = c.getRandomValues(new Uint8Array(IV_BYTES));
  const key = await deriveKey(password, salt);
  const ciphertext = new Uint8Array(
    await c.subtle.encrypt(
      { name: 'AES-GCM', iv: iv as BufferSource },
      key,
      new TextEncoder().encode(data) as BufferSource
    )
  );

  const out = new Uint8Array(4 + SALT_BYTES + IV_BYTES + ciphertext.byteLength);
  const view = new DataView(out.buffer);
  writeUint32BE(view, 0, VERSION);
  out.set(salt, 4);
  out.set(iv, 4 + SALT_BYTES);
  out.set(ciphertext, 4 + SALT_BYTES + IV_BYTES);
  return toBase64(out);
}

/**
 * Decrypts a ciphertext produced by `encrypt`. Returns the plaintext string
 * on success. If the password is wrong, the format is invalid, or the data
 * is tampered, throws an Error with a generic message (not the underlying
 * DOMException, which is opaque across browsers).
 */
export async function decrypt(ciphertext: string, password: string): Promise<string> {
  if (typeof ciphertext !== 'string' || ciphertext.length === 0) {
    throw new TypeError('ciphertext must be a non-empty string');
  }
  if (typeof password !== 'string' || password.length === 0) {
    throw new TypeError('password must be a non-empty string');
  }

  let raw: Uint8Array;
  try {
    raw = fromBase64(ciphertext);
  } catch {
    throw new Error('Ciphertext is not valid base64.');
  }

  if (raw.byteLength < 4 + SALT_BYTES + IV_BYTES + 16) {
    throw new Error('Ciphertext is too short to be valid.');
  }

  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const version = readUint32BE(view, 0);
  if (version !== VERSION) {
    throw new Error(`Unsupported ciphertext version: ${version}`);
  }
  const salt = raw.slice(4, 4 + SALT_BYTES);
  const iv = raw.slice(4 + SALT_BYTES, 4 + SALT_BYTES + IV_BYTES);
  const body = raw.slice(4 + SALT_BYTES + IV_BYTES);

  const key = await deriveKey(password, salt);
  try {
    const plain = await assertCrypto().subtle.decrypt(
      { name: 'AES-GCM', iv: iv as BufferSource },
      key,
      body as BufferSource
    );
    return new TextDecoder().decode(plain);
  } catch {
    // AES-GCM tag mismatch (wrong password / tampered data) surfaces as an
    // opaque OperationError DOMException. Normalize it.
    throw new Error('Decryption failed: wrong password or corrupted data.');
  }
}

export const __test = {
  VERSION,
  SALT_BYTES,
  IV_BYTES,
  PBKDF2_ITERATIONS,
};
