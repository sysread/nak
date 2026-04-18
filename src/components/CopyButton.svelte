<!--
  Tiny copy-to-clipboard button.

  Used for message-level copy on assistant bubbles and anywhere else a
  Svelte-side text value needs a one-click "put this on the clipboard"
  control. Code-fence copies go through a parallel DOM-delegation path
  in Markdown.svelte — see the comment there for why they can't share
  this component directly.

  Feedback: button label flips to "Copied!" and the button picks up a
  .copied modifier for ~1.5s. Failures (permission denied, insecure
  context) are swallowed silently — there's no useful recovery and the
  absence of the "Copied!" flash is itself a signal something went
  wrong.
-->
<script lang="ts">
  interface Props {
    text: string;
    label?: string;
    ariaLabel?: string;
  }
  let { text, label = 'Copy', ariaLabel }: Props = $props();

  let copied = $state(false);
  let timer: ReturnType<typeof setTimeout> | null = null;

  async function onClick(): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Clipboard API unavailable (insecure context, permission denied,
      // or test environment). Bail without feedback — the absence of
      // the "Copied!" flash is itself a signal something went wrong.
      return;
    }
    copied = true;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      copied = false;
      timer = null;
    }, 1500);
  }
</script>

<!-- Icon-only surface. The accessible name comes from aria-label, which
     flips to "Copied" on success so screen readers announce the state
     change; the visual swap from the two-pages glyph to a checkmark is
     the sighted equivalent. `title` mirrors the label so a hover
     tooltip still surfaces the action — important now that there's no
     text affordance. -->
<button
  type="button"
  class="copy-btn"
  class:copied
  onclick={onClick}
  aria-label={copied ? 'Copied' : (ariaLabel ?? label)}
  title={copied ? 'Copied' : (ariaLabel ?? label)}
>
  {#if copied}
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
         stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"
         aria-hidden="true">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  {:else}
    <!-- The classic "two overlapping pages" copy glyph: foreground sheet
         (the rect) sitting on top of a background sheet (the path). -->
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
         stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
         aria-hidden="true">
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  {/if}
</button>
