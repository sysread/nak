/**
 * The reactive app-state root: the single `$state` object every screen
 * reads from, plus its shape and the phase enum. Mutation policy lives
 * in the siblings - `./settings.ts` owns the in-memory setters,
 * persistence, and server-blob hydration; `./lifecycle.ts` owns the
 * phase transitions (activate / sign-out / setup) and service
 * construction. `../state.svelte.ts` re-exports the public surface of
 * all three as one facade so consumers keep importing from one place.
 *
 * Phase state machine (driven by App.svelte's boot flow):
 *
 *   loading --> setup     (no stored config found in localStorage)
 *           \-> unlocked  (stored config loaded; activate() instantiates
 *                          services and seeds defaults)
 *
 * The setup / unlocked branches are decided by `hasStoredConfig()` in
 * App.svelte. There is no `locked` phase: localStorage holds only the
 * Supabase URL + publishable key, both RLS-safe by design, so the
 * config blob carries no secrets worth gating behind a password
 * ceremony. The Supabase auth session is what makes a session
 * meaningful; sign-out tears that down via `resetForSignOut()` +
 * `supabase.signOut()`, and `Chat.svelte` re-shows the `<Auth />`
 * screen until the next sign-in.
 *
 * Why a single $state object instead of per-concern stores: every
 * screen needs phase + config + the service instances, so a single
 * rune is easier to read than a constellation of stores with the
 * same lifetime.
 */
import type { AppConfig } from '../config';
import type { SupabaseService, SystemPrompt, McpIntegration, McpToolSchema } from '../supabase';
import type { VeniceClient } from '../venice';
import { NO_PRICE_CAPS, type ModelPriceCaps } from '../models/price-caps';
import { detectTimezone } from '../timezone';
import { seedModelProfiles, type ModelProfile } from '../models';
import {
  DEFAULT_MODE,
  DEFAULT_ACCENT,
  DEFAULT_STYLE,
  readCachedTheme,
  type Accent,
  type ColorMode,
  type UiStyle,
} from '../theme';
import { DEFAULT_LOG_LEVEL, type LogLevel } from '../logger.svelte';

export type AppPhase = 'loading' | 'setup' | 'unlocked';

