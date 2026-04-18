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

<button
  type="button"
  class="copy-btn"
  class:copied
  onclick={onClick}
  aria-label={copied ? 'Copied' : (ariaLabel ?? label)}
>
  {copied ? 'Copied!' : label}
</button>
