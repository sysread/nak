/**
 * highlight.js-based syntax highlighting for fenced code blocks.
 *
 * We use the core build and explicitly register a curated set of common
 * languages eagerly — these ship in the main bundle so the first render of
 * any usual code block is instant. A second, broader set of grammars is
 * declared in `DYNAMIC_LOADERS`: each one is a `() => import(...)` of its
 * highlight.js module, so Vite emits them as separate on-demand chunks that
 * are only fetched the first time a fence with that language shows up.
 *
 * The render path stays synchronous — `highlight()` never awaits. When a
 * model streams back a ```ocaml fence, `renderer.code` in `markdown.ts`
 * asks `canLoad('ocaml')`, fires `ensureLanguage('ocaml')` as a side
 * effect, and falls back to unhighlighted escaped text for this pass.
 * When the import resolves, `onLanguageLoaded` subscribers are notified
 * and `<Markdown>` re-renders — this time `isSupported('ocaml')` returns
 * true and the fence gets real tokens.
 *
 * Adding a new language is one line in `DYNAMIC_LOADERS` (and optionally an
 * alias). Keep the static-import set small: those grammars pay their cost
 * on every first page load.
 */

import hljs from 'highlight.js/lib/core';
import type { LanguageFn } from 'highlight.js';

import bash from 'highlight.js/lib/languages/bash';
import c from 'highlight.js/lib/languages/c';
import cpp from 'highlight.js/lib/languages/cpp';
import css from 'highlight.js/lib/languages/css';
import diff from 'highlight.js/lib/languages/diff';
import dockerfile from 'highlight.js/lib/languages/dockerfile';
import go from 'highlight.js/lib/languages/go';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import kotlin from 'highlight.js/lib/languages/kotlin';
import lua from 'highlight.js/lib/languages/lua';
import markdown from 'highlight.js/lib/languages/markdown';
import nginx from 'highlight.js/lib/languages/nginx';
import perl from 'highlight.js/lib/languages/perl';
import php from 'highlight.js/lib/languages/php';
import plaintext from 'highlight.js/lib/languages/plaintext';
import protobuf from 'highlight.js/lib/languages/protobuf';
import python from 'highlight.js/lib/languages/python';
import ruby from 'highlight.js/lib/languages/ruby';
import rust from 'highlight.js/lib/languages/rust';
import shell from 'highlight.js/lib/languages/shell';
import sql from 'highlight.js/lib/languages/sql';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';

hljs.registerLanguage('bash', bash);
hljs.registerLanguage('c', c);
hljs.registerLanguage('cpp', cpp);
hljs.registerLanguage('css', css);
hljs.registerLanguage('diff', diff);
hljs.registerLanguage('dockerfile', dockerfile);
hljs.registerLanguage('go', go);
hljs.registerLanguage('java', java);
hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('json', json);
hljs.registerLanguage('kotlin', kotlin);
hljs.registerLanguage('lua', lua);
hljs.registerLanguage('markdown', markdown);
hljs.registerLanguage('nginx', nginx);
hljs.registerLanguage('perl', perl);
hljs.registerLanguage('php', php);
hljs.registerLanguage('plaintext', plaintext);
hljs.registerLanguage('protobuf', protobuf);
hljs.registerLanguage('python', python);
hljs.registerLanguage('ruby', ruby);
hljs.registerLanguage('rust', rust);
hljs.registerLanguage('shell', shell);
hljs.registerLanguage('sql', sql);
hljs.registerLanguage('typescript', typescript);
hljs.registerLanguage('xml', xml);
hljs.registerLanguage('yaml', yaml);

