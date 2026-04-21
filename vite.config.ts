import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { VitePWA } from 'vite-plugin-pwa';
import path from 'node:path';
import { execSync } from 'node:child_process';

// When deployed to GitHub Pages at https://<user>.github.io/<repo>/
// the VITE_BASE env var lets forks override. Default keeps relative paths.
const base = process.env.VITE_BASE ?? './';

// Build fingerprint. CI sets GITHUB_SHA on every workflow run; local builds
// fall back to `git rev-parse` so `pnpm preview` has a meaningful value too.
// The final fallback is the literal string 'dev' — which is what the running
// `pnpm dev` server sees, since HMR doesn't re-run this block per file edit.
// These values are inlined via `define` below and surface in Settings → About
// so the user can tell at a glance which build their browser has cached.
function readCommit(): string {
  const envSha = process.env.GITHUB_SHA;
  if (envSha) return envSha.slice(0, 7);
  try {
    return execSync('git rev-parse --short=7 HEAD', {
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim();
  } catch {
    // No git, shallow checkout without refs, or first boot of a fresh
    // clone — none of these should fail the build.
    return 'dev';
  }
}
const commit = readCommit();
const buildTime = new Date().toISOString();

export default defineConfig({
  base,
  define: {
    __APP_COMMIT__: JSON.stringify(commit),
    __APP_BUILD_TIME__: JSON.stringify(buildTime),
  },
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
      // injectManifest (vs generateSW) so we can ship a hand-written
      // service worker — needed for the Web Share Target POST handler
      // at `/share`, which can't be expressed as a workbox runtime
      // rule. The SW lives at src/sw.ts; vite-plugin-pwa compiles it
      // and substitutes `self.__WB_MANIFEST` with the precache list
      // built from `injectManifest.globPatterns` below.
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      // `prompt` mode parks a fresh SW in 'waiting' until the client
      // explicitly posts SKIP_WAITING. We register manually from
      // `src/lib/update.svelte.ts` so `onNeedRefresh` can flip a
      // reactive flag that UpdateBanner renders — auto-update would
      // reload silently and defeat the whole "tell me when a new build
      // landed" point of the banner.
      registerType: 'prompt',
      injectRegister: false,
      manifest: {
        name: 'Nak',
        short_name: 'Nak',
        description: 'Nak — a bring-your-own-infrastructure AI chat using Venice.ai and Supabase.',
        theme_color: '#0b0d10',
        background_color: '#0b0d10',
        display: 'standalone',
        start_url: '.',
        // Single SVG icon covers every size — declaring `sizes: 'any'`
        // tells the UA it's resolution-independent, and `purpose: 'any
        // maskable'` lets Android crop it for adaptive icons without us
        // shipping a second raster copy. The file lives in public/ so
        // Vite copies it verbatim to the build root.
        icons: [
          {
            src: 'icon.svg',
            sizes: 'any',
            type: 'image/svg+xml',
            purpose: 'any maskable',
          },
        ],
        // Web Share Target: once the PWA is installed, the OS share
        // sheet can pick Nak as a destination and POST the shared
        // payload here. The `action` URL is relative to the manifest
        // location so deploys under a subpath (GitHub Pages at
        // `/<repo>/`) still resolve correctly — the effective URL
        // becomes `<scope>share`. Method must be POST + multipart
        // form data to carry file attachments; the SW at src/sw.ts
        // intercepts the request, stashes the payload in IndexedDB,
        // and redirects back to the app root with a query marker so
        // the app knows to consume it. Android/Chromium implements
        // this fully; iOS/Safari support is URL/text-only and only
        // on recent versions, so file entries are best-effort.
        share_target: {
          action: 'share',
          method: 'POST',
          enctype: 'multipart/form-data',
          params: {
            title: 'title',
            text: 'text',
            url: 'url',
            files: [
              {
                name: 'files',
                // Broad accept list — we describe whatever lands in
                // the composer rather than rejecting at the OS layer.
                accept: ['*/*'],
              },
            ],
          },
        },
      },
      injectManifest: {
        globPatterns: ['**/*.{js,css,html,svg,png,ico,woff2}'],
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
