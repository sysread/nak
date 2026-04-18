import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { VitePWA } from 'vite-plugin-pwa';
import path from 'node:path';

// When deployed to GitHub Pages at https://<user>.github.io/<repo>/
// the VITE_BASE env var lets forks override. Default keeps relative paths.
const base = process.env.VITE_BASE ?? './';

export default defineConfig({
  base,
  resolve: {
    alias: {
      $lib: path.resolve('./src/lib'),
    },
    // Svelte 5 ships separate server/client entry points. Under vitest
    // we want the client runtime (jsdom + @testing-library/svelte can
    // only mount via the browser build); the `node` condition vitest
    // defaults to picks the server entry, which throws
    // `lifecycle_function_unavailable` on mount. Narrow to `browser`
    // during tests only so `pnpm build` / `pnpm dev` stay unaffected.
    conditions: process.env.VITEST ? ['browser'] : [],
  },
  plugins: [
    svelte(),
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: 'auto',
      manifest: {
        name: 'Nak',
        short_name: 'Nak',
        description: 'Nak — a bring-your-own-infrastructure AI chat using Venice.ai and Supabase.',
        theme_color: '#0b0d10',
        background_color: '#0b0d10',
        display: 'standalone',
        start_url: '.',
        icons: [
          {
            src: 'icon-192.png',
            sizes: '192x192',
            type: 'image/png',
          },
          {
            src: 'icon-512.png',
            sizes: '512x512',
            type: 'image/png',
          },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,ico,woff2}'],
        // Never cache API requests to user-provided endpoints.
        navigateFallbackDenylist: [/^\/api/],
      },
    }),
  ],
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/**/*.test.ts'],
  },
});
