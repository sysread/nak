/**
 * Cookbook-domain row types: recipes, their immutable version snapshots,
 * and recipe photos (render-ready, metadata-only, and wire-input
 * shapes). Re-exported through `../../supabase.ts` so consumers keep
 * importing from `$lib/supabase`.
 */

// --- appended verbatim from the original supabase.ts type block ---
/**
 * A saved recipe. The authoritative representation is `cooklang`, the
 * full raw Cooklang source string — structure (ingredients, cookware,
 * timers, metadata) is re-derived on read by `src/lib/cooklang.ts`.
 * Keeping the source as the source of truth means a future spec tweak
 * doesn't invalidate stored rows.
 *
 * `source` and `source_url` are both nullable. A recipe the model fetched
 * from a URL will carry both; a recipe the user typed by hand may have
 * neither.
 */
export interface Recipe {
  id: string;
  title: string;
  source: string | null;
  source_url: string | null;
  cooklang: string;
  /**
   * User-set rating, 1-5 stars. `null` means unrated; cleared rows
   * round-trip back as null so "never rated" stays distinguishable
   * from a hypothetical zero (which the schema rejects).
   */
  rating: number | null;
  /**
   * Workflow flag - true when the user has marked this recipe as one
   * they plan to make during the current grocery-shopping cycle. Drives
   * the "Upcoming" section at the top of the drawer listing. Not
   * versioned (toggling does not write a recipe_versions row) and does
   * not bump `updated_at` so the recency sort stays stable.
   */
  upcoming: boolean;
  /**
   * Long-lived bookmark for recipes the user loves and wants one
   * click away. Independent of `upcoming` - a recipe can be either,
   * both, or neither. Drives the "Favorites" section just below
   * Upcoming in the drawer listing. Same non-versioned, non-
   * `updated_at`-bumping semantics as `upcoming`.
   */
  favorite: boolean;
  /**
   * Topic tags written by the server-side recipe-topics agent
   * (supabase/functions/venice/agents/recipe_topics.ts). Empty array
   * means "untagged" -
   * either the agent hasn't reached the row, it ran and
   * chose to emit nothing, or the user just edited title/cooklang
   * (the `clear_recipe_topics_on_change` trigger nulls
   * `last_topics_at` on content change and the next sweep
   * re-tags). The UNTAGGED_TOPIC_SENTINEL is a UI-only primitive
   * and never lands in this column. Cap of 6 tags per row vs the
   * 4 used on threads/memories - recipes legitimately span more
   * dimensions (primary ingredients + cuisine + course + technique).
   */
  topics: string[];
  created_at: string;
  updated_at: string;
  /** Populated only by `search_recipes_by_embedding`. */
  similarity?: number;
}

/**
 * One immutable snapshot in a recipe's history. Every create and every
 * update writes one row via the `recipe_create_with_version` /
 * `recipe_update_with_version` RPCs. The latest row by `created_at`
 * always matches the parent `recipes` row by content; older rows are
 * the trail of past states the user can browse and revert to.
 *
 * `change_message` is required - the UI Edit form and the LLM
 * `recipe_save` tool (both forms) all force a non-empty value
 * before the RPC is called.
 */
export interface RecipeVersion {
  id: string;
  recipe_id: string;
  title: string;
  source: string | null;
  source_url: string | null;
  cooklang: string;
  /** Snapshot of the parent recipe's rating at save time. */
  rating: number | null;
  change_message: string;
  created_at: string;
}

/**
 * One photo on a recipe, ready to render. Loaded by the detail pane and
 * the edit form for thumbnail rendering and lightbox open. `url` is a
 * display-ready source resolved by `listRecipePhotos`: a short-lived
 * signed URL into the `recipe-images` bucket, or - for a legacy row not
 * yet moved by the migrate button - a `data:` URI built from the base64
 * fallback. The component renders `url` directly and stays synchronous.
 *
 * `position` is the link table's `position` field on the recipe's
 * latest version - lower numbers render first in the strip. `label`
 * is the optional caption rendered below the thumbnail and beside
 * the lightbox image; null means "no caption", and empty strings
 * round-trip as null (the DB normalises whitespace-only labels to
 * null on write).
 */
