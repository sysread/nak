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

// Svelte's slide / fade transitions call Element.animate, which jsdom
// doesn't implement. Without this shim, any component test that
// mounts a `transition:slide` block explodes with
// "element.animate is not a function". We only need the return value
// to have a `cancel()` method so Svelte's lifecycle can clean up —
// the animation itself is a no-op in tests, which is fine because
// we're asserting on state (aria-expanded, DOM presence), not the
// in-flight interpolated styles.
if (typeof Element !== 'undefined' && !Element.prototype.animate) {
  Element.prototype.animate = function () {
    return {
      cancel() {},
      finish() {},
      addEventListener() {},
      removeEventListener() {},
    } as unknown as Animation;
  };
}
