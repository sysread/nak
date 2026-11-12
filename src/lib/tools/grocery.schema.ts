/**
 * Schema-only export for `grocery` - the grocery-list combination
 * tool. One tool, one `op` enum discriminator (list / add / remove /
 * update) with flat per-op parameters, following the recipes/skills
 * combo precedent. The impl lives in the venice edge function
 * (supabase/functions/venice/tools/grocery.ts).
 *
 * The op semantics follow the domain's two-verb split deliberately
 * (see docs/dev/grocery-list.md "Gotchas"): `remove` un-plans an
 * item (deletes its open list entry) and never stamps a purchase -
 * purchase history records only what the user actually bought, and
 * stamping it is the panel row tap, not a model call. That verb is
 * absent from this tool on purpose; the deferral and its rationale
 * live in docs/dev/planned-changes.md.
 *
 * Per-op required fields that a flat schema cannot express (id XOR
 * name on remove/update, per-item name on add) are enforced edge-side
 * with ArgErrors; the one unconditional required (items on add) rides
 * the x-per-op-required map consumed by validateToolArgs. Nested
 * item-level caps (name/count/unit/note lengths, maxItems) are also
 * handler-enforced - the central validator checks top-level
 * properties only.
 */

// Tool-side runaway guards, mirrored in the edge impl
// (supabase/functions/venice/tools/grocery.ts). The DB stores free
// text - unlike the recipes caps, these mirror no DB constraint.
// Module-private: nothing imports them; the edge copy carries its
// own constants with a citation back to this file.
const GROCERY_LIST_DEFAULT_LIMIT = 100;
const GROCERY_LIST_MAX_LIMIT = 500;

const MAX_GROCERY_ADD_ITEMS = 30;
const MAX_GROCERY_NAME_CHARS = 200;
const MAX_GROCERY_COUNT_CHARS = 100;
const MAX_GROCERY_UNIT_CHARS = 100;
const MAX_GROCERY_NOTE_CHARS = 500;

function formatGroceryArgs(args: Record<string, unknown>): string {
  const lines: string[] = [];
  // The op leads: the detail panel should read what kind of grocery
  // call this is before any operand.
  if (typeof args.op === 'string' && args.op) {
    lines.push(`**Op:** ${args.op}`);
  }
  for (const key of ['id', 'name', 'rename', 'recipe_id', 'query', 'status', 'limit'] as const) {
    const v = args[key];
    if (v === undefined || v === null || v === '') continue;
    lines.push(`**${key}:** ${String(v)}`);
  }
  // Patch fields where null is meaningful (clears) - render the
  // explicit null so the pretty view shows the clear intent.
  for (const key of ['note', 'count', 'unit', 'section'] as const) {
    if (!(key in args)) continue;
    const v = args[key];
    if (v === undefined) continue;
    lines.push(`**${key}:** ${v === null ? '(clear)' : String(v)}`);
  }
  if (Array.isArray(args.items)) {
    lines.push('**items:**');
    for (const raw of args.items) {
      if (typeof raw !== 'object' || raw === null) continue;
      const item = raw as Record<string, unknown>;
      const name = typeof item.name === 'string' ? item.name : '?';
      let line = `- **${name}**`;
      const qty =
        typeof item.count === 'string' || typeof item.unit === 'string'
          ? ` x ${String(item.count ?? '')}${item.unit ? ` ${String(item.unit)}` : ''}`.replace(/^ x ( ?)/, (_m, sp) => (sp ? ' ' : ' x '))
          : '';
      if (qty) line += qty;
      if (typeof item.section === 'string' && item.section) {
        line += ` -> ${item.section}`;
      }
      lines.push(line);
    }
  }
  return lines.join('\n');
}

