/**
 * UI-behavior primitives for the per-message attachment list. The
 * MessageAttachments component renders two visually distinct groups -
 * large inline image previews and compact file chips - and the choice
 * of which attachment goes where is domain logic (it depends on MIME
 * type and live-vs-expired state), not framework wiring, so it lives
 * here rather than inline in the .svelte file.
 *
 * Used for both user uploads and assistant-side generate_image output;
 * the partition is role-agnostic.
 */
import type { Attachment } from '../supabase';
import { isImageMimeType } from '../attachments';

/**
 * True when an attachment should render as a large inline image
 * preview: it's an image MIME type AND its object is still live
 * (non-null storage_path). An expired image has no object to show, so it
 * falls back to the file-chip row (filename + expired badge) like any
 * other reclaimed attachment.
 */
function isLiveImageAttachment(a: Attachment): boolean {
  return isImageMimeType(a.mime_type) && a.storage_path !== null;
}

export interface PartitionedAttachments {
  /** Live images, rendered as large previews (~85% of card width). */
  images: Attachment[];
  /** Everything else - files, plus expired images - rendered as chips. */
  files: Attachment[];
}

/**
 * Split a message's attachments into the large-preview group and the
 * chip group, preserving the original order within each group.
 */
export function partitionAttachments(
  attachments: Attachment[]
): PartitionedAttachments {
  const images: Attachment[] = [];
  const files: Attachment[] = [];
  for (const a of attachments) {
    if (isLiveImageAttachment(a)) images.push(a);
    else files.push(a);
  }
  return { images, files };
}
