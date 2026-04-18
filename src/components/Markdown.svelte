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
    btn.textContent = 'Copied!';
    btn.classList.add('copied');
    const prior = btn.getAttribute('data-revert-timer');
    if (prior) window.clearTimeout(Number(prior));
    const id = window.setTimeout(() => {
      btn.textContent = 'Copy';
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
<div class="md" onclick={onClick}>
  <!-- eslint-disable-next-line -->
  {@html html}
</div>
