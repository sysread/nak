/**
 * UI-behavior primitives for the composer's pending-attachment chips. The
 * chip in Chat.svelte can be in one of several mutually exclusive states -
 * compressing an image, extracting text, errored, freshly compressed, or
 * ready - and picking which one to show (and the label for it) is decision
 * logic, not framework wiring, so it lives here rather than as an inline
 * template cascade.
 */
import type { LocalAttachment } from '../attachments';
import { formatBytes } from '../attachments';

/** Original vs resulting size of a compressed image, for the chip note. */
export interface ChipCompression {
  beforeBytes: number;
  afterBytes: number;
}

/**
 * Mutually exclusive chip states. `compressed` carries the human-readable
 * "Reduced from X to Y" label so the template just renders it.
 */
export type ChipStatus =
  | { kind: 'compressing' }
  | { kind: 'error' }
  | { kind: 'rendering'; label: string }
  | { kind: 'pending' }
  | { kind: 'compressed'; label: string }
  | { kind: 'ready' };

/** "Reduced from 2.7 MB to 845 KB" - the compression result, spelled out. */
export function compressionLabel(c: ChipCompression): string {
  return `Reduced from ${formatBytes(c.beforeBytes)} to ${formatBytes(c.afterBytes)}`;
}

/**
 * "Rendering page 4 of 30" - progress for the PDF rasterizer. Spelled out
 * per page because a long document's render is the slowest thing that
 * happens at attach time, and a bare spinner there reads as a hang.
 */
export function renderingLabel(r: { done: number; total: number }): string {
  return `Rendering page ${r.done} of ${r.total}`;
}

/**
 * Resolve a pending attachment to its single chip state. Order matters:
 * an error wins over any in-flight flag (it's terminal), then the
 * image-compression spinner is shown ahead of the generic pending spinner
 * (compressing implies pending, but the user-facing copy differs), then the
 * PDF render's per-page progress for the same reason, then a completed
 * compression shows its reduction, else the chip is ready.
 *
 * `rendering` outranks `pending` but not `compressing`: the two never
 * co-occur (one is an image path, the other a PDF path), so the relative
 * order between them is arbitrary - what matters is that both beat the
 * generic spinner, since both carry strictly more information.
 */
export function chipStatus(
  a: Pick<LocalAttachment, 'compressing' | 'pending' | 'error' | 'compression' | 'rendering'>
): ChipStatus {
  if (a.error) return { kind: 'error' };
  if (a.compressing) return { kind: 'compressing' };
  if (a.rendering) return { kind: 'rendering', label: renderingLabel(a.rendering) };
  if (a.pending) return { kind: 'pending' };
  if (a.compression) return { kind: 'compressed', label: compressionLabel(a.compression) };
  return { kind: 'ready' };
}

/**
 * Total bytes across the currently-pending attachments. The add-file
 * path uses this to reject files that would push the message past
 * MAX_MESSAGE_AGGREGATE_BYTES (see $lib/attachments).
 */
export function totalAttachmentBytes(
  attachments: readonly Pick<LocalAttachment, 'size_bytes'>[]
): number {
  return attachments.reduce((n, a) => n + a.size_bytes, 0);
}
