<script lang="ts">
  import { renderMarkdown } from '$lib/markdown';
  import { onLanguageLoaded } from '$lib/highlight';

  interface Props {
    content: string;
  }
  let { content }: Props = $props();

  // Bumped whenever a dynamically-imported highlight.js grammar finishes
  // registering. Reading it in the `$derived` below makes the render re-run
  // so a fence that rendered as plain text on the first pass gets real
  // token spans once the grammar is available.
  let langVersion = $state(0);

  $effect(() => {
    const unsub = onLanguageLoaded(() => {
      langVersion += 1;
    });
    return unsub;
  });

  // Re-render on every content change. The renderer is pure and fast enough
  // for streaming: re-parsing a 2KB buffer on each SSE delta is well under
  // a frame, and $derived caches between non-changing updates elsewhere.
  const html = $derived.by(() => {
    // Track `langVersion` so late-arriving grammars trigger a re-render.
    void langVersion;
    return renderMarkdown(content ?? '');
  });

  // Static icon markup for the code-fence "Copy" button. We can't emit
  // these inside renderMarkdown's output because DOMPurify's allowlist
  // excludes <svg>/<path>/<rect>/<polyline>; broadening the allowlist
  // would also let any model-emitted raw SVG through, so instead we
  // inject the icon client-side after each render. The strings are
  // static and author-controlled, so setting innerHTML from them is
  // safe.
  const COPY_ICON_SVG =
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" ' +
    'stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
    'stroke-linejoin="round" aria-hidden="true">' +
    '<rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>' +
    '<path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>' +
    '</svg>';
  const CHECK_ICON_SVG =
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" ' +
    'stroke="currentColor" stroke-width="2.5" stroke-linecap="round" ' +
    'stroke-linejoin="round" aria-hidden="true">' +
    '<polyline points="20 6 9 17 4 12"></polyline>' +
    '</svg>';

  let mdRoot: HTMLDivElement | undefined = $state();

  // After every {@html} commit, swap the renderer's plain "Copy" text
  // for the icon SVG. Skip buttons that are mid-flash (.copied) — the
  // click handler owns the icon for the duration of the timeout and
  // we'd otherwise stomp the checkmark with the copy glyph if the user
  // streams more text right after copying.
  $effect(() => {
    void html;
    if (!mdRoot) return;
    for (const btn of mdRoot.querySelectorAll('.copy-code-btn')) {
      if (!btn.classList.contains('copied')) {
        btn.innerHTML = COPY_ICON_SVG;
      }
    }
  });

  // Delegated click handler for the "Copy" buttons that live inside each
  // fenced code block. We can't use a Svelte component for those buttons
  // because the surrounding HTML comes from `{@html}` — Svelte doesn't
  // mount child components inside raw HTML, so a regular `<CopyButton>`
  // wouldn't get wired up. Instead the renderer emits a plain
  // `<button class="copy-code-btn">` inside a `<div class="code-block">`,
  // and we catch clicks here.
  //
  // The button starts with its label as its text content; on a successful
  // copy we swap the text to "Copied!" and toggle a `.copied` modifier
  // class for ~1.5s. Both are reset on the same timer; we stash the id
  // on the button itself so a rapid re-click on the same button restarts
  // the timer cleanly instead of leaving a prior timeout to revert mid-
  // second-flash.
  async function onClick(e: MouseEvent): Promise<void> {
    const target = e.target;
    if (!(target instanceof Element)) return;
    const btn = target.closest('.copy-code-btn');
    if (!(btn instanceof HTMLButtonElement)) return;
    // The <code> lives inside the sibling <pre> under the same wrapper.
    const code = btn.parentElement?.querySelector('pre code');
    if (!(code instanceof HTMLElement)) return;
    // textContent decodes HTML entities and strips the hljs highlight
    // spans — so what lands on the clipboard is the source the model
    // emitted, not the colorized HTML. The trailing "\n" the renderer
    // appends is preserved; that's the convention most editors expect.
    try {
      await navigator.clipboard.writeText(code.textContent ?? '');
    } catch {
      // Clipboard API unavailable (insecure context, permission
      // denied, or test env). Bail without feedback — the absence of
      // the "Copied!" flash itself signals something went wrong.
      return;
    }
    btn.innerHTML = CHECK_ICON_SVG;
    btn.classList.add('copied');
    const prior = btn.getAttribute('data-revert-timer');
    if (prior) window.clearTimeout(Number(prior));
    const id = window.setTimeout(() => {
      btn.innerHTML = COPY_ICON_SVG;
      btn.classList.remove('copied');
      btn.removeAttribute('data-revert-timer');
    }, 1500);
    btn.setAttribute('data-revert-timer', String(id));
  }
</script>

<!-- The click handler here is pure delegation: it only reacts to
     clicks on `<button class="copy-code-btn">` children, which are
     native buttons and therefore already keyboard-accessible via
     Enter/Space. The static wrapper itself is never the intended
     interactive surface. -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<!-- svelte-ignore a11y_click_events_have_key_events -->
<div class="md" bind:this={mdRoot} onclick={onClick}>
  <!-- Safe: `html` comes from renderMarkdown, which pipes through
       DOMPurify with an element/attribute allowlist (see
       src/lib/markdown.ts). The svelte/no-at-html-tags rule is
       switched off for this one file in eslint.config.js — inline
       eslint-disable-next-line comments in Svelte templates aren't
       honored by eslint-plugin-svelte, so a file-level override is
       the only way to silence it cleanly. -->
  {@html html}
</div>
