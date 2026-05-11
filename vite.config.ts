// vitest/config's defineConfig merges Vite's UserConfig with the
// `test` block Vitest consumes. Importing from 'vite' was fine
// before `worker:` was added below, but the extra top-level key
// flipped TypeScript's overload resolution onto a stricter path
// that rejected `test` as unknown. This import gives us a single
// type that knows about both surfaces.
import { defineConfig, type Plugin } from 'vitest/config';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { VitePWA } from 'vite-plugin-pwa';
import { visualizer } from 'rollup-plugin-visualizer';
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
  // Vite 5 does NOT apply the top-level `plugins` array to worker
  // bundles. Each Web Worker (embeddings / reflection / summary /
  // attachment-expiry / samskara) transitively imports
  // src/lib/logger.svelte.ts, which declares its reactive buffer at
  // module scope via `$state(...)`. Without the Svelte plugin in
  // the worker build, that rune reaches the browser as a bare
  // identifier and every worker crashes at load with "Uncaught
  // ReferenceError: $state is not defined" - silently for four of
  // them (reflection / summary / embedding / attachment-expiry emit
  // no main-thread progress heartbeat when dead) and loudly for
  // samskara once its manager started routing progress messages.
  // The factory form (`() => [svelte()]`) is required so the worker
  // bundle gets its own plugin instance rather than sharing state
  // with the main bundle. See
  // https://vite.dev/guide/features.html#web-workers
  worker: {
    plugins: () => [svelte()],
    // ES-module workers (rather than Vite's default IIFE) so worker
    // bundles can use `import('./...')` for code-splitting. Several
    // tool/toolbox modules under src/lib/tools/ live in worker
    // bundles (the reflection worker pulls memoryToolbox; recall /
    // conversation-recall agents pull their toolboxes), and those
    // toolbox files now use a `lazyTool` wrapper that dynamic-imports
    // the impl on first dispatch. IIFE workers can't host code-
    // splitting and the build fails with "UMD and IIFE output
    // formats are not supported for code-splitting builds." All
    // browsers nak targets (PWA on modern Chrome / Safari / Firefox
    // / Edge) ship Module Workers.
    format: 'es',
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
    // Bundle visualizer for chunking work. Set NAK_BUNDLE_STATS=1 to
    // emit dist/stats.html alongside the build. Off by default so a
    // routine `pnpm build` doesn't churn an extra artifact. Cast
    // because rollup-plugin-visualizer's Plugin type targets a
    // newer Rollup than Vite 5 vendors.
    ...(process.env.NAK_BUNDLE_STATS
      ? [
          visualizer({
            filename: 'dist/stats.html',
            template: 'treemap',
            gzipSize: true,
            brotliSize: true,
          }) as unknown as Plugin,
        ]
      : []),
  ],
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/**/*.test.ts'],
    // Integration tests hit live external services (Venice) and are
    // gated on a real API key in the env. The default `pnpm test`
    // stays hermetic - CI never depends on outbound network or a
    // keyed credential. The integration suite opts itself in when
    // the developer wires an API key into the shell:
    //   VENICE_INFERENCE_KEY=<key> pnpm test tests/web-search.integration.test.ts
    // Gating via the env var means the developer doesn't need to
    // remember a separate command flag - presence of the key IS the
    // opt-in.
    exclude: process.env.VENICE_INFERENCE_KEY
      ? ['node_modules/**']
      : ['node_modules/**', 'tests/**/*.integration.test.ts'],
  },
});
