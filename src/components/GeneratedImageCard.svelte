<!--
  Dedicated card for a generate_image tool's output, rendered as its own
  assistant bubble directly below the tool-call card that produced it
  (see Chat.svelte's `generated-image` message block). Owns resolving
  the image to an attachment and the loading placeholder shown until it
  resolves.

  Why this exists instead of the generic per-message attachment slot in
  AssistantBody: generate_image attaches its image to the round's
  assistant-with-tool-calls row SERVER-SIDE, after that row was already
  inserted and echoed over the messages realtime channel. The
  message_attachments insert fires no messages realtime event, so the
  producing tab's in-memory assistant row never re-hydrated with the
  attachment - the image only showed up after a full page reload. This
  card resolves the image itself by filename (findImageByFilenameInThread
  is thread-scoped and RLS-safe), bypassing the realtime nudge that never
  comes, then delegates the actual render to MessageAttachments so the
  preview / download-anchor / expired-chip treatment stays identical to
  every other attachment.

  The server attaches the image BEFORE it publishes the
  tool_call_response that makes this card appear, so the first lookup
  almost always finds it; the bounded retry below only covers the rare
  case where the card mounts before the attach commit has landed.
-->
<script lang="ts">
  import Scanner from './Scanner.svelte';
  import MessageAttachments from './MessageAttachments.svelte';
  import { app } from '$lib/state.svelte';
  import type { Attachment } from '$lib/supabase';

  interface Props {
    /** Thread the image was generated in; null while no thread is active. */
    threadId: string | null;
    /** Filename the orchestrator minted; the resolution key. */
    filename: string;
    /** CSS aspect-ratio for the placeholder box, e.g. "16 / 9". */
    aspectRatio: string;
  }

  const { threadId, filename, aspectRatio }: Props = $props();

  // Resolved once the attachment row exists in the DB. Null renders the
  // placeholder. An expired row (storage_path null) still resolves here
  // and MessageAttachments renders it as the expired chip - matching how
  // every other reclaimed attachment reads on an old thread.
  let attachment = $state<Attachment | null>(null);

  // Spaced retries for the in-session race only. The lookup runs once on
  // mount; these fire solely while the attachment isn't found yet, then
  // stop. A replayed thread resolves on the first attempt (the row is
  // already there) and never schedules a retry.
  const RETRY_DELAYS_MS = [750, 1500, 3000, 5000];

  $effect(() => {
    // Tracked deps: re-resolve if the card is reused for a different
    // image (filename is keyed on tool_call_id upstream, so in practice
    // this runs once per mount).
    const tid = threadId;
    const fname = filename;
    if (!tid || !fname || !app.supabase) {
      attachment = null;
      return;
    }
    const supabase = app.supabase;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;

    const resolve = async (): Promise<void> => {
      try {
        const att = await supabase.findImageByFilenameInThread(tid, fname);
        if (cancelled) return;
        if (att) {
          // Found - live or expired. MessageAttachments handles both
          // states, so stop retrying either way.
          attachment = att;
          return;
        }
      } catch {
        // Best-effort: a transient lookup failure falls through to a
        // retry. A persistent one leaves the placeholder, which is the
        // honest state - we never invent an image that isn't there.
      }
      if (cancelled) return;
      if (attempt < RETRY_DELAYS_MS.length) {
        const delay = RETRY_DELAYS_MS[attempt];
        attempt += 1;
        timer = setTimeout(() => {
          void resolve();
        }, delay);
      }
    };
    void resolve();

    return (): void => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  });
</script>

{#if attachment}
  <MessageAttachments attachments={[attachment]} />
{:else}
  <!-- Placeholder sized to the eventual image's aspect ratio so the
       card holds its space and doesn't reflow when the bytes land. The
       Scanner is the app-wide "working, no progress signal yet" pulse. -->
  <div class="generated-image-placeholder" style:aspect-ratio={aspectRatio}>
    <Scanner label="Loading generated image" />
  </div>
{/if}

<style>
  /* Matches MessageAttachments' live-image width (~85% of the card,
     capped at 100% on a narrow viewport) so the placeholder and the
     resolved preview occupy the same footprint. */
  .generated-image-placeholder {
    margin: 0.5rem 0 0;
    width: 85%;
    max-width: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: var(--radius);
    border: 1px solid var(--border);
    background: var(--bg-0);
  }
</style>
