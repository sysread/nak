/**
 * Type declarations for the corpus generator so TypeScript consumers
 * (the vitest suite) can import the .mjs without implicit-any errors.
 * The implementation is plain Node ESM; these signatures mirror it.
 */

/** JSON.stringify + Unicode-escape of the `import` token (see impl). */
export function scannerSafeJsonStringify(value: string): string;

export interface BuildCorpusOptions {
  userRoot: string;
  devRoot: string;
}

export interface BuildCorpusResult {
  source: string;
  userCount: number;
  devCount: number;
  totalBytes: number;
}

/** Read the two doc trees and emit the corpus module source. Pure. */
export function buildCorpus(opts: BuildCorpusOptions): BuildCorpusResult;
