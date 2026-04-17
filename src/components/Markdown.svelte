<script lang="ts">
  import { renderMarkdown } from '$lib/markdown';

  interface Props {
    content: string;
  }
  let { content }: Props = $props();

  // Re-render on every content change. The renderer is pure and fast enough
  // for streaming: re-parsing a 2KB buffer on each SSE delta is well under
  // a frame, and $derived caches between non-changing updates elsewhere.
  const html = $derived(renderMarkdown(content ?? ''));
</script>

<div class="md">
  <!-- eslint-disable-next-line -->
  {@html html}
</div>
