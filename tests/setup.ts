// jsdom in Node 20 exposes globalThis.crypto from node:crypto webcrypto, which
// includes subtle. If not present, polyfill from node:crypto.
import { webcrypto } from 'node:crypto';

if (!globalThis.crypto || !globalThis.crypto.subtle) {
  // @ts-expect-error — align Node's webcrypto with the DOM Crypto type
  globalThis.crypto = webcrypto;
}
