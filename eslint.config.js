import tseslint from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';
import sveltePlugin from 'eslint-plugin-svelte';
import svelteParser from 'svelte-eslint-parser';

export default [
  {
    ignores: ['dist/**', 'node_modules/**', 'playwright-report/**', 'test-results/**'],
  },
  {
    files: ['**/*.ts'],
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
];
