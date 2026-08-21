import tseslint from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';
import sveltePlugin from 'eslint-plugin-svelte';
import svelteParser from 'svelte-eslint-parser';

export default [
  {
    // supabase/functions is a Deno island - it uses Deno globals, URL/npm:/jsr:
    // imports, and its own deno.json/deno lint+fmt toolchain. The Node ESLint
    // config here would false-flag all of it; keep the two toolchains apart by
    // directory. See docs/dev/in-progress/venice-edge-functions/.
    ignores: [
      'dist/**',
      'node_modules/**',
      'playwright-report/**',
      'test-results/**',
      'supabase/functions/**',
      'supabase/.temp/**',
      'scripts/seed-backup-test.mjs',
      // Vite creates timestamped temp files during build and deletes
      // them after - when ESLint and Vite run in parallel (the gate
      // runs all tasks concurrently), ESLint can discover the file
      // and fail with ENOENT when it's already gone. Ignore the
      // pattern so the race is benign.
      'vite.config.ts.timestamp-*.mjs',
    ],
  },
  {
    files: ['**/*.ts', '**/*.mjs'],
    languageOptions: {
      parser: tsParser,
      parserOptions: { sourceType: 'module', ecmaVersion: 2022 },
    },
    plugins: { '@typescript-eslint': tseslint },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
    },
  },
  {
    files: ['**/*.svelte'],
    languageOptions: {
      parser: svelteParser,
      parserOptions: { parser: tsParser },
    },
    plugins: { svelte: sveltePlugin },
    rules: {
      ...sveltePlugin.configs.recommended.rules,
    },
  },
  {
    // Markdown.svelte renders model output with {@html} — the input is
    // already run through DOMPurify with an element/attribute allowlist
    // in renderMarkdown (see src/lib/markdown.ts), so the XSS warning is
    // a false positive here. Inline eslint-disable-next-line comments in
    // Svelte templates aren't honored by eslint-plugin-svelte, so this
    // file-level override is the cleanest way to silence it.
    files: ['src/components/Markdown.svelte'],
    rules: {
      'svelte/no-at-html-tags': 'off',
    },
  },
  {
    // Cookbook.svelte renders Cooklang-derived HTML with {@html}. The
    // HTML is produced by `cooklangToHtml` (src/lib/cooklang.ts) which
    // escapes every user-supplied string via its internal `esc()` helper
    // before wrapping in fixed tags — no user-supplied HTML or attribute
    // values reach the output. Same rationale as Markdown.svelte.
    files: ['src/screens/Cookbook.svelte'],
    rules: {
      'svelte/no-at-html-tags': 'off',
    },
  },
  {
    // logger.svelte.ts is the one place in the codebase that is
    // *expected* to call `console.*` directly - every other caller
    // routes through its `createLogger` / `log` surface. The module
    // mirrors every log-level call to the corresponding console
    // method so dev-tools filtering still works alongside the in-app
    // drawer.
    files: ['src/lib/logger.svelte.ts'],
    rules: {
      'no-console': 'off',
    },
  },
  {
    // scripts/*.mjs are CLI tools that use console.log for all
    // terminal output (progress, status, results). The no-console
    // rule is for app code that should route through the logger;
    // these scripts have no logger and stdout is their purpose.
    files: ['scripts/**/*.mjs'],
    rules: {
      'no-console': 'off',
    },
  },
];
