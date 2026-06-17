/**
 * Settings-domain types and their coercer: the per-user `profiles.settings`
 * shape (`UserSettings`), the named-system-prompt shape, and
 * `coerceSettings`, which scrubs the raw jsonb blob from Supabase into a
 * well-typed `UserSettings` (dropping unknown / malformed fields silently
 * so a bad value written by an older build can't break the app). The
 * coercer rides with the type because it IS the settings boundary - the
 * one place the wire shape is validated. Re-exported through
 * `../../supabase.ts` so consumers keep importing from `$lib/supabase`.
 */
import {
  coerceTierModels,
  isModelTier,
  isReasoningEffort,
  isVerbosity,
  type ModelTier,
  type ReasoningEffort,
  type TierModels,
  type Verbosity,
} from '../../models';
import { isAccent, isColorMode, type Accent, type ColorMode } from '../../theme';
import { isLogLevel, type LogLevel } from '../../logger.svelte';

// --- appended verbatim from the original supabase.ts type block ---
/**
 * Length ceiling applied to free-form user-profile string fields
 * (`userName`, `userLocation`) at the coercer + updater boundary.
 * Defensive cap so a corrupt blob can't balloon the per-turn
 * system prompt. 200 characters is generous enough for a
 * descriptive entry ("Brooklyn, NY - born in Lagos, partial to
 * Pacific timezones") without being a foothold for prompt-stuffing.
 */
export const USER_PROFILE_FIELD_MAX = 200;

/**
 * A named system prompt. `enabledByDefault` is the "ride along on every new
 * conversation" flag; per-thread enablement lives in component state (it
 * isn't persisted — see the note on Chat.svelte). Ids are client-generated
 * UUIDs so new prompts can be created offline and referenced immediately.
 */
export interface SystemPrompt {
  id: string;
  name: string;
  body: string;
  enabledByDefault: boolean;
}

/**
 * Per-user preferences persisted on `profiles.settings` (jsonb). Keeps
 * prefs that should follow the account across browsers — the local
 * Supabase config (URL + publishable key) stays per-device by design.
 */