// Each entry is a canonical hljs language name → a static `() => import(...)`
// of its grammar module. The paths must be literal strings so Vite can code-
// split each one into its own chunk; glob patterns or variable paths would
// defeat that and pull every grammar into the main bundle.
const DYNAMIC_LOADERS: Record<string, () => Promise<{ default: LanguageFn }>> = {
  actionscript: () => import('highlight.js/lib/languages/actionscript'),
  ada: () => import('highlight.js/lib/languages/ada'),
  apache: () => import('highlight.js/lib/languages/apache'),
  arduino: () => import('highlight.js/lib/languages/arduino'),
  asciidoc: () => import('highlight.js/lib/languages/asciidoc'),
  awk: () => import('highlight.js/lib/languages/awk'),
  clojure: () => import('highlight.js/lib/languages/clojure'),
  cmake: () => import('highlight.js/lib/languages/cmake'),
  coffeescript: () => import('highlight.js/lib/languages/coffeescript'),
  crystal: () => import('highlight.js/lib/languages/crystal'),
  csharp: () => import('highlight.js/lib/languages/csharp'),
  dart: () => import('highlight.js/lib/languages/dart'),
  elixir: () => import('highlight.js/lib/languages/elixir'),
  elm: () => import('highlight.js/lib/languages/elm'),
  erlang: () => import('highlight.js/lib/languages/erlang'),
  fortran: () => import('highlight.js/lib/languages/fortran'),
  fsharp: () => import('highlight.js/lib/languages/fsharp'),
  gherkin: () => import('highlight.js/lib/languages/gherkin'),
  glsl: () => import('highlight.js/lib/languages/glsl'),
  gradle: () => import('highlight.js/lib/languages/gradle'),
  graphql: () => import('highlight.js/lib/languages/graphql'),
  groovy: () => import('highlight.js/lib/languages/groovy'),
  handlebars: () => import('highlight.js/lib/languages/handlebars'),
  haskell: () => import('highlight.js/lib/languages/haskell'),
  haxe: () => import('highlight.js/lib/languages/haxe'),
  http: () => import('highlight.js/lib/languages/http'),
  ini: () => import('highlight.js/lib/languages/ini'),
  julia: () => import('highlight.js/lib/languages/julia'),
  latex: () => import('highlight.js/lib/languages/latex'),
  less: () => import('highlight.js/lib/languages/less'),
  lisp: () => import('highlight.js/lib/languages/lisp'),
  livescript: () => import('highlight.js/lib/languages/livescript'),
  makefile: () => import('highlight.js/lib/languages/makefile'),
  matlab: () => import('highlight.js/lib/languages/matlab'),
  nim: () => import('highlight.js/lib/languages/nim'),
  nix: () => import('highlight.js/lib/languages/nix'),
  objectivec: () => import('highlight.js/lib/languages/objectivec'),
  ocaml: () => import('highlight.js/lib/languages/ocaml'),
  powershell: () => import('highlight.js/lib/languages/powershell'),
  prolog: () => import('highlight.js/lib/languages/prolog'),
  properties: () => import('highlight.js/lib/languages/properties'),
  puppet: () => import('highlight.js/lib/languages/puppet'),
  r: () => import('highlight.js/lib/languages/r'),
  reasonml: () => import('highlight.js/lib/languages/reasonml'),
  scala: () => import('highlight.js/lib/languages/scala'),
  scheme: () => import('highlight.js/lib/languages/scheme'),
  scss: () => import('highlight.js/lib/languages/scss'),
  smalltalk: () => import('highlight.js/lib/languages/smalltalk'),
  stylus: () => import('highlight.js/lib/languages/stylus'),
  swift: () => import('highlight.js/lib/languages/swift'),
  tcl: () => import('highlight.js/lib/languages/tcl'),
  twig: () => import('highlight.js/lib/languages/twig'),
  vbnet: () => import('highlight.js/lib/languages/vbnet'),
  verilog: () => import('highlight.js/lib/languages/verilog'),
  vhdl: () => import('highlight.js/lib/languages/vhdl'),
  wasm: () => import('highlight.js/lib/languages/wasm'),
};

