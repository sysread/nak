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
</script>

<div class="md">
  <!-- eslint-disable-next-line -->
  {@html html}
</div>
