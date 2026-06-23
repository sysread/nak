/**
 * Schema-only export for record_link_create. Impl lives in
 * `./record_link_create` (edge:
 * supabase/functions/venice/tools/record_link_create.ts).
 */
import { MAX_RECORD_LINK_LABEL_CHARS } from '../wiki';

export const recordLinkCreateSchema = {
  name: 'record_link_create',
  description:
    'Link one record to another with a short relationship label, e.g. ' +
    '"based on", "supersedes", "same dough". The link is DIRECTED ' +
    '(from -> to): create it from the newer/derived record to the one it ' +
    'builds on. Re-linking the same pair updates the label. Use this to ' +
    'record that one attempt is a follow-up to another. Both records must ' +
    'belong to the user; link only when the relationship is explicit.',
  shortDescription: 'link two records with a label',
  parameters: {
    type: 'object',
    properties: {
      from_record_id: {
        type: 'string',
        description: 'Required. UUID of the source record (the derived/newer one).',
      },
      to_record_id: {
        type: 'string',
        description: 'Required. UUID of the target record (the one being built on).',
      },
      label: {
        type: 'string',
        maxLength: MAX_RECORD_LINK_LABEL_CHARS,
        description:
          'Optional. Short relationship label ("based on", "supersedes"). ' +
          'Omit for an unlabelled link.',
      },
    },
    required: ['from_record_id', 'to_record_id'],
    additionalProperties: false,
  },
} as const;
