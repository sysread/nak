/// <reference types="svelte" />
/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

// Inlined by Vite's `define` at build time — see `vite.config.ts`.
// Both values are literal strings after substitution; consumers read
// them through `src/lib/update.svelte.ts` (never directly) so the
// source of truth stays single-file.
declare const __APP_COMMIT__: string;
declare const __APP_BUILD_TIME__: string;

// snowball-stemmers ships untyped CommonJS. The package exposes a
// factory + an introspection helper; the journal spam filter uses
// only the english stemmer. Local declaration rather than pulling
// @types/snowball-stemmers because none exists on the registry.
declare module 'snowball-stemmers' {
  export interface SnowballStemmer {
    stem(word: string): string;
  }
  export function newStemmer(language: string): SnowballStemmer;
  export function algorithms(): string[];
}