export interface UserSettings {
  defaultModel?: ModelTier;
  /**
   * Per-tier model + reasoning overrides. Each entry repoints a tier
   * (Smart/Balanced/Fast) at a user-chosen Venice model and pins that
   * tier's default reasoning level, carrying a capability snapshot so the
   * chat send path resolves synchronously without the catalog. Absent
   * tiers fall back to the built-in TierSpec. See TierModelConfig in
   * ./models for the snapshot rationale.
   */
  tierModels?: TierModels;
  /**
   * User-level reasoning-effort default, used on reasoning-capable
   * models when the thread hasn't overridden it. Absent means fall
   * back to {@link DEFAULT_REASONING_EFFORT} in code (`low`) so an
   * empty settings jsonb still produces sane behavior.
   */
  defaultReasoningEffort?: ReasoningEffort;
  /**
   * User-level text.verbosity default, used when the thread hasn't
   * overridden it. Absent means fall back to {@link DEFAULT_VERBOSITY}
   * in code (`medium`) so an empty settings jsonb still produces sane
   * behavior.
   */
  defaultVerbosity?: Verbosity;
  colorMode?: ColorMode;
  accent?: Accent;
  /** Library of named system prompts the user can toggle per-thread. */
  systemPrompts?: SystemPrompt[];
  /**
   * Minimum level the Logs drawer should show by default. Absent
   * means "show everything" (the lowest tier, `debug`) — falling back
   * to DEFAULT_LOG_LEVEL in state.svelte.ts. The drawer seeds its own
   * filter from this value at open time; within-session overrides via
   * the drawer's dropdown are not persisted.
   */
  defaultLogLevel?: LogLevel;
  /**
   * Opt-in: ask the model to sprinkle light Markdown emphasis (bold
   * on terms, italics on phrases) through its replies so the user
   * can skim the save-points. Chat-loop appends a short instruction
   * block to the per-turn system-prompt appendix when this is true.
   * Absent / false leaves the prompt untouched. Named after the
   * "bionic reading" visual style the feature is modelled on, even
   * though this is semantic emphasis rather than mechanical prefix
   * bolding.
   */
  emphasisMarkdown?: boolean;
  /**
   * Opt-in: when a chat completion finishes in a thread the user isn't
   * currently viewing, surface it via an OS notification (if the tab is
   * hidden and permission was granted) or an in-app unread dot on the
   * sidebar row. Default off because enabling it triggers the browser's
   * permission prompt - the user has to ask for the feature explicitly.
   */
  notifyOnComplete?: boolean;
  /**
   * IANA timezone the model sees when reasoning about "what time is
   * it for the user" in the per-turn metadata system message, and
   * the zone the wiki worker uses to bucket day-eligible threads.
   * "America/New_York", "Europe/London", etc. Seeded on first
   * Settings visit from
   * `Intl.DateTimeFormat().resolvedOptions().timeZone`; the user
   * overrides from Settings -> AI -> About you. Absent means "fall
   * back to the browser's current zone at read time"; callers must
   * handle `undefined` rather than assume a server default so a
   * user roaming across time zones never silently lands entries on
   * the wrong day.
   */
  displayTimezone?: string;
  /**
   * User wiki feature: when true, the background wiki agent processes
   * settled threads (one calendar day after the newest message in the
   * user's tz) and updates / creates encyclopedic articles about
   * topics the conversation surfaced. Default-on semantics: absent
   * means on; only present when the user has explicitly disabled.
   * False stops the manager from starting the worker at unlock and
   * stops it mid-session when flipped. Manual edits and the
   * per-article "ask agent to update" button are unaffected by this
   * flag.
   */
  wikiAutomaticEnabled?: boolean;
  /**
   * Wiki librarian: when true, a separate background agent runs every
   * ~12 hours, reads the full wiki, and consolidates duplicates +
   * fact-checks against conversation history. Independent of
   * `wikiAutomaticEnabled` so the user can disable per-conversation
   * autonomy while still getting periodic reorganisation, or vice
   * versa. Default-on like the other wiki toggle.
   */
  wikiLibrarianEnabled?: boolean;
  /**
   * Memory librarian: when true, the deep-sleep and rem background
   * agents run on their staggered 12h cadences, consolidating
   * cross-thread duplicate memories and populating the relations
   * graph. Independent of the wiki librarian; default-on like the
   * other librarian toggles. Both sweeps run server-side; see
   * supabase/functions/venice/agents/{rem,deep_sleep}.ts.
   */
  memoryLibrarianEnabled?: boolean;
  /**
   * Free-form display name the user wants the model to address them
   * by. Optional - absent / empty string means "no name supplied,
   * the model has nothing to reach for." When present, chat-loop
   * folds it into the per-turn system-prompt appendix as a short
   * "User profile" block so every reply this turn sees the name. No
   * format imposed: a first name, a nickname, "they/them" pronouns,
   * a self-description, all valid. Capped at USER_PROFILE_FIELD_MAX
   * to keep a corrupt blob from ballooning the prompt.
   */
  userName?: string;
  /**
   * Free-form location the user wants the model to know about -
   * city, region, country, "rural Vermont", "currently roaming in
   * Asia", whatever they want to share. Same opt-in semantics and
   * length cap as userName. Used so weather/timezone/cultural-
   * context questions land grounded rather than the model guessing
   * or asking back. Not derived from IP or geolocation - we never
   * try to detect this; the user supplies it explicitly in
   * Settings or leaves it blank.
   */
  userLocation?: string;
}

export function coerceSystemPrompt(raw: unknown): SystemPrompt | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === 'string' && r.id.length > 0 ? r.id : null;
  const name = typeof r.name === 'string' ? r.name : null;
  const body = typeof r.body === 'string' ? r.body : null;
  const enabledByDefault = r.enabledByDefault === true;
  if (id === null || name === null || body === null) return null;
  return { id, name, body, enabledByDefault };
}

