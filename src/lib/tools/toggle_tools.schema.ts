/**
 * Schema-only export for toggle_toolbox. Impl lives in
 * `./toggle_tools`.
 */
export const toggleToolboxSchema = {
  name: 'toggle_toolbox',
  description:
    'Replace the set of gated toolboxes active for this conversation. ' +
    'Pass {enabled: ["cooking", "memories"]} to enable exactly those, ' +
    'or {enabled: []} to turn every gated toolbox off. The always_on ' +
    'toolbox is implicit and cannot be listed. Returns the accepted ' +
    'set; unknown names are silently dropped.',
  shortDescription: 'enable or disable gated toolboxes for this conversation',
  parameters: {
    type: 'object',
    properties: {
      enabled: {
        type: 'array',
        items: { type: 'string' },
        description:
          'The gated toolboxes that should be active. Replaces the ' +
          'current set; any not listed is disabled. always_on is ' +
          'implicit.',
      },
    },
    required: ['enabled'],
    additionalProperties: false,
  },
} as const;