interface AppState {
  phase: AppPhase;
  config: AppConfig | null;
  supabase: SupabaseService | null;
  venice: VeniceClient | null;
  /**
   * The user's named model profiles from
   * `profiles.settings.modelProfiles`, in display order, exactly one
   * flagged default. Seeded to `seedModelProfiles()` on activate() so
   * the composer and send path always have a working profile before
   * (or without) a stored value; overwritten from Supabase on unlock.
   * Read at chat send time via `resolveModelProfile(app.modelProfiles,
   * thread.model)`. Each profile carries a capability snapshot, so
   * chat resolution never has to wait on the lazily-fetched catalog.
   */
  modelProfiles: ModelProfile[];
  /**
   * Venice text-to-image model id for generate_image, from
   * `profiles.settings.imageModel`. Undefined on activate() and whenever
   * the user hasn't overridden it - the server-side tool falls back to
   * VENICE_DEFAULT_IMAGE_MODEL. Only the Settings image picker reads this
   * in the browser; the chat send path never touches it (image-model
   * resolution happens server-side at generation time).
   */
  imageModel?: string;
  /**
   * Project-global model price caps from the app_config row, hydrated by
   * Chat's refreshSettings after sign-in (seeded to NO_PRICE_CAPS on
   * activate()). Read by the Settings model picker to hide over-cap
   * models; the venice edge function enforces the same caps server-side,
   * so this is a UX filter, not the boundary. Not part of
   * profiles.settings - it's project-wide config, the same row that holds
   * the shared Venice key.
   */
  priceCaps: ModelPriceCaps;
  /**
   * Project-global model_feature_rejections snapshot: wire fields a
   * model's backend rejects with strict validation, keyed by model id
   * (e.g. 'text' = the text.verbosity knob). Discovered and recorded
   * server-side by the venice edge function; hydrated by Chat's
   * refreshSettings alongside priceCaps (seeded empty on activate()).
   * Read by Settings -> Model profiles to disable controls the
   * selected model can't honor - a UX affordance only, the edge
   * function strips rejected fields from outgoing requests regardless.
   */
  modelFeatureRejections: Readonly<Record<string, readonly string[]>>;
  /** UI theme — seeded from localStorage cache, then from Supabase. */
  colorMode: ColorMode;
  accent: Accent;
  uiStyle: UiStyle;
  /**
   * Default minimum level for the in-app Logs drawer. Seeded to
   * {@link DEFAULT_LOG_LEVEL} on activate(), then overwritten from
   * Supabase `profiles.settings.defaultLogLevel` on unlock. LogsDrawer
   * reads this at open time; the user can still raise or lower the
   * threshold within a session via the drawer's own dropdown.
   */
  defaultLogLevel: LogLevel;
  /**
   * System-prompt library, loaded from Supabase `profiles.settings`. A
   * prompt's `enabledByDefault` flag seeds the per-thread active set in
   * Chat.svelte; the active set itself is not stored here because it's
   * conversation-scoped.
   */
  systemPrompts: SystemPrompt[];
  /**
   * When true, the chat loop appends a short instruction block to the
   * per-turn system-prompt appendix asking the model to use light
   * Markdown emphasis for semantic save-points (bold terms, italic
   * phrases). Opt-in; seeded from Supabase on unlock. See
   * chat/loop.ts for the exact blurb.
   */
  emphasisMarkdown: boolean;
  /**
   * When true, completions that land in a thread other than the one the
   * user is currently viewing fire either an OS notification (document
   * hidden, permission granted) or an in-app unread dot on the sidebar
   * entry. Opt-in because the OS path needs Notification permission, and
   * asking on first load would be presumptuous. Seeded from Supabase on
   * unlock; see src/lib/notifications.svelte.ts for the delivery policy.
   */
  notifyOnComplete: boolean;
  /**
   * User wiki feature: the server-side wiki sweep processes this
   * user's threads unless this is explicitly false (the cron sweep's
   * claim predicate reads the persisted form per candidate thread).
   * Seeded to true on activate() so a brand-new account gets wiki
   * entries out of the box; overwritten from Supabase
   * `profiles.settings.wikiAutomaticEnabled` on unlock.
   */
  wikiAutomaticEnabled: boolean;
  /**
   * Intents: when true, the background intent pipeline runs (minting,
   * efficacy evaluation, and the "Working intentions" system-prompt
   * block). Seeded FALSE on activate() - this is the one opt-in
   * self-developing feature; overwritten from
   * `profiles.settings.intentsEnabled` on unlock.
   */
  intentsEnabled: boolean;
  /**
   * Wiki record extraction: when true, the background extraction agent
   * scans settled conversations and creates dated records on the user's
   * existing wiki articles. Independent of `wikiAutomaticEnabled` so a
   * user can keep article maintenance on while turning off automatic
   * record extraction (manually-added records still work). Default true;
   * overwritten from Supabase `profiles.settings.wikiRecordExtractionEnabled`
   * on unlock. The cron sweep's claim predicate reads the persisted form
   * per candidate thread.
   */
  wikiRecordExtractionEnabled: boolean;
  /**
   * Wiki librarian: when true, the periodic librarian agent runs in
   * the background (12h minimum interval, atomically gated across
   * devices). Independent of `wikiAutomaticEnabled` so the two wiki
   * agents can be toggled separately. Default true; overwritten from
   * Supabase `profiles.settings.wikiLibrarianEnabled` on unlock.
   */
  wikiLibrarianEnabled: boolean;
  /**
   * Memory librarian: when true, the deep-sleep and rem background
   * agents run on their staggered 12h cadences. Default true;
   * overwritten from Supabase `profiles.settings.memoryLibrarianEnabled`
   * on unlock. The two agents start and stop together - they share
   * the same cross-device lease partition and their work is
   * complementary.
   */
  memoryLibrarianEnabled: boolean;
  /**
   * IANA timezone the model sees when reasoning about "what time is
   * it for the user" in the per-turn metadata system message; the
   * persisted form is also what the server-side day-gated agents
   * (reflection, wiki) bucket eligibility against. Seeded from the
   * browser's detected zone on activate() so a first-time user lands
   * on sensible defaults; overwritten from Supabase
   * `profiles.settings.displayTimezone` on unlock.
   */
  displayTimezone: string;
  /**
   * Whether displayTimezone is the user's SAVED value (true) or just the
   * browser-detected default seeded on activate() that has never been
   * written to profiles.settings (false). The server-side day-gates read
   * the saved value only, so an unsaved default silently runs the gate on
   * UTC; Settings uses this to show "saved vs. suggested" and to make the
   * Save button actionable while the shown value is only a hint. Set true
   * on a successful persistDisplayTimezone and from loadSettings when the
   * profile carries a value; false on activate/lock.
   */
  displayTimezonePersisted: boolean;
  /**
   * Free-form display name the user entered in Settings -> AI ->
   * About you. Empty string means "not set"; chat-loop reads both
   * profile fields per-turn and only emits the User profile block
   * when at least one of them is non-empty. Seeded blank on
   * activate(), overwritten from Supabase
   * `profiles.settings.userName` on unlock.
   */
  userName: string;
  /**
   * Free-form location the user entered in Settings -> AI -> About
   * you. Same opt-in semantics as userName. Used so the model can
   * answer location-grounded questions (weather, local time,
   * regional context) without guessing or asking back. Seeded blank
   * on activate(), overwritten from Supabase
   * `profiles.settings.userLocation` on unlock.
   */
  userLocation: string;
  /**
   * The user's connected MCP integrations, loaded from
   * `mcp_integrations` on unlock (see loadMcpIntegrations in
   * ./lifecycle.ts). Empty until that fetch resolves. Each
   * `authorized` integration becomes a gated `mcp:<id>` toolbox the
   * chat model can enable; the Settings Integrations pane mutates
   * this list (add / delete / re-authorize) and the chat-loop reads
   * it at turn entry to build the dynamic MCP toolboxes (see
   * buildMcpToolboxes in ../ui/mcp.ts).
   */
  mcpIntegrations: McpIntegration[];
  /**
   * Cached MCP tool catalog across every integration, loaded from
   * `mcp_integration_tools` alongside `mcpIntegrations`. One row per
   * (integration, server tool); the chat-loop groups these by
   * integration to assemble the wire `tools` array + system-prompt
   * catalog lines for each authorized integration's toolbox.
   * Refreshed server-side after OAuth and periodically thereafter;
   * the browser only reads.
   */
  mcpToolSchemas: McpToolSchema[];
  error: string | null;
}

const cachedTheme = readCachedTheme();

export const app = $state<AppState>({
  phase: 'loading',
  config: null,
  supabase: null,
  venice: null,
  modelProfiles: seedModelProfiles(),
  imageModel: undefined,
  priceCaps: NO_PRICE_CAPS,
  modelFeatureRejections: {},
  colorMode: cachedTheme?.mode ?? DEFAULT_MODE,
  accent: cachedTheme?.accent ?? DEFAULT_ACCENT,
  uiStyle: cachedTheme?.style ?? DEFAULT_STYLE,
  defaultLogLevel: DEFAULT_LOG_LEVEL,
  systemPrompts: [],
  emphasisMarkdown: false,
  notifyOnComplete: false,
  wikiAutomaticEnabled: true,
  intentsEnabled: false,
  wikiRecordExtractionEnabled: true,
  wikiLibrarianEnabled: true,
  memoryLibrarianEnabled: true,
  displayTimezone: detectTimezone(),
  displayTimezonePersisted: false,
  userName: '',
  userLocation: '',
  mcpIntegrations: [],
  mcpToolSchemas: [],
  error: null,
});
