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
      // $shared is the boundary the browser and the Deno edge function
      // share. Only modules that are framework-agnostic and Deno-
      // portable belong under here - pure types, parsers, and Web-APIs-
      // only helpers - so the same source file compiles cleanly in
      // both runtimes. Streaming-root added the alias for venice-
      // stream.ts; do not point this at anything that needs the
      // Supabase client, EdgeRuntime, or Deno.env without splitting it
      // first.
      $shared: path.resolve('./supabase/functions/_shared'),
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
  build: {
    rollupOptions: {
      output: {
        // Route long-tail lazy chunks into named subdirectories so
        // the service worker's precache (`injectManifest.globPatterns`
        // below) can exclude them by path. Without this every
        // language grammar, doc page, and rarely-opened screen lands
        // in the PWA install download - which on mobile/metered data
        // is felt - even though most users will never trigger most of
        // them. The runtime-cache handler in src/sw.ts picks them up
        // on first fetch, so an offline session that previously
        // touched a feature still works.
        //
        // The buckets:
        //   assets/hljs/    - highlight.js per-language grammars,
        //                     loaded on first fenced code block of
        //                     that language.
        //   assets/docs/    - the bundled Help corpus
        //                     (docs/user/**/*.md raw-string chunks),
        //                     loaded when the Help modal navigates
        //                     to that page OR when `research_docs`
        //                     fires.
        //   assets/screens/ - Settings / Journal / Samskara / Memories
        //                     / Intuition / drawers. Each is the modal
        //                     or panel a specific UI flip opens; cold
        //                     installs don't need any of them on disk
        //                     yet. Cookbook and Wiki are deliberately
        //                     NOT here - they render the offline cache's
        //                     saved recipes/articles, so they must be in
        //                     the precache (see the chunkFileNames
        //                     exception below), or an offline open right
        //                     after a deploy fails to fetch the new,
        //                     never-runtime-cached screen chunk.
        //
        // Anything not matched falls through to the default
        // `assets/[name]-[hash].js` and stays precached - that
        // includes the main entry, the marked/dompurify stack on the
        // assistant-message hot path, the katex/highlight cores
        // (which sit behind the markdown renderer), and the small
        // utility chunks the chat-loop reaches for on every turn.
        chunkFileNames(chunkInfo) {
          // Match on `facadeModuleId` (the single module that
          // triggered the chunk's creation via a dynamic import)
          // rather than `moduleIds` (every module IN the chunk).
          // Rollup may pack the highlight.js core + statically-
          // imported languages into one chunk; testing moduleIds
          // would sweep that chunk into `hljs/` too, removing the
          // highlight engine from the precache and forcing a fetch
          // on the first code block. The facade check keeps the
          // chunk-into-folder mapping pinned to "this chunk exists
          // because of one dynamic-import call site," which is what
          // the runtime cache fallback was designed for.
          const facade = chunkInfo.facadeModuleId || '';
          if (/\/highlight\.js\/.*\/languages\//.test(facade)) {
            return 'assets/hljs/[name]-[hash].js';
          }
          if (/\/docs\/(user|dev)\/.*\.md/.test(facade)) {
            return 'assets/docs/[name]-[hash].js';
          }
          // Cookbook and Wiki are the panels that display the offline
          // cache (favorited recipes / articles), so they MUST work with
          // no network. Keep them in the precached default bucket, not
          // the runtime-cached screens bucket: a deploy changes every
          // chunk hash, and the runtime cache only holds the PREVIOUS
          // build's hash, so opening a saved recipe offline right after
          // an update fails with "Failed to fetch dynamically imported
          // module" until the new chunk is fetched online once. Precache
          // installs the new chunk up front (while the SW is installing,
          // online), so the offline open always resolves.
          if (/\/src\/screens\/(Cookbook|Wiki)\.svelte$/.test(facade)) {
            return 'assets/[name]-[hash].js';
          }
          if (/\/src\/screens\/.*\.svelte$/.test(facade)) {
            return 'assets/screens/[name]-[hash].js';
          }
          return 'assets/[name]-[hash].js';
        },
      },
    },
    // Bump the chunk-size advisory from Rollup's 500 kB default to
    // 750 kB. Modern PWAs on persistent caches comfortably handle
    // chunks in this range; the 500 kB ceiling is from a much older
    // browser-cache era. Bundle-shape investigations should still
    // grep the build output for `(!)` warnings - this just stops the
    // routine `pnpm build` from emitting the chunk-size advisory
    // every time on the main index chunk.
    chunkSizeWarningLimit: 750,
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
        // Precache the app shell - main entry, the markdown/render
        // stack the assistant message hot path uses, fonts, icons,
        // CSS, the manifest, and worker bundles. The long-tail lazy
        // chunks (hljs grammars, doc-page chunks, lazy screens) are
        // bucketed into named subdirectories by `chunkFileNames`
        // above and excluded here; the SW's runtime fetch handler
        // (src/sw.ts) caches those on first request via a
        // stale-while-revalidate strategy. Net: cold PWA install
        // downloads ~1 MB less while a previously-opened feature
        // remains offline-functional via the runtime cache.
        globPatterns: ['**/*.{js,css,html,svg,png,ico,woff2}'],
        globIgnores: [
          'assets/hljs/**',
          'assets/docs/**',
          'assets/screens/**',
        ],
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
    // Default to `node` - most test files are pure logic with no DOM
    // dependency. Only the files listed in `environmentMatchGlobs`
    // below get jsdom (component mounts, localStorage/sessionStorage,
    // history API, DOMPurify, fake-indexeddb). Defaulting to node
    // avoids ~350ms of jsdom bootstrap per file across the worker
    // pool - 126 files x 350ms = ~44s of aggregate environment time
    // that was burning 4-5s of wall clock on every run.
    environment: 'node',
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/**/*.test.ts'],
    // These are the files that need jsdom. New test files default to
    // node; if they reference DOM globals they fail immediately with
    // `ReferenceError: document is not defined`, which is the signal
    // to add the file here. The list was found by running the full
    // suite with `--environment node` and collecting failures.
    environmentMatchGlobs: [
      ['tests/ascii-spinner.test.ts', 'jsdom'],
      ['tests/click-outside.test.ts', 'jsdom'],
      ['tests/collapse-click.test.ts', 'jsdom'],
      ['tests/config.test.ts', 'jsdom'],
      ['tests/context-ring.test.ts', 'jsdom'],
      ['tests/holder-id.test.ts', 'jsdom'],
      ['tests/markdown.test.ts', 'jsdom'],
      ['tests/reasoning-picker.test.ts', 'jsdom'],
      ['tests/routing.test.ts', 'jsdom'],
      ['tests/session.test.ts', 'jsdom'],
      ['tests/sleep-spinner.test.ts', 'jsdom'],
      ['tests/theme.test.ts', 'jsdom'],
      ['tests/verbosity-picker.test.ts', 'jsdom'],
    ],
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
