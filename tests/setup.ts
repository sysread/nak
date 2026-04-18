// jsdom in Node 20 exposes globalThis.crypto from node:crypto webcrypto, which
// includes subtle. If not present, polyfill from node:crypto.
import { webcrypto } from 'node:crypto';
// `@testing-library/jest-dom/vitest` registers the matcher set into
// vitest's expect at import time. Loaded here (rather than per test
// file) so any component test can `expect(el).toBeInTheDocument()`
// without a local import.
import '@testing-library/jest-dom/vitest';

if (!globalThis.crypto || !globalThis.crypto.subtle) {
  // @ts-expect-error — align Node's webcrypto with the DOM Crypto type
  globalThis.crypto = webcrypto;
}
