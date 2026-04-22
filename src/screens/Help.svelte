<script lang="ts">
  /*
   * Help modal. Renders the user-facing manual under `docs/user/` as a
   * mini in-app browser — internal `.md` links stay inside the modal
   * (like an iframe navigating in-place), external links fall through
   * to the browser's default "open in a new tab" behavior. `Scanner`
   * plays during each transition so the content swap reads as
   * intentional rather than as a flash of empty pane.
   *
   * Invariants:
   *   - Paths held in `currentPath` and `history` are always relative
   *     to `docs/user/` (the format `$lib/docs` accepts). Any href
   *     that resolves outside `docs/user/` is treated as a broken
   *     internal link and reported, never loaded.
   *   - DOMPurify already tags every anchor with `target="_blank"`;
   *     internal-link interception happens by preventDefault'ing the
   *     click before the new tab opens.
   *   - Mirrors Settings.svelte's modal chrome (backdrop click to
   *     dismiss, Escape key, role=dialog, top-right `×`). Styles are
   *     parallel rather than shared so Settings can evolve
   *     independently.
   */
  import Markdown from '../components/Markdown.svelte';
  import Scanner from '../components/Scanner.svelte';
  import { hasDoc, isExternalHref, loadDoc, resolveDocPath } from '$lib/docs';
  import { route, navigate } from '$lib/routing.svelte';

  interface Props {
    onClose: () => void;
  }
  let { onClose }: Props = $props();

  // Path of the doc currently rendered, mirrored into `route.doc` so
  // browser back / forward walks the in-modal navigation one doc at a
  // time and a refresh lands the reader on the same page. Absent URL
  // param means "opened Help, no deep link" - start on the index.
  const currentPath = $derived(route.doc ?? 'README.md');
  // Raw markdown for the current doc. Empty while we're still loading
  // the first time or between transitions.
  let content = $state('');
  // Distinguishes "waiting on the markdown source" from "rendered but
  // empty doc". The Scanner renders while this is true.
  let loading = $state(true);
  // Populated when a link resolves to nothing we can load. Shown
  // inline in place of the markdown body.
  let error = $state<string | null>(null);
  // Anchor we want to scroll to after the next render. Cleared by the
  // post-render effect once it's acted on the request.
  let pendingHash = $state('');

  // Wraps the <Markdown> render. Held via bind:this so the delegated
  // click handler and the heading-slugger can reach into the rendered
  // DOM without going through Svelte's component tree.
  let contentEl: HTMLElement | undefined = $state();

  // Load the current doc whenever `currentPath` changes. The
  // `cancelled` flag prevents a slower in-flight load from clobbering
  // a fresher one — rapid back-and-forth clicks can otherwise race.
  $effect(() => {
    const path = currentPath;
    loading = true;
    error = null;
    if (!hasDoc(path)) {
      // Shouldn't happen — resolveDocPath guards the entry points —
      // but if a stale link sneaks in we want a visible error rather
      // than an infinite Scanner.
      error = `Unknown page: ${path}`;
      content = '';
      loading = false;
      return;
    }
    let cancelled = false;
    loadDoc(path)
      .then((src) => {
        if (cancelled) return;
        content = src;
        loading = false;
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        error = e instanceof Error ? e.message : String(e);
        content = '';
        loading = false;
      });
    return () => {
      cancelled = true;
    };
  });

  // Post-render: assign ids to headings so `#anchor` links resolve,
  // demote unreachable anchors so a click can't trap the reader in an
  // error state, then scroll to `pendingHash` if the latest navigate
  // asked for it. Runs after `{@html}` commits because `contentEl`
  // only exists once Markdown has been rendered, and Svelte 5
  // schedules `$effect` after the DOM update.
  $effect(() => {
    void content;
    if (loading || !contentEl) return;
    const used = new Set<string>();
    for (const h of contentEl.querySelectorAll<HTMLElement>(
      '.md h1, .md h2, .md h3, .md h4, .md h5, .md h6',
    )) {
      if (h.id) {
        used.add(h.id);
        continue;
      }
      h.id = uniqueSlug(h.textContent ?? '', used);
    }
    // Demote anchors that can't render a working navigation in this
    // modal into plain <code> spans. Two failure modes converge here:
    //   1. DOMPurify stripped the href (bare-relative links that
    //      don't match ALLOWED_URI_REGEXP). The anchor still carries
    //      .md a styling but clicking it does nothing.
    //   2. Relative href that resolves outside `docs/user/` or names
    //      a doc we don't bundle (e.g. a `../dev/` cross-tree
    //      pointer). Clicking previously wiped content with an error
    //      banner and disabled the back button — the reader had no
    //      way out short of closing the modal.
    // Rendering those references as code is honest about the
    // constraint: it still surfaces the path in the prose, but
    // without pretending to be navigable.
    for (const a of contentEl.querySelectorAll<HTMLAnchorElement>('.md a')) {
      const href = a.getAttribute('href');
      if (href && (href.startsWith('#') || isExternalHref(href))) continue;
      if (href && resolveDocPath(currentPath, href)) continue;
      const code = document.createElement('code');
      code.innerHTML = a.innerHTML;
      a.replaceWith(code);
    }
    if (pendingHash) {
      const target = contentEl.querySelector<HTMLElement>(
        `#${CSS.escape(pendingHash)}`,
      );
      target?.scrollIntoView({ block: 'start' });
      // Clear so a later re-render (e.g. a late-arriving highlight.js
      // grammar) doesn't scroll us back to the hash after the user
      // has already scrolled away.
      pendingHash = '';
    } else {
      // Fresh doc without a hash: reset scroll so the top of the new
      // page is what the reader sees, regardless of where we were in
      // the previous doc.
      contentEl.scrollTo({ top: 0, left: 0 });
    }
  });

  // Slugify heading text the same way most markdown renderers do: lower-
  // case, collapse non-word runs to single dashes, strip leading/trailing
  // dashes. Empty output falls back to `section` so headings with only
  // punctuation still get a stable id.
  function slugify(text: string): string {
    return text
      .toLowerCase()
      .trim()
      .replace(/[^\w\s-]+/g, '')
      .replace(/[\s_-]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }

  function uniqueSlug(text: string, used: Set<string>): string {
    const base = slugify(text) || 'section';
    let slug = base;
    let n = 2;
    while (used.has(slug)) slug = `${base}-${n++}`;
    used.add(slug);
    return slug;
  }

  function navigateToDoc(path: string, hash: string): void {
    // Clicking a link to the page you're already on should just
    // re-scroll to the requested anchor (if any) - don't push a
    // duplicate onto the history stack.
    if (path === currentPath) {
      pendingHash = hash;
      // Force the post-render effect to re-run even though `content`
      // didn't change, so the scroll lands.
      const same = content;
      content = '';
      content = same;
      return;
    }
    pendingHash = hash;
    // Route through the global router - a new history entry means
    // browser-back walks one doc at a time across the whole app.
    // `doc: 'README.md'` is stored explicitly rather than as the
    // absent-means-README default, so "back to the index" creates its
    // own entry instead of collapsing onto the modal-open push.
    navigate({ doc: path });
  }

  // Delegated click handler for the rendered markdown. Runs on
  // .help-content, *outside* <Markdown>'s own click handler (which
  // lives on its inner .md div and only cares about copy-code
  // buttons) — so there's no dispatch conflict.
  //
  // Four cases, in order:
  //   1. Modifier-click (ctrl/cmd/shift/alt): let the browser do its
  //      thing (new tab, save link, etc.) even for internal docs.
  //   2. `#foo` (bare anchor): preventDefault and scroll manually.
  //      Letting the browser navigate would append the fragment to
  //      the page URL, which is noise.
  //   3. External (absolute URL / protocol-relative): no preventDefault.
  //      DOMPurify has already set `target="_blank" rel="...
  //      noreferrer"`, so the browser opens it in a new tab.
  //   4. Internal relative link: resolve and navigate within the
  //      modal.
  function onContentClick(e: MouseEvent): void {
    if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
    if (!(e.target instanceof Element)) return;
    const anchor = e.target.closest('a');
    if (!anchor) return;
    const href = anchor.getAttribute('href');
    if (!href) return;

    if (href.startsWith('#')) {
      e.preventDefault();
      const id = href.slice(1);
      if (!contentEl || !id) return;
      const target = contentEl.querySelector<HTMLElement>(`#${CSS.escape(id)}`);
      target?.scrollIntoView({ block: 'start' });
      return;
    }

    if (isExternalHref(href)) return;

    e.preventDefault();
    // Unreachable in practice — the post-render effect demotes
    // anchors that can't resolve into <code> spans, so the click
    // never fires on one. If a race ever slips through, a silent
    // no-op is preferable to trapping the reader in an error state.
    const resolved = resolveDocPath(currentPath, href);
    if (resolved) navigateToDoc(resolved.path, resolved.hash);
  }
</script>

<!-- Escape and click-outside both dismiss the modal. The outer
     `.center` doubles as the backdrop — we only close when the click
     target IS the backdrop itself, so clicks inside `.help-shell`
     (header buttons, links, code copy buttons) don't trigger a
     spurious close. Mirrors the Settings modal's affordance for
     muscle-memory consistency. -->
<svelte:window onkeydown={(e) => { if (e.key === 'Escape') onClose(); }} />

<!-- svelte-ignore a11y_no_static_element_interactions -->
<!-- svelte-ignore a11y_click_events_have_key_events -->
<div
  class="center help-backdrop"
  onclick={(e) => { if (e.target === e.currentTarget) onClose(); }}
>
  <div class="help-shell" role="dialog" aria-modal="true" aria-label="Help">
    <header class="help-header">
      <!-- No in-modal back button; the browser's Back is the single
           back affordance across the app now. Each doc-to-doc click
           pushes a history entry via the global router so
           browser-back walks them one at a time, and closing the
           modal (X / Escape / backdrop click) pops out of Help
           entirely. -->
      <h1 class="help-title" title={currentPath}>
        Help&nbsp;<span class="help-crumb">› {currentPath}</span>
      </h1>
      <button
        type="button"
        class="help-close"
        onclick={onClose}
        aria-label="Close help"
        title="Close"
      >×</button>
    </header>

    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <section
      class="help-content"
      bind:this={contentEl}
      onclick={onContentClick}
    >
      {#if loading}
        <div class="help-loading">
          <Scanner label="Loading help page" />
        </div>
      {:else if error}
        <p class="error">{error}</p>
      {:else}
        <Markdown {content} />
      {/if}
    </section>
  </div>
</div>