export const grocerySchema = {
  name: 'grocery',
  description:
    "Read and edit the user's grocery list - a shopping list over a " +
    'durable product catalog, grouped into sections (Produce, Bakery, ' +
    "...). One tool, one op. list: what's on the list now (default), " +
    'or search it - optional case-insensitive name substring (query), ' +
    "section filter ('Other' = the unfiled intake bucket), status " +
    "'on_list' (default) | 'acquired' (recent purchases, a recency " +
    "window) | 'all' (the whole catalog, alphabetical); returns items " +
    'plus the section names. add: put items on the list - items is an ' +
    'array of {name (required), count, unit, note, section}; ' +
    'idempotent: an item already on the list is reported as such, and ' +
    'an EXISTING catalog product is revived (its learned section and ' +
    'purchase history kept) instead of duplicated; section must be an ' +
    "existing section name ('Other' or omitted = leave unfiled for " +
    'the user to file); pass recipe_id when adding a recipe\'s ' +
    "ingredients so items stay linked to it (a missing note defaults " +
    "to 'For <title>'). remove: take one item OFF the list by id or " +
    'name - an un-plan, NOT a purchase (the user checks items off ' +
    'themselves in the app; only real buys belong to purchase ' +
    'history); reports honestly when nothing matched. update: edit one ' +
    'item by id or name - rename, note (null clears), section (a name ' +
    'files it there; null or "Other" unfiles), count / unit (the ' +
    'planned quantity, null clears, item must be on the list); rename ' +
    'is refused for recipe-linked items - the recipe\'s ingredient ' +
    'checkbox and cleanup depend on the name.',
  shortDescription: 'read and edit the grocery list',
  formatArgs: formatGroceryArgs,
  parameters: {
    type: 'object',
    properties: {
      op: {
        type: 'string',
        enum: ['list', 'add', 'remove', 'update'],
        description:
          'REQUIRED on every call. The operation to run. list: read ' +
          'or search the list/catalog. add: put items on the list. ' +
          'remove: un-plan one item. update: edit one item.',
      },
      id: {
        type: 'string',
        description:
          'Product UUID (from list). remove: the item to take off ' +
          'the list. update: the item to edit. Exactly one of id or ' +
          'name on both.',
      },
      name: {
        type: 'string',
        description:
          'remove/update only. Product name to locate the item ' +
          '(case-insensitive, trimmed). Multiple matches refuse with ' +
          'the candidates listed.',
      },
      query: {
        type: 'string',
        description:
          'list only. Optional case-insensitive substring filter on ' +
          'product name.',
      },
      status: {
        type: 'string',
        enum: ['on_list', 'acquired', 'all'],
        description:
          "list only. 'on_list' (default) the current list; " +
          "'acquired' recent purchase history (most recent first, a " +
          'recency window); all: the whole catalog, alphabetical.',
      },
      section: {
        type: ['string', 'null'],
        description:
          "list: filter to one section name ('Other' = the unfiled " +
          'intake). update: a section name files the item there; ' +
          'null unfiles it back to intake. Must be an existing ' +
          'section (unknown names are refused with the valid list).',
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: GROCERY_LIST_MAX_LIMIT,
        description: `list only. Max results (default ${GROCERY_LIST_DEFAULT_LIMIT}, max ${GROCERY_LIST_MAX_LIMIT}).`,
      },
      items: {
        type: 'array',
        maxItems: MAX_GROCERY_ADD_ITEMS,
        description:
          'add only (required). Up to 30 items per call, each ' +
          '{name (required), count, unit, note, section}. count/unit ' +
          'are free-form text kept verbatim ("1/2", "2-3" stay as ' +
          'written).',
        items: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              minLength: 1,
              maxLength: MAX_GROCERY_NAME_CHARS,
              description: 'Item name as the user would say it.',
            },
            count: {
              type: 'string',
              maxLength: MAX_GROCERY_COUNT_CHARS,
              description: 'Optional quantity, free-form text (e.g. "2", "1/2").',
            },
            unit: {
              type: 'string',
              maxLength: MAX_GROCERY_UNIT_CHARS,
              description: 'Optional unit, free-form text (e.g. "kg", "bunch").',
            },
            note: {
              type: 'string',
              maxLength: MAX_GROCERY_NOTE_CHARS,
              description:
                'Optional note. Defaults to "For <title>" when ' +
                'recipe_id is given and no note is provided.',
            },
            section: {
              type: 'string',
              description:
                'Optional existing section name to file the item ' +
                "into ('Other' = leave unfiled). Applies to newly " +
                'created items only - a revived item keeps its ' +
                'learned section.',
            },
          },
          required: ['name'],
          additionalProperties: false,
        },
      },
      recipe_id: {
        type: 'string',
        description:
          'add only. Optional recipe UUID - pass it when adding a ' +
          "recipe's ingredients so the created items stay linked to " +
          'it (they are cleaned up automatically when the recipe ' +
          'changes).',
      },
      rename: {
        type: 'string',
        minLength: 1,
        maxLength: MAX_GROCERY_NAME_CHARS,
        description:
          'update only. New product name. Refused for recipe-linked ' +
          'items - the recipe checkbox match and cleanup key on the ' +
          'name (rename from the app instead, where the trade is ' +
          'visible).',
      },
      note: {
        type: ['string', 'null'],
        maxLength: MAX_GROCERY_NOTE_CHARS,
        description: 'update only. New note, or null to clear.',
      },
      count: {
        type: ['string', 'null'],
        maxLength: MAX_GROCERY_COUNT_CHARS,
        description:
          'update only. New planned quantity on the open entry, or ' +
          'null to clear. The item must be on the list.',
      },
      unit: {
        type: ['string', 'null'],
        maxLength: MAX_GROCERY_UNIT_CHARS,
        description:
          'update only. New unit on the open entry, or null to ' +
          'clear. The item must be on the list.',
      },
    },
    required: ['op'],
    // Per-op required fields - flat JSON Schema cannot express them
    // (only the discriminator is unconditionally required). add's
    // items is the one unconditional required; remove/update's
    // id-XOR-name rules are conditional and stay handler-side in
    // ArgErrors (the documented exclusion set, docs/dev/tools.md).
    'x-per-op-required': {
      add: ['items'],
    },
    additionalProperties: false,
  },
} as const;