const ALIASES: Record<string, string> = {
  js: 'javascript',
  ts: 'typescript',
  jsx: 'javascript',
  tsx: 'typescript',
  py: 'python',
  rb: 'ruby',
  sh: 'bash',
  zsh: 'bash',
  'shell-session': 'shell',
  yml: 'yaml',
  docker: 'dockerfile',
  rs: 'rust',
  'c++': 'cpp',
  html: 'xml',
  svg: 'xml',
  md: 'markdown',
  text: 'plaintext',
  txt: 'plaintext',
  // Aliases for dynamically-loaded languages. `normalizeLang` runs before
  // `DYNAMIC_LOADERS` is consulted, so an alias like `hs` transparently
  // resolves to the canonical `haskell` loader.
  adoc: 'asciidoc',
  'c#': 'csharp',
  clj: 'clojure',
  cljs: 'clojure',
  coffee: 'coffeescript',
  cs: 'csharp',
  ex: 'elixir',
  exs: 'elixir',
  erl: 'erlang',
  fs: 'fsharp',
  gql: 'graphql',
  hbs: 'handlebars',
  hs: 'haskell',
  jl: 'julia',
  kt: 'kotlin',
  ml: 'ocaml',
  mli: 'ocaml',
  'objective-c': 'objectivec',
  objc: 'objectivec',
  ps: 'powershell',
  ps1: 'powershell',
  scm: 'scheme',
  tex: 'latex',
  vb: 'vbnet',
};

export function normalizeLang(lang: string | null | undefined): string {
  if (!lang) return '';
  const key = lang.trim().toLowerCase();
  return ALIASES[key] ?? key;
}

export function isSupported(lang: string): boolean {
  const normalized = normalizeLang(lang);
  return Boolean(normalized && hljs.getLanguage(normalized));
}

/**
 * `true` when `lang` isn't registered yet but has a dynamic loader we can
 * fetch on demand. Used by the markdown renderer to decide whether to kick
 * off a lazy import — falling back to escaped plaintext for this render and
 * re-rendering once the grammar arrives.
 */
export function canLoad(lang: string): boolean {
  const normalized = normalizeLang(lang);
  if (!normalized) return false;
  if (hljs.getLanguage(normalized)) return false;
  return normalized in DYNAMIC_LOADERS;
}

// Dedupe: many streaming deltas can hit the same fence in quick succession,
// and we only want one network fetch per language. Keeping the promise lets
// subsequent callers await the same resolution.
const pending = new Map<string, Promise<boolean>>();

const listeners = new Set<() => void>();

/**
 * Ensure a language grammar is registered, fetching it lazily if necessary.
 * Resolves to `true` once the grammar is available (either already loaded or
 * freshly imported), `false` if the language isn't known to us.
 *
 * Safe to call repeatedly: concurrent calls for the same language share one
 * import.
 */
export function ensureLanguage(lang: string): Promise<boolean> {
  const normalized = normalizeLang(lang);
  if (!normalized) return Promise.resolve(false);
  if (hljs.getLanguage(normalized)) return Promise.resolve(true);
  const loader = DYNAMIC_LOADERS[normalized];
  if (!loader) return Promise.resolve(false);
  const existing = pending.get(normalized);
  if (existing) return existing;
  const p = loader().then(
    (mod) => {
      // Re-check under the lock: another caller may have registered between
      // our `getLanguage` check and `import()` resolving.
      if (!hljs.getLanguage(normalized)) {
        hljs.registerLanguage(normalized, mod.default);
      }
      for (const cb of listeners) cb();
      return true;
    },
    () => {
      // Import failure is usually a missing module or a transient network
      // blip — drop the pending entry so a later retry gets a fresh chance.
      pending.delete(normalized);
      return false;
    },
  );
  pending.set(normalized, p);
  return p;
}

/**
 * Register a callback invoked every time a dynamic language finishes
 * loading. Returns an unsubscribe function. The callback fires once per
 * language load — consumers typically bump a version counter and let their
 * render function re-run.
 */
export function onLanguageLoaded(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/**
 * Highlight `code` for `lang`. Returns an HTML string with highlight.js
 * `<span class="hljs-*">` tokens. Unknown languages fall back to the
 * HTML-escaped code.
 *
 * @public
 *   Called via the dynamic-import path in markdown.ts (`hl.highlight`
 *   on a `await import('./highlight')` result). Knip can't trace
 *   that runtime module reference, so the @public tag tells it the
 *   export is intentional.
 */
export function highlight(code: string, lang: string): string {
  const normalized = normalizeLang(lang);
  if (!normalized || !hljs.getLanguage(normalized)) return escapeHtml(code);
  try {
    return hljs.highlight(code, { language: normalized, ignoreIllegals: true }).value;
  } catch {
    return escapeHtml(code);
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