/**
 * Scrub an unknown jsonb blob from Supabase into a well-typed UserSettings.
 * Drops unknown / malformed fields silently so a bad value written by an
 * older build can't break the app.
 */
export function coerceSettings(raw: unknown): UserSettings {
  if (typeof raw !== 'object' || raw === null) return {};
  const r = raw as Record<string, unknown>;
  const out: UserSettings = {};
  if (isModelTier(r.defaultModel)) out.defaultModel = r.defaultModel;
  const tierModels = coerceTierModels(r.tierModels);
  if (tierModels) out.tierModels = tierModels;
  if (isReasoningEffort(r.defaultReasoningEffort)) {
    out.defaultReasoningEffort = r.defaultReasoningEffort;
  }
  if (isVerbosity(r.defaultVerbosity)) out.defaultVerbosity = r.defaultVerbosity;
  if (isColorMode(r.colorMode)) out.colorMode = r.colorMode;
  if (isAccent(r.accent)) out.accent = r.accent;
  if (Array.isArray(r.systemPrompts)) {
    const prompts: SystemPrompt[] = [];
    for (const item of r.systemPrompts) {
      const p = coerceSystemPrompt(item);
      if (p) prompts.push(p);
    }
    if (prompts.length > 0) out.systemPrompts = prompts;
  }
  if (isLogLevel(r.defaultLogLevel)) out.defaultLogLevel = r.defaultLogLevel;
  if (typeof r.emphasisMarkdown === 'boolean') {
    out.emphasisMarkdown = r.emphasisMarkdown;
  }
  if (typeof r.notifyOnComplete === 'boolean') {
    out.notifyOnComplete = r.notifyOnComplete;
  }
  if (typeof r.wikiAutomaticEnabled === 'boolean') {
    out.wikiAutomaticEnabled = r.wikiAutomaticEnabled;
  }
  if (typeof r.wikiLibrarianEnabled === 'boolean') {
    out.wikiLibrarianEnabled = r.wikiLibrarianEnabled;
  }
  if (typeof r.memoryLibrarianEnabled === 'boolean') {
    out.memoryLibrarianEnabled = r.memoryLibrarianEnabled;
  }
  // displayTimezone is the canonical key. We also read the legacy
  // `journalTimezone` key so a profile written before the rename
  // lands keeps its setting on first read; the next updateSettings
  // call writes the new key and the legacy one falls out of the
  // blob naturally because nothing writes it any more.
  const tzCandidate =
    typeof r.displayTimezone === 'string' && r.displayTimezone.length > 0
      ? r.displayTimezone
      : typeof r.journalTimezone === 'string' && r.journalTimezone.length > 0
        ? r.journalTimezone
        : null;
  if (tzCandidate !== null && tzCandidate.length < 128) {
    // Character set loose on purpose - IANA zones are
    // `Continent/City` plus aliases, and we don't want to re-implement
    // the zone list client-side. The 128-char ceiling is a defensive
    // cap so a malformed blob can't balloon.
    out.displayTimezone = tzCandidate;
  }
  // userName / userLocation: free-form opt-in profile strings. Empty
  // string is treated as absent so the prompt builder doesn't have to
  // distinguish "user typed nothing" from "field never set" - either
  // way the appendix block stays out. Length-capped to keep a corrupt
  // blob from ballooning the per-turn prompt.
  if (
    typeof r.userName === 'string' &&
    r.userName.length > 0 &&
    r.userName.length <= USER_PROFILE_FIELD_MAX
  ) {
    out.userName = r.userName;
  }
  if (
    typeof r.userLocation === 'string' &&
    r.userLocation.length > 0 &&
    r.userLocation.length <= USER_PROFILE_FIELD_MAX
  ) {
    out.userLocation = r.userLocation;
  }
  return out;
}