export interface RecipePhoto {
  id: string;
  position: number;
  mime_type: string;
  size_bytes: number;
  url: string;
  label: string | null;
}

/**
 * Lightweight projection of the same photo without the bytes. Returned
 * by the photo-mutation RPCs and embedded in tool returns the LLM sees,
 * so the LLM can chain attach/remove/reorder operations against
 * specific photo IDs without paying the base64 cost on every tool
 * round-trip.
 */
export interface RecipePhotoMeta {
  id: string;
  position: number;
  label: string | null;
}

/**
 * One ordered (image_id, label) pair as sent on the wire to the
 * versioned create/update/attach RPCs. Used so callers express photo
 * sets as a single ordered list rather than two parallel arrays they
 * have to keep in sync.
 */
export interface RecipePhotoInput {
  id: string;
  label: string | null;
}

/**
 * One dated record in a recipe's cooking log. The recipe's cooklang is
 * the distilled current state; records preserve the journey - what
 * happened when the user cooked it, how it went, what to try next.
 * `date` is the calendar day the cook happened (distinct from
 * `created_at`, when the row was written); `tags` is a freeform
 * keyword array used for filtering; `outcome` is the optional
 * classification (`success | mixed | failure`, null = unclassified);
 * `source_conversation_id` carries chat-capture provenance and is null
 * for manually-added records. The embedding quartet stays behind the
 * scenes (claimed + written server-side by the backfill, never read
 * here). See the matching table + RLS in
 * `supabase/schema.sql:recipe_records`.
 */
export interface RecipeRecord {
  id: string;
  user_id: string;
  recipe_id: string;
  /** ISO `YYYY-MM-DD` - the day the cook happened. */
  date: string;
  content: string;
  tags: string[];
  outcome: string | null;
  source_conversation_id: string | null;
  created_at: string;
  updated_at: string;
  /** Populated only by `search_recipe_records_by_embedding`. */
  similarity?: number;
}

/**
 * Defensive coercion of a recipe_records row (or a search hit). `tags`
 * may arrive as a JSONB array or be absent on a search-RPC row (the
 * RPC projects it but a jsonb payload could round-trip as a string);
 * normalize to a string array. `outcome`, `source_conversation_id`,
 * and `similarity` are optional; `user_id` is absent on search-RPC
 * rows, which don't project that column.
 */
export function coerceRecipeRecord(raw: Record<string, unknown>): RecipeRecord {
  let tags: string[] = [];
  const rawTags = raw.tags;
  if (Array.isArray(rawTags)) {
    tags = rawTags.filter((t): t is string => typeof t === 'string');
  } else if (typeof rawTags === 'string' && rawTags.length > 0) {
    try {
      const parsed = JSON.parse(rawTags);
      if (Array.isArray(parsed)) {
        tags = parsed.filter((t): t is string => typeof t === 'string');
      }
    } catch {
      // Malformed tag payload - treat as untagged rather than throwing
      // in a read path.
    }
  }
  const outcomeRaw = raw.outcome;
  const srcRaw = raw.source_conversation_id;
  return {
    id: String(raw.id),
    user_id: typeof raw.user_id === 'string' ? raw.user_id : '',
    recipe_id: String(raw.recipe_id ?? ''),
    date: typeof raw.date === 'string' ? raw.date : '',
    content: typeof raw.content === 'string' ? raw.content : '',
    tags,
    // Empty strings normalize to null so "unclassified" has one shape.
    outcome: typeof outcomeRaw === 'string' && outcomeRaw.length > 0 ? outcomeRaw : null,
    source_conversation_id:
      typeof srcRaw === 'string' && srcRaw.length > 0 ? srcRaw : null,
    created_at: String(raw.created_at ?? raw.updated_at ?? ''),
    updated_at: String(raw.updated_at ?? raw.created_at ?? ''),
    similarity:
      typeof raw.similarity === 'number' ? (raw.similarity as number) : undefined,
  };
}

