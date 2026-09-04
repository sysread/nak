/**
 * Supabase client wrapper — owns auth, threads, messages, and per-user
 * settings. Every call from the UI that touches the user's Supabase
 * project goes through SupabaseService.
 *
 * Security posture: we connect with the project's public **publishable key**,
 * not a service-role key. Row-Level Security (see `supabase/schema.sql`)
 * is the actual boundary — the publishable key only works for the signed-in
 * user's own rows. The service-role key never reaches the browser; it's
 * used by `mise run setup` locally to seed the main user and then
 * discarded.
 *
 * Consumed by `state.svelte.ts` (which instantiates a SupabaseService
 * on unlock), `Chat.svelte` (threads + messages), and `Settings.svelte`
 * (keys rotation, settings, theme).
 */
import { createClient, type SupabaseClient, type Session } from '@supabase/supabase-js';
import type { AppConfig } from './config';
import type { ThinkingLevel, Verbosity } from './models';
import type { CatalogModel } from './models/catalog';
import type { ImageCatalogModel } from './models/image-catalog';
import type { ModelPriceCaps } from './models/price-caps';
import type { SerializableLogEntry } from './logger.svelte';
import type { OpenAIToolCall } from './tools/types';
import type {
  ChatCompletion,
  ChatRequest,
  Citation,
  EmbeddingRequest,
  EmbeddingResponse,
  TokenUsage,
} from './venice';
import type { UsageRequestOptions, UsageModelBucket, KeyUsage } from './usage';
import { SupabaseError } from './supabase/error';
// Agent-runs domain slice (the wiki/rem/deep-sleep run + retry
// routes), same delegation pattern as the slices below.
import * as agentRunsApi from './supabase/agent-runs';
// Bias-profile domain slice (bias summary + observations + reactions
// reads), same delegation pattern.
import * as biasApi from './supabase/bias';
// Cookbook domain slice (recipes, versions, photos), same delegation
// pattern.
import * as cookbookApi from './supabase/cookbook';
// Conversation-digest domain slice (read-only paged listing of the
// agent-written daily recaps), same delegation pattern.
import * as digestsApi from './supabase/digests';
// Library / documents domain slice (document CRUD, Library paging and
// search, bucket upload + signed download URLs), same delegation
// pattern.
import * as documentsApi from './supabase/documents';
// Grocery-list domain slice (sections, catalog products, list
// entries, product photos), same delegation pattern.
import * as groceryApi from './supabase/grocery';
// Memories domain slice: the facade's memory methods (both the CRUD +
// changelog group and the confidence / search / relations group)
// delegate to these plain functions one-for-one under the same names
// (see the class preamble for the slice pattern).
import * as memoriesApi from './supabase/memories';
// Messages & attachments domain slice (message read/write, attachment
// storage), same delegation pattern.
import * as messagesApi from './supabase/messages';
// Rasterized-attachment-page slice (the PDF page renders that back
// analyze_pdf_page). Split from ./supabase/messages.ts because it owns a
// separate table with its own lifecycle, not because the file grew.
import * as attachmentPagesApi from './supabase/attachment-pages';
import type { RenderedPdfPage } from './pdf-pages';
// Realtime domain slice (subscribe* channels + their paired point
// reads), same delegation pattern.
import * as realtimeApi from './supabase/realtime';
// Samskara domain slice, same delegation pattern.
import * as samskaraApi from './supabase/samskara';
// Settings + Venice-proxy domain slices, same delegation pattern.
import * as settingsApi from './supabase/settings';
import * as veniceProxyApi from './supabase/venice-proxy';
// Threads + topic-vocabulary domain slices, same delegation pattern.
import * as threadsApi from './supabase/threads';
import * as topicsApi from './supabase/topics';
// Wiki-article and wiki-record domain slices, same delegation pattern.
// Articles and records are separate sub-domains (separate UI surfaces);
// records + their files + their links are one lifecycle and share a
// module.
import * as wikiApi from './supabase/wiki';
import * as wikiRecordsApi from './supabase/wiki-records';
// Wiki-satellite domain slice (bibliography, See-Also, changelog),
// same delegation pattern.
import * as wikiSourcesApi from './supabase/wiki-sources';
// MCP-integration domain slice (integrations list, cached tool
// catalog, and the OAuth-flow edge-function proxy calls), same
// delegation pattern.
import * as mcpApi from './supabase/mcp';

// Domain row types live in ./supabase/types/*; this module keeps the
// SupabaseService class plus the row coercers that read those types.
// Re-export the whole type layer so `$lib/supabase` stays the single
// import surface every consumer already reaches for, then pull the
// names this file's coercers and class methods reference into local
// scope (a re-export alone doesn't bind them here).
export * from './supabase/types';
import type {
  Thread,
  Attachment,
  NewAttachment,
  ArtifactListRow,
  ThreadAttachmentSummary,
  Message,
  ThreadCursor,
  ThreadPage,
  ThreadSearchHit,
  Memory,
  MemoryChangelogKind,
  MemoryChangelogEntry,
  SimilarMemory,
  MemoryRelation,
  WikiArticle,
  WikiRecord,
  WikiRecordFile,
  WikiRecordLink,
  WikiRecordLinkView,
  WikiArticleSource,
  WikiArticleRelated,
  WikiChangelogKind,
  WikiChangelogEntry,
  ConversationDigest,
  WikiRetryResult,
  WikiManualUpdateResult,
  Recipe,
  RecipeVersion,
  RecipePhoto,
  RecipePhotoInput,
  GrocerySection,
  GroceryProduct,
  GroceryProductView,
  GroceryProductPatch,
  GroceryEntryPatch,
  Document,
  UserSettings,
  ActiveSession,
  TopicVocabulary,
  OffsetPage,
  AgentRunProgressEvent,
  InflightLeaseColumn,
  LastRunOutcomeColumn,
  ManualRunOutcome,
  SamskaraBrowseSort,
  SamskaraCorpusRow,
  SamskaraProvenanceRow,
  SamskaraHealthSnapshot,
  SamskaraRates,
  SamskaraVerdictCounts,
  SamskaraSubstrateDiagnosticRow,
  SamskaraFireDiagnosticRow,
  McpIntegration,
  McpToolSchema,
} from './supabase/types';
import type {
  McpDiscoveredMetadata,
  McpRegisterResult,
  McpTokenExchangeResult,
} from './supabase/mcp';
import type { IntentRow } from './ui/intents-inspector';
import type { FollowupInspectorRow } from './ui/followups-inspector';

/**
 * The browser's single handle on the user's Supabase project. The
 * class is a facade: every method is a one-line delegation to a
 * per-domain slice module under ./supabase/, keeping its original
 * name, so `app.supabase.<method>()` call sites, the delegate, and
 * the implementation all sit under one greppable token. The banner
 * directory (declaration order; grep a banner to jump to its block):
 *
 *   Auth & session            sign-in / out, session, password.
 *                             IMPLEMENTED INLINE - these own the
 *                             client's auth surface.
 *   Settings & Venice API proxies
 *                             user settings blob     -> ./supabase/settings.ts
 *                             /complete, /embed, /usage, /models,
 *                             text extraction        -> ./supabase/venice-proxy.ts
 *   Threads                   list / search / CRUD / per-thread
 *                             setters                -> ./supabase/threads.ts
 *   Memories                  CRUD + changelog + paging
 *                                                    -> ./supabase/memories.ts
 *   Cookbook                  recipes, versions, photos
 *                             (listIntents straggler lives here too)
 *                                                    -> ./supabase/cookbook.ts
 *   Wiki articles             article CRUD + paging + search
 *                                                    -> ./supabase/wiki.ts
 *   wiki record files         record attachments     -> ./supabase/wiki-records.ts
 *   wiki record links         record cross-links     -> ./supabase/wiki-records.ts
 *   Library / documents       document CRUD + upload -> ./supabase/documents.ts
 *   Wiki sources, changelog & agent runs
 *                             bibliography / See-Also / changelog
 *                                                    -> ./supabase/wiki-sources.ts
 *                             wiki/rem/deep-sleep run + retry routes
 *                                                    -> ./supabase/agent-runs.ts
 *   Thread response claims    cross-device "responding here" claim
 *                                                    -> ./supabase/threads.ts
 *   Topic vocabularies        list_user_*_topics     -> ./supabase/topics.ts
 *   Memory confidence, search & relations
 *                             reaffirm/doubt, embedding search, graph
 *                                                    -> ./supabase/memories.ts
 *   Messages & attachments    message read/write, attachment storage
 *                                                    -> ./supabase/messages.ts
 *                             rasterized PDF pages   -> ./supabase/attachment-pages.ts
 *   Realtime subscriptions & message fetch
 *                             subscribe* + paired point reads
 *                                                    -> ./supabase/realtime.ts
 *   Samskara                  fire / substrate / health / clustering
 *                                                    -> ./supabase/samskara.ts
 *   Bias profile              summary + observation reads
 *                                                    -> ./supabase/bias.ts
 *   MCP integrations          integrations list, cached tool catalog,
 *                             and the OAuth-flow edge-function
 *                             proxy calls (discover / register /
 *                             token-exchange / refresh / disconnect)
 *                                                    -> ./supabase/mcp.ts
 *
 * One straggler: listIntents is implemented inline until an intents
 * slice exists (see the note at its declaration).
 *
 * Slice functions take the shared SupabaseClient as their first
 * argument - no class, no state - so each is unit-testable against a
 * stubbed client without constructing SupabaseService. Row types and
 * their coercers live in ./supabase/types/*; SupabaseError in
 * ./supabase/error.ts; cross-domain query builders in
 * ./supabase/query-utils.ts. UI code should not import slice modules
 * directly - this facade is the API. New query wrappers go in the
 * owning slice with a delegating method here.
 */
export class SupabaseService {
  readonly client: SupabaseClient;

  /**
   * `opts.client` is the dependency-injection hatch used by the background
   * worker fleet (the Web Workers under src/lib/agents/). Each worker builds
   * its own `SupabaseClient` with `persistSession: false` + a manually-pinned
   * session, because workers have no localStorage and shouldn't fight the
   * main-thread client for the session store. The default path (no `opts`)
   * preserves the original main-thread behavior.
   */
  constructor(
    config: Pick<AppConfig, 'supabaseUrl' | 'supabasePublishableKey'>,
    opts: { client?: SupabaseClient } = {}
  ) {
    this.client =
      opts.client ??
      createClient(config.supabaseUrl, config.supabasePublishableKey, {
        auth: {
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: false,
        },
      });
  }

  // --- Auth & session --------------------------------------------------

  async getSession(): Promise<Session | null> {
    const { data, error } = await this.client.auth.getSession();
    if (error) throw new SupabaseError(error.message);
    return data.session;
  }

  onAuthChange(cb: (session: Session | null) => void): () => void {
    const { data } = this.client.auth.onAuthStateChange((_event, session) => {
      cb(session);
    });
    return () => data.subscription.unsubscribe();
  }

  async signUp(email: string, password: string): Promise<Session | null> {
    const { data, error } = await this.client.auth.signUp({ email, password });
    if (error) throw new SupabaseError(error.message);
    return data.session;
  }

  async signIn(email: string, password: string): Promise<Session> {
    const { data, error } = await this.client.auth.signInWithPassword({
      email,
      password,
    });
    if (error) throw new SupabaseError(error.message);
    if (!data.session) throw new SupabaseError('Sign-in returned no session.');
    return data.session;
  }

  async signOut(): Promise<void> {
    const { error } = await this.client.auth.signOut();
    if (error) throw new SupabaseError(error.message);
  }

  // Rotate the Supabase auth (login) password. Supabase's updateUser
  // endpoint does NOT require the current password - any holder of a
  // valid session token could otherwise rotate it. To match what users
  // expect from a "change password" form (and to block a stolen-tab
  // attack against an unlocked session), re-verify the current password
  // by re-signing in first. The re-signin issues a fresh session for
  // the same user, which is harmless.
  async changeAuthPassword(currentPassword: string, newPassword: string): Promise<void> {
    const session = await this.getSession();
    if (!session) throw new SupabaseError('Not authenticated.');
    const email = session.user.email;
    if (!email) {
      throw new SupabaseError(
        'This account has no email on file, so the password cannot be changed here.',
      );
    }
    const reauth = await this.client.auth.signInWithPassword({
      email,
      password: currentPassword,
    });
    if (reauth.error) {
      throw new SupabaseError('Current password is incorrect.');
    }
    const { error } = await this.client.auth.updateUser({ password: newPassword });
    if (error) throw new SupabaseError(error.message);
  }

  // --- Settings & Venice API proxies -----------------------------------
  //
  // Extracted domain slices: the implementations and their doc comments
  // live in ./supabase/settings.ts (profiles.settings reads/writes plus
  // the price-caps read) and ./supabase/venice-proxy.ts (the venice
  // edge-function proxy calls) as plain functions taking the client.
  // These methods delegate one-for-one under the same names so call
  // sites and grep targets stay stable.

  async getSettings(): Promise<UserSettings> {
    return settingsApi.getSettings(this.client);
  }

  async getPriceCaps(): Promise<ModelPriceCaps> {
    return settingsApi.getPriceCaps(this.client);
  }

  async getModelFeatureRejections(): Promise<Readonly<Record<string, readonly string[]>>> {
    return settingsApi.getModelFeatureRejections(this.client);
  }

  async fetchUsage(opts: UsageRequestOptions = {}): Promise<UsageModelBucket[]> {
    return veniceProxyApi.fetchUsage(this.client, opts);
  }

  async fetchKeyUsage(): Promise<KeyUsage | null> {
    return veniceProxyApi.fetchKeyUsage(this.client);
  }

  async fetchModels(): Promise<CatalogModel[]> {
    return veniceProxyApi.fetchModels(this.client);
  }

  async fetchImageModels(): Promise<ImageCatalogModel[]> {
    return veniceProxyApi.fetchImageModels(this.client);
  }

  async embed(req: EmbeddingRequest): Promise<EmbeddingResponse> {
    return veniceProxyApi.embed(this.client, req);
  }

  async extractText(file: Blob, filename: string): Promise<string> {
    return veniceProxyApi.extractText(this.client, file, filename);
  }

  async complete(req: ChatRequest): Promise<ChatCompletion> {
    return veniceProxyApi.complete(this.client, req);
  }

  async updateSettings(patch: Partial<UserSettings>): Promise<UserSettings> {
    return settingsApi.updateSettings(this.client, patch);
  }

  async updateActiveSessions(
    mutate: (sessions: Record<string, ActiveSession>) => Record<string, ActiveSession>
  ): Promise<UserSettings> {
    return settingsApi.updateActiveSessions(this.client, mutate);
  }

  // --- Threads ---------------------------------------------------------
  //
  // Extracted domain slice: the implementations and their doc comments
  // live in ./supabase/threads.ts (list / search / CRUD / per-thread
  // setters, plus the thread-scoped response claims further down) as
  // plain functions taking the client. These methods delegate
  // one-for-one under the same names so call sites and grep targets
  // stay stable.

  async listRecentThreads(
    cutoff: string,
    selectedTopics: readonly string[] = []
  ): Promise<Thread[]> {
    return threadsApi.listRecentThreads(this.client, cutoff, selectedTopics);
  }

  async listOlderThreads(opts: {
    cutoff: string;
    cursor: ThreadCursor | null;
    pageSize?: number;
    selectedTopics?: readonly string[];
  }): Promise<ThreadPage> {
    return threadsApi.listOlderThreads(this.client, opts);
  }

  async listArchivedThreads(opts: {
    cursor: ThreadCursor | null;
    pageSize?: number;
    selectedTopics?: readonly string[];
  }): Promise<ThreadPage> {
    return threadsApi.listArchivedThreads(this.client, opts);
  }

  async listThreadsSince(opts: {
    target: ThreadCursor;
    archived: boolean;
    cutoff: string | null;
    selectedTopics?: readonly string[];
  }): Promise<Thread[]> {
    return threadsApi.listThreadsSince(this.client, opts);
  }

  async getThreadStreamState(threadId: string): Promise<{
    streamHeartbeatAt: string | null;
    responseHolderId: string | null;
    responseClaimExpiresAt: string | null;
  } | null> {
    return threadsApi.getThreadStreamState(this.client, threadId);
  }

  async searchThreads(opts: {
    query: string;
    queryEmbedding: number[] | null;
    limit?: number;
    selectedTopics?: readonly string[];
  }): Promise<ThreadSearchHit[]> {
    return threadsApi.searchThreads(this.client, opts);
  }

  async createThread(
    title: string,
    model: string | null = null,
    reasoningEffort: ThinkingLevel | null = null,
    verbosity: Verbosity | null = null,
    titleManuallySet = false,
    toolboxesEnabled: string[] = []
  ): Promise<Thread> {
    return threadsApi.createThread(
      this.client,
      title,
      model,
      reasoningEffort,
      verbosity,
      titleManuallySet,
      toolboxesEnabled
    );
  }

  async renameThread(
    threadId: string,
    title: string,
    opts: { manuallySet?: boolean } = {}
  ): Promise<void> {
    return threadsApi.renameThread(this.client, threadId, title, opts);
  }

  async forkThread(
    sourceThreadId: string,
    forkMsgId?: string,
    opts?: { markTitle?: boolean }
  ): Promise<Thread> {
    return threadsApi.forkThread(this.client, sourceThreadId, forkMsgId, opts);
  }

  async listChildForkPointIds(threadId: string): Promise<string[]> {
    return threadsApi.listChildForkPointIds(this.client, threadId);
  }

  async setThreadModel(threadId: string, model: string | null): Promise<void> {
    return threadsApi.setThreadModel(this.client, threadId, model);
  }

  async setThreadReasoningEffort(
    threadId: string,
    reasoningEffort: ThinkingLevel | null
  ): Promise<void> {
    return threadsApi.setThreadReasoningEffort(this.client, threadId, reasoningEffort);
  }

  async setThreadVerbosity(
    threadId: string,
    verbosity: Verbosity | null
  ): Promise<void> {
    return threadsApi.setThreadVerbosity(this.client, threadId, verbosity);
  }

  async setThreadIntuitionPayload(
    threadId: string,
    payload: unknown
  ): Promise<void> {
    return threadsApi.setThreadIntuitionPayload(this.client, threadId, payload);
  }

  async setThreadContextRecallPayload(
    threadId: string,
    payload: unknown
  ): Promise<void> {
    return threadsApi.setThreadContextRecallPayload(this.client, threadId, payload);
  }

  async setThreadToolboxesEnabled(
    threadId: string,
    enabled: readonly string[]
  ): Promise<void> {
    return threadsApi.setThreadToolboxesEnabled(this.client, threadId, enabled);
  }

  async setThreadArchived(threadId: string, archived: boolean): Promise<void> {
    return threadsApi.setThreadArchived(this.client, threadId, archived);
  }

  async deleteThread(threadId: string): Promise<void> {
    return threadsApi.deleteThread(this.client, threadId);
  }

  async deleteMessages(messageIds: string[]): Promise<void> {
    return threadsApi.deleteMessages(this.client, messageIds);
  }

  // --- Memories --------------------------------------------------------
  //
  // Extracted domain slice: the implementations and their doc comments
  // (including the RLS posture notes for the memories table) live in
  // ./supabase/memories.ts (memory CRUD + changelog + paging, plus the
  // confidence / embedding-search / relations group further down) as
  // plain functions taking the client. These methods delegate
  // one-for-one under the same names so call sites and grep targets
  // stay stable.

  async searchMemories(
    query: string,
    limit: number,
    selectedTopics: readonly string[] = []
  ): Promise<Memory[]> {
    return memoriesApi.searchMemories(this.client, query, limit, selectedTopics);
  }

  async updateMemory(
    id: string,
    patch: { label?: string; data?: string }
  ): Promise<Memory> {
    return memoriesApi.updateMemory(this.client, id, patch);
  }

  async deleteMemory(id: string): Promise<void> {
    return memoriesApi.deleteMemory(this.client, id);
  }

  async getMemoryById(id: string): Promise<Memory | null> {
    return memoriesApi.getMemoryById(this.client, id);
  }

  async createMemoryChangelogEntry(args: {
    memory_id: string | null;
    kind: MemoryChangelogKind;
    label_at_change: string;
    message: string;
    chars_before?: number;
    chars_after?: number;
  }): Promise<void> {
    return memoriesApi.createMemoryChangelogEntry(this.client, args);
  }

  async listMemoryChangelog(opts: {
    limit?: number;
    before?: string | null;
  } = {}): Promise<MemoryChangelogEntry[]> {
    return memoriesApi.listMemoryChangelog(this.client, opts);
  }

  async listMemoriesPage(opts: {
    offset: number;
    pageSize: number;
    selectedTopics?: readonly string[];
  }): Promise<OffsetPage<Memory>> {
    return memoriesApi.listMemoriesPage(this.client, opts);
  }

  // --- Cookbook --------------------------------------------------------
  //
  // Extracted domain slice: the implementations and their doc comments
  // (including the RLS-posture and embedding-pipeline notes for the
  // recipes tables) live in ./supabase/cookbook.ts (recipes, versions,
  // photos) as plain functions taking the client. These methods
  // delegate one-for-one under the same names so call sites and grep
  // targets stay stable.

  async listRecipes(
    query: string,
    limit: number,
    sort: 'updated' | 'rating' = 'updated'
  ): Promise<Recipe[]> {
    return cookbookApi.listRecipes(this.client, query, limit, sort);
  }

  async listRecipesPage(opts: {
    offset: number;
    pageSize: number;
    sort: 'updated' | 'rating' | 'alphabetical';
    selectedTopics?: readonly string[];
  }): Promise<OffsetPage<Recipe>> {
    return cookbookApi.listRecipesPage(this.client, opts);
  }

  async listUpcomingRecipes(): Promise<Recipe[]> {
    return cookbookApi.listUpcomingRecipes(this.client);
  }

  async listFavoriteRecipes(): Promise<Recipe[]> {
    return cookbookApi.listFavoriteRecipes(this.client);
  }

  async getRecipe(id: string): Promise<Recipe | null> {
    return cookbookApi.getRecipe(this.client, id);
  }

  async searchRecipes(opts: {
    query: string;
    queryEmbedding: number[] | null;
    limit?: number;
  }): Promise<Recipe[]> {
    return cookbookApi.searchRecipes(this.client, opts);
  }

  async createRecipe(
    title: string,
    cooklang: string,
    source: string | null,
    sourceUrl: string | null,
    rating: number | null,
    changeMessage: string,
    photos: RecipePhotoInput[] = []
  ): Promise<Recipe> {
    return cookbookApi.createRecipe(
      this.client,
      title,
      cooklang,
      source,
      sourceUrl,
      rating,
      changeMessage,
      photos
    );
  }

  async updateRecipe(
    id: string,
    patch: {
      title?: string;
      cooklang?: string;
      source?: string | null;
      source_url?: string | null;
      rating?: number | null;
      photos?: RecipePhotoInput[];
    },
    changeMessage: string
  ): Promise<Recipe> {
    return cookbookApi.updateRecipe(this.client, id, patch, changeMessage);
  }

  async setRecipeUpcoming(id: string, upcoming: boolean): Promise<void> {
    return cookbookApi.setRecipeUpcoming(this.client, id, upcoming);
  }

  async setRecipeFavorite(id: string, favorite: boolean): Promise<void> {
    return cookbookApi.setRecipeFavorite(this.client, id, favorite);
  }

  async deleteRecipe(id: string): Promise<void> {
    return cookbookApi.deleteRecipe(this.client, id);
  }

  async listRecipeVersions(recipeId: string): Promise<RecipeVersion[]> {
    return cookbookApi.listRecipeVersions(this.client, recipeId);
  }

  async getRecipeVersion(versionId: string): Promise<RecipeVersion | null> {
    return cookbookApi.getRecipeVersion(this.client, versionId);
  }

  async revertRecipe(
    recipeId: string,
    versionId: string,
    changeMessage: string
  ): Promise<Recipe> {
    return cookbookApi.revertRecipe(this.client, recipeId, versionId, changeMessage);
  }

  async upsertRecipeImage(
    sha256: string,
    mimeType: string,
    sizeBytes: number,
    dataBase64: string
  ): Promise<string> {
    return cookbookApi.upsertRecipeImage(this.client, sha256, mimeType, sizeBytes, dataBase64);
  }

  async uploadRecipeImageObject(
    sha256: string,
    dataBase64: string,
    mimeType: string
  ): Promise<string> {
    return cookbookApi.uploadRecipeImageObject(this.client, sha256, dataBase64, mimeType);
  }

  async listRecipePhotos(recipeId: string): Promise<RecipePhoto[]> {
    return cookbookApi.listRecipePhotos(this.client, recipeId);
  }

  async listRecipeVersionPhotoInputs(
    versionId: string
  ): Promise<RecipePhotoInput[]> {
    return cookbookApi.listRecipeVersionPhotoInputs(this.client, versionId);
  }

  // Grocery list -----------------------------------------------------------
  //
  // Extracted domain slice: implementations and doc comments live in
  // ./supabase/grocery.ts (sections, catalog products, list entries,
  // the grocery_products_view read paths, and the product-photo
  // upload/upsert pair).

  async listGrocerySections(): Promise<GrocerySection[]> {
    return groceryApi.listGrocerySections(this.client);
  }

  async seedGrocerySectionsIfEmpty(): Promise<void> {
    return groceryApi.seedGrocerySectionsIfEmpty(this.client);
  }

  async createGrocerySection(name: string): Promise<GrocerySection> {
    return groceryApi.createGrocerySection(this.client, name);
  }

  async renameGrocerySection(id: string, name: string): Promise<void> {
    return groceryApi.renameGrocerySection(this.client, id, name);
  }

  async deleteGrocerySection(id: string): Promise<void> {
    return groceryApi.deleteGrocerySection(this.client, id);
  }

  async reorderGrocerySections(sectionIds: string[]): Promise<void> {
    return groceryApi.reorderGrocerySections(this.client, sectionIds);
  }

  async listOnListGroceryProducts(): Promise<GroceryProductView[]> {
    return groceryApi.listOnListGroceryProducts(this.client);
  }

  async listAcquiredGroceryProductsPage(opts: {
    offset: number;
    pageSize: number;
  }): Promise<{ rows: GroceryProductView[]; hasMore: boolean }> {
    return groceryApi.listAcquiredGroceryProductsPage(this.client, opts);
  }

  async listGroceryProductsPage(opts: {
    offset: number;
    pageSize: number;
    query?: string;
    onList?: boolean;
    sectionId?: string | 'other';
    manualOnly?: boolean;
  }): Promise<{ rows: GroceryProductView[]; hasMore: boolean }> {
    return groceryApi.listGroceryProductsPage(this.client, opts);
  }

  async searchGrocerySuggestions(
    query: string,
    limit: number
  ): Promise<GroceryProductView[]> {
    return groceryApi.searchGrocerySuggestions(this.client, query, limit);
  }

  async listGroceryProductsForRecipe(
    recipeId: string
  ): Promise<GroceryProductView[]> {
    return groceryApi.listGroceryProductsForRecipe(this.client, recipeId);
  }

  async createGroceryProduct(input: {
    name: string;
    count?: string | null;
    unit?: string | null;
    note?: string | null;
    section_id?: string | null;
    recipe_id?: string | null;
    image_id?: string | null;
  }): Promise<GroceryProduct> {
    return groceryApi.createGroceryProduct(this.client, input);
  }

  async updateGroceryProduct(
    id: string,
    patch: GroceryProductPatch
  ): Promise<void> {
    return groceryApi.updateGroceryProduct(this.client, id, patch);
  }

  async updateGroceryListEntry(
    entryId: string,
    patch: GroceryEntryPatch
  ): Promise<void> {
    return groceryApi.updateGroceryListEntry(this.client, entryId, patch);
  }

  async setProductOnList(
    productId: string,
    on: boolean,
    qty?: { count?: string | null; unit?: string | null }
  ): Promise<void> {
    return groceryApi.setProductOnList(this.client, productId, on, qty);
  }

  async autoFileGroceryProduct(id: string, sectionId: string): Promise<void> {
    return groceryApi.autoFileGroceryProduct(this.client, id, sectionId);
  }

  async listSectionExampleProducts(
    limit: number
  ): Promise<Array<{ name: string; section_id: string }>> {
    return groceryApi.listSectionExampleProducts(this.client, limit);
  }

  async removeProductFromList(productId: string): Promise<void> {
    return groceryApi.removeProductFromList(this.client, productId);
  }

  async deleteGroceryProduct(id: string): Promise<void> {
    return groceryApi.deleteGroceryProduct(this.client, id);
  }

  async upsertGroceryItemImage(
    sha256: string,
    mimeType: string,
    sizeBytes: number,
    dataBase64: string
  ): Promise<string> {
    return groceryApi.upsertGroceryItemImage(
      this.client,
      sha256,
      mimeType,
      sizeBytes,
      dataBase64
    );
  }

  // Not part of the cookbook slice: intents are their own domain, this
  // method just happens to live in this stretch of the file. It keeps
  // its inline implementation until the intents group gets a slice.

  /**
   * Every intent row for the inspector (the read-only "surfaced"
   * surface). RLS scopes to the signed-in user. Includes retired rows -
   * the inspector shows the full history (what Nak let go of), so no
   * status filter here; the modal groups them. Ordered by recency.
   */
  async listIntents(): Promise<IntentRow[]> {
    const { data, error } = await this.client
      .from('intents')
      .select(
        'id, statement, rationale, status, target_kind, target_ref, target_direction, efficacy, created_at, updated_at, last_minted_at',
      )
      .order('updated_at', { ascending: false });
    if (error) throw new SupabaseError(error.message);
    return (data ?? []) as IntentRow[];
  }

  /**
   * Every followup row for the inspector (the follow-ups half of the
   * seedling modal). Same read-only contract and same straggler status
   * as listIntents above. Includes closed rows - the modal shows the
   * history, collapsed to a preview per group with the hidden count on
   * the disclosure button ($lib/ui/history-disclosure). No row cap here:
   * a fetch-side cap silently drops the tail, so the button's count
   * would understate how much history exists, which is exactly the
   * dishonesty the collapsed view is built to avoid. Render cost is
   * bounded by the disclosure instead.
   */
  async listFollowups(): Promise<FollowupInspectorRow[]> {
    const { data, error } = await this.client
      .from('followups')
      .select(
        'id, question, context, status, relevant_after, resolution, created_at, updated_at',
      )
      .order('updated_at', { ascending: false });
    if (error) throw new SupabaseError(error.message);
    return (data ?? []) as FollowupInspectorRow[];
  }

  // User wiki -------------------------------------------------------------

  // --- Wiki articles ---------------------------------------------------
  //
  // Extracted domain slice: the implementations and their doc comments
  // live in ./supabase/wiki.ts (article listing / paging / fetch /
  // favorites / CRUD) as plain functions taking the client. The dated
  // records that sat under this banner moved with their files and
  // links to ./supabase/wiki-records.ts - see the record banners
  // below. These methods delegate one-for-one under the same names so
  // call sites and grep targets stay stable.

  async listWikiArticles(opts: { limit?: number } = {}): Promise<WikiArticle[]> {
    return wikiApi.listWikiArticles(this.client, opts);
  }

  async listWikiArticlesPage(opts: {
    offset: number;
    pageSize: number;
  }): Promise<OffsetPage<WikiArticle>> {
    return wikiApi.listWikiArticlesPage(this.client, opts);
  }

  async getWikiArticleById(id: string): Promise<WikiArticle | null> {
    return wikiApi.getWikiArticleById(this.client, id);
  }

  async listFavoriteWikiArticles(): Promise<WikiArticle[]> {
    return wikiApi.listFavoriteWikiArticles(this.client);
  }

  async setWikiArticleFavorite(id: string, favorite: boolean): Promise<void> {
    return wikiApi.setWikiArticleFavorite(this.client, id, favorite);
  }

  async createWikiArticle(args: {
    title: string;
    content: string;
  }): Promise<WikiArticle> {
    return wikiApi.createWikiArticle(this.client, args);
  }

  async updateWikiArticle(
    id: string,
    patch: { title?: string; content?: string }
  ): Promise<WikiArticle> {
    return wikiApi.updateWikiArticle(this.client, id, patch);
  }

  async deleteWikiArticle(id: string): Promise<void> {
    return wikiApi.deleteWikiArticle(this.client, id);
  }

  // Wiki records ---------------------------------------------------------
  //
  // Extracted domain slice: record CRUD, filtering, and the
  // cross-article search live in ./supabase/wiki-records.ts, along
  // with the private changelog-append helpers every record / file /
  // link mutation runs through. These methods delegate one-for-one
  // under the same names.

  async listWikiRecords(
    articleId: string,
    filters: { fromDate?: string; toDate?: string; tags?: string[]; limit?: number } = {}
  ): Promise<WikiRecord[]> {
    return wikiRecordsApi.listWikiRecords(this.client, articleId, filters);
  }

  async getWikiRecord(id: string): Promise<WikiRecord | null> {
    return wikiRecordsApi.getWikiRecord(this.client, id);
  }

  async createWikiRecord(args: {
    articleId: string;
    date: string;
    content: string;
    tags?: string[];
    sourceConversationId?: string | null;
  }): Promise<WikiRecord> {
    return wikiRecordsApi.createWikiRecord(this.client, args);
  }

  async updateWikiRecord(
    id: string,
    patch: { date?: string; content?: string; tags?: string[] }
  ): Promise<WikiRecord> {
    return wikiRecordsApi.updateWikiRecord(this.client, id, patch);
  }

  async deleteWikiRecord(id: string): Promise<void> {
    return wikiRecordsApi.deleteWikiRecord(this.client, id);
  }

  async searchWikiRecords(opts: {
    query: string;
    queryEmbedding: number[] | null;
    limit?: number;
  }): Promise<WikiRecord[]> {
    return wikiRecordsApi.searchWikiRecords(this.client, opts);
  }

  // --- wiki record files -----------------------------------------------
  //
  // Extracted domain slice: implementations live in
  // ./supabase/wiki-records.ts under the same banner.

  async listWikiRecordFiles(recordId: string): Promise<WikiRecordFile[]> {
    return wikiRecordsApi.listWikiRecordFiles(this.client, recordId);
  }

  async createWikiRecordFileSignedUrls(
    files: readonly Pick<WikiRecordFile, 'id' | 'storage_path'>[],
    expiresInSeconds = 3600
  ): Promise<Map<string, string>> {
    return wikiRecordsApi.createWikiRecordFileSignedUrls(this.client, files, expiresInSeconds);
  }

  async downloadWikiRecordFileBlob(storagePath: string): Promise<Blob> {
    return wikiRecordsApi.downloadWikiRecordFileBlob(this.client, storagePath);
  }

  async uploadAndAttachWikiRecordFile(args: {
    recordId: string;
    articleId: string;
    recordDate: string;
    position: number;
    filename: string;
    mimeType: string | null;
    sizeBytes: number | null;
    dataBase64: string;
    extractedText?: string | null;
  }): Promise<WikiRecordFile> {
    return wikiRecordsApi.uploadAndAttachWikiRecordFile(this.client, args);
  }

  async deleteWikiRecordFile(id: string): Promise<void> {
    return wikiRecordsApi.deleteWikiRecordFile(this.client, id);
  }

  // --- wiki record links -----------------------------------------------
  //
  // Extracted domain slice: implementations live in
  // ./supabase/wiki-records.ts under the same banner.

  async listWikiRecordLinks(recordId: string): Promise<WikiRecordLinkView[]> {
    return wikiRecordsApi.listWikiRecordLinks(this.client, recordId);
  }

  async createWikiRecordLink(args: {
    fromRecordId: string;
    toRecordId: string;
    label?: string | null;
  }): Promise<WikiRecordLink> {
    return wikiRecordsApi.createWikiRecordLink(this.client, args);
  }

  async deleteWikiRecordLink(args: {
    fromRecordId: string;
    toRecordId: string;
  }): Promise<void> {
    return wikiRecordsApi.deleteWikiRecordLink(this.client, args);
  }

  // --- Library / documents ---------------------------------------------
  //
  // Extracted domain slice: the implementations and their doc comments
  // (including the two-phase upload flow rationale and the note on the
  // server-side grep/read pair) live in ./supabase/documents.ts
  // (document CRUD + Library paging/search + bucket helpers) as plain
  // functions taking the client. These methods delegate one-for-one
  // under the same names so call sites and grep targets stay stable.

  async createDocument(args: {
    title: string;
    description?: string;
    filename: string;
    mimeType: string;
    sizeBytes: number;
  }): Promise<Document> {
    return documentsApi.createDocument(this.client, args);
  }

  async setDocumentStoragePath(id: string, storagePath: string): Promise<void> {
    return documentsApi.setDocumentStoragePath(this.client, id, storagePath);
  }

  async setDocumentExtraction(
    id: string,
    result:
      | { status: 'done'; text: string }
      | { status: 'failed'; error: string }
  ): Promise<void> {
    return documentsApi.setDocumentExtraction(this.client, id, result);
  }

  async listDocumentsPage(opts: {
    offset: number;
    pageSize: number;
  }): Promise<OffsetPage<Document>> {
    return documentsApi.listDocumentsPage(this.client, opts);
  }

  async getDocumentById(id: string): Promise<Document | null> {
    return documentsApi.getDocumentById(this.client, id);
  }

  async searchDocuments(opts: { query: string; limit?: number }): Promise<Document[]> {
    return documentsApi.searchDocuments(this.client, opts);
  }

  async updateDocument(
    id: string,
    patch: { title?: string; description?: string }
  ): Promise<Document> {
    return documentsApi.updateDocument(this.client, id, patch);
  }

  async deleteDocument(id: string): Promise<void> {
    return documentsApi.deleteDocument(this.client, id);
  }

  async uploadDocumentFile(args: {
    documentId: string;
    filename: string;
    file: Blob;
    contentType: string;
  }): Promise<string> {
    return documentsApi.uploadDocumentFile(this.client, args);
  }

  async createDocumentDownloadUrl(storagePath: string, expiresInSeconds = 300): Promise<string> {
    return documentsApi.createDocumentDownloadUrl(this.client, storagePath, expiresInSeconds);
  }

  // --- Wiki sources, changelog & agent runs ----------------------------
  //
  // Extracted domain slices: the bibliography / See-Also / changelog
  // reads live in ./supabase/wiki-sources.ts (wiki-article satellite
  // tables); the run/retry routes into the venice function, the
  // Skipped-panel read, and the pipeline reset live in
  // ./supabase/agent-runs.ts. These methods delegate one-for-one
  // under the same names. searchWikiArticles delegates to the article
  // slice (./supabase/wiki.ts) - it queries the wiki_articles table
  // itself, so it lives with the article CRUD, not either of these
  // two.

  async listWikiArticleSources(articleId: string): Promise<WikiArticleSource[]> {
    return wikiSourcesApi.listWikiArticleSources(this.client, articleId);
  }

  async listSourceThreadIdsForArticles(
    articleIds: readonly string[]
  ): Promise<Map<string, Set<string>>> {
    return wikiSourcesApi.listSourceThreadIdsForArticles(this.client, articleIds);
  }

  async findRelatedWikiArticles(
    articleId: string,
    limit = 5
  ): Promise<WikiArticleRelated[]> {
    return wikiSourcesApi.findRelatedWikiArticles(this.client, articleId, limit);
  }

  async createWikiChangelogEntry(args: {
    article_id: string | null;
    kind: WikiChangelogKind;
    title_at_change: string;
    message: string;
    chars_before?: number;
    chars_after?: number;
  }): Promise<void> {
    return wikiSourcesApi.createWikiChangelogEntry(this.client, args);
  }

  async listWikiChangelog(opts: {
    limit?: number;
    before?: string | null;
  } = {}): Promise<WikiChangelogEntry[]> {
    return wikiSourcesApi.listWikiChangelog(this.client, opts);
  }

  async listConversationDigests(opts: {
    limit?: number;
    before?: string | null;
  } = {}): Promise<ConversationDigest[]> {
    return digestsApi.listConversationDigests(this.client, opts);
  }

  async resetWikiData(): Promise<void> {
    return agentRunsApi.resetWikiData(this.client);
  }

  async searchWikiArticles(opts: {
    query: string;
    queryEmbedding: number[] | null;
    limit?: number;
  }): Promise<WikiArticle[]> {
    return wikiApi.searchWikiArticles(this.client, opts);
  }

  // Wiki background pipeline ---------------------------------------------
  //
  // Extracted domain slice: implementations live in
  // ./supabase/agent-runs.ts.

  async listWikiSkippedThreads(): Promise<
    {
      threadId: string;
      title: string | null;
      lastSkipAt: string;
      lastSkipReason: string | null;
      retrying: boolean;
    }[]
  > {
    return agentRunsApi.listWikiSkippedThreads(this.client);
  }

  async retryWikiThread(threadId: string): Promise<WikiRetryResult> {
    return agentRunsApi.retryWikiThread(this.client, threadId);
  }

  async runWikiManualUpdate(args: {
    articleId: string;
    instructions: string;
  }): Promise<WikiManualUpdateResult> {
    return agentRunsApi.runWikiManualUpdate(this.client, args);
  }

  async runWikiLibrarian(args: {
    instructions: string | null;
    runId: string;
  }): Promise<void> {
    return agentRunsApi.runWikiLibrarian(this.client, args);
  }

  async runRem(args: { runId: string }): Promise<void> {
    return agentRunsApi.runRem(this.client, args);
  }

  async runDeepSleep(args: { runId: string }): Promise<void> {
    return agentRunsApi.runDeepSleep(this.client, args);
  }

  // Thread response claim --------------------------------------------------
  //
  // Per-thread cross-device claim used by the chat-loop to mark "this
  // device is producing the response right now." Observer devices see
  // the claim on the threads realtime channel and gate their composer
  // accordingly. See `acquire_thread_response_claim` and siblings in
  // `supabase/schema.sql` for the atomic semantics, and
  // `ThreadClaimCoordinator` in `src/lib/exchange/thread-claim-coordinator.ts`
  // for the heartbeat-loop wrapper.
  //
  // Distinct from the worker_leases above: those are user-level
  // singletons partitioned by `workerKind`; these are per-thread,
  // keyed on the thread row itself.

  // --- Thread response claims ------------------------------------------
  //
  // Extracted domain slice: the implementations and their doc comments
  // live in ./supabase/threads.ts under its "Thread response claims"
  // banner - the claims are thread-scoped, so they ride the threads
  // slice. These methods delegate one-for-one under the same names.

  async acquireThreadResponseClaim(
    threadId: string,
    holderId: string,
    ttlSeconds: number
  ): Promise<boolean> {
    return threadsApi.acquireThreadResponseClaim(this.client, threadId, holderId, ttlSeconds);
  }

  async heartbeatThreadResponseClaim(
    threadId: string,
    holderId: string,
    ttlSeconds: number
  ): Promise<boolean> {
    return threadsApi.heartbeatThreadResponseClaim(this.client, threadId, holderId, ttlSeconds);
  }

  async releaseThreadResponseClaim(threadId: string, holderId: string): Promise<void> {
    return threadsApi.releaseThreadResponseClaim(this.client, threadId, holderId);
  }

  // --- Topic vocabularies ----------------------------------------------
  //
  // Extracted domain slice: the implementations and their doc comments
  // live in ./supabase/topics.ts (the list_user_*_topics RPC wrappers)
  // as plain functions taking the client. These methods delegate
  // one-for-one under the same names.

  async listUserTopics(): Promise<TopicVocabulary> {
    return topicsApi.listUserTopics(this.client);
  }

  async listUserMemoryTopics(): Promise<TopicVocabulary> {
    return topicsApi.listUserMemoryTopics(this.client);
  }

  async listUserRecipeTopics(): Promise<TopicVocabulary> {
    return topicsApi.listUserRecipeTopics(this.client);
  }

  // --- Memory confidence, search & relations ---------------------------
  //
  // Extracted domain slice: the implementations and their doc comments
  // live in ./supabase/memories.ts (under this group's banner, below
  // the memory CRUD) as plain functions taking the client. These
  // methods delegate one-for-one under the same names.

  async reaffirmMemoryConfidence(id: string): Promise<number | null> {
    return memoriesApi.reaffirmMemoryConfidence(this.client, id);
  }

  async doubtMemoryConfidence(id: string): Promise<number | null> {
    return memoriesApi.doubtMemoryConfidence(this.client, id);
  }

  async searchMemoriesByEmbedding(
    queryEmbedding: number[],
    limit: number
  ): Promise<Memory[]> {
    return memoriesApi.searchMemoriesByEmbedding(this.client, queryEmbedding, limit);
  }

  async searchSimilarMemories(
    memoryId: string,
    limit: number
  ): Promise<SimilarMemory[]> {
    return memoriesApi.searchSimilarMemories(this.client, memoryId, limit);
  }

  async createMemoryRelation(
    fromId: string,
    toId: string,
    kind: MemoryRelation['kind'],
    note: string | null
  ): Promise<{ id: string; kind: MemoryRelation['kind'] }> {
    return memoriesApi.createMemoryRelation(this.client, fromId, toId, kind, note);
  }

  async deleteMemoryRelation(id: string): Promise<void> {
    return memoriesApi.deleteMemoryRelation(this.client, id);
  }

  async listMemoryRelationsFor(ids: string[]): Promise<MemoryRelation[]> {
    return memoriesApi.listMemoryRelationsFor(this.client, ids);
  }

  async searchUnembeddedMemoriesByText(
    query: string,
    limit: number,
    selectedTopics: readonly string[] = []
  ): Promise<Memory[]> {
    return memoriesApi.searchUnembeddedMemoriesByText(
      this.client,
      query,
      limit,
      selectedTopics
    );
  }

  // --- Messages & attachments ------------------------------------------
  //
  // Extracted domain slice: the implementations and their doc comments
  // (including the attachment bucket-storage rationale and the
  // interrupted-exchange recovery note on listMessages) live in
  // ./supabase/messages.ts (message read/write + attachment storage)
  // and ./supabase/attachment-pages.ts (the rasterized PDF page renders)
  // as plain functions taking the client. These methods delegate
  // one-for-one under the same names so call sites and grep targets
  // stay stable.

  async listMessages(threadId: string): Promise<Message[]> {
    return messagesApi.listMessages(this.client, threadId);
  }

  async listAttachmentsByMessageIds(
    messageIds: string[]
  ): Promise<Map<string, Attachment[]>> {
    return messagesApi.listAttachmentsByMessageIds(this.client, messageIds);
  }

  async addAttachments(
    messageId: string,
    rows: NewAttachment[]
  ): Promise<Attachment[]> {
    return messagesApi.addAttachments(this.client, messageId, rows);
  }

  /**
   * Upload the rasterized pages of one already-persisted attachment. Called
   * after `addAttachments` returns, since the rows FK to the attachment id.
   * Resolves the caller's user id here because the object key's leading
   * folder must be it - the bucket's RLS policy keys on that prefix.
   */
  async addAttachmentPages(
    attachmentId: string,
    pages: readonly RenderedPdfPage[]
  ): Promise<number> {
    const session = await this.getSession();
    if (!session) throw new SupabaseError('Not authenticated.');
    return attachmentPagesApi.addAttachmentPages(
      this.client,
      session.user.id,
      attachmentId,
      pages
    );
  }

  async createAttachmentSignedUrls(
    attachments: readonly Pick<Attachment, 'id' | 'storage_path'>[],
    expiresInSeconds = 3600
  ): Promise<Map<string, string>> {
    return messagesApi.createAttachmentSignedUrls(this.client, attachments, expiresInSeconds);
  }

  async listArtifacts(opts: {
    offset: number;
    pageSize: number;
    query?: string;
    kind?: 'all' | 'image' | 'file';
    sort?: 'newest' | 'largest';
  }): Promise<{ rows: ArtifactListRow[]; hasMore: boolean }> {
    return messagesApi.listArtifacts(this.client, opts);
  }

  async deleteAttachment(attachmentId: string): Promise<void> {
    return messagesApi.deleteAttachment(this.client, attachmentId);
  }

  async findImageByFilenameInThread(
    threadId: string,
    filename: string
  ): Promise<Attachment | null> {
    return messagesApi.findImageByFilenameInThread(this.client, threadId, filename);
  }

  async listAttachmentSummariesForThread(
    threadId: string
  ): Promise<ThreadAttachmentSummary[]> {
    return messagesApi.listAttachmentSummariesForThread(this.client, threadId);
  }

  async addMessage(
    threadId: string,
    role: Message['role'],
    content: string,
    opts: {
      tool_calls?: OpenAIToolCall[] | null;
      tool_call_id?: string | null;
      name?: string | null;
      model?: string | null;
      usage?: TokenUsage | null;
      reasoning?: string | null;
      citations?: Citation[] | null;
      position?: number;
      status?: Message['status'];
    } = {}
  ): Promise<Message> {
    return messagesApi.addMessage(this.client, threadId, role, content, opts);
  }

  async updateToolMessageContent(
    threadId: string,
    toolCallId: string,
    content: string
  ): Promise<Message> {
    return messagesApi.updateToolMessageContent(this.client, threadId, toolCallId, content);
  }

  async promoteDraftMessage(messageId: string, content: string): Promise<Message> {
    return messagesApi.promoteDraftMessage(this.client, messageId, content);
  }

  async markSecondThoughtsActed(messageId: string): Promise<void> {
    return messagesApi.markSecondThoughtsActed(this.client, messageId);
  }

  // --- Realtime subscriptions & message fetch --------------------------
  //
  // Extracted domain slice: the implementations and their doc comments
  // (including the channel-defense and echo-dedupe notes on
  // subscribeToMessages, the private-Broadcast policy citations, and
  // the lease / last-run-outcome pairing rationale) live in
  // ./supabase/realtime.ts (subscribe* channels + their paired point
  // reads) as plain functions taking the client. These methods
  // delegate one-for-one under the same names so call sites and grep
  // targets stay stable.

  subscribeToMessages(
    threadId: string,
    onMessage: (msg: Message) => void
  ): () => void {
    return realtimeApi.subscribeToMessages(this.client, threadId, onMessage);
  }

  async getMessage(id: string): Promise<Message | null> {
    return realtimeApi.getMessage(this.client, id);
  }

  subscribeToThreads(
    userId: string,
    handlers: {
      onInsert?: (thread: Thread) => void;
      onUpdate?: (thread: Thread) => void;
      onDelete?: (id: string) => void;
    }
  ): () => void {
    return realtimeApi.subscribeToThreads(this.client, userId, handlers);
  }

  subscribeToUserLogs(
    userId: string,
    onEntry: (entry: SerializableLogEntry) => void
  ): () => void {
    return realtimeApi.subscribeToUserLogs(this.client, userId, onEntry);
  }

  async getInflightLeaseExpiry(
    userId: string,
    column: InflightLeaseColumn
  ): Promise<string | null> {
    return realtimeApi.getInflightLeaseExpiry(this.client, userId, column);
  }

  subscribeToInflightLease(
    userId: string,
    column: InflightLeaseColumn,
    onChange: (expiry: string | null) => void
  ): () => void {
    return realtimeApi.subscribeToInflightLease(this.client, userId, column, onChange);
  }

  async getLastRunOutcome(
    userId: string,
    column: LastRunOutcomeColumn
  ): Promise<ManualRunOutcome | null> {
    return realtimeApi.getLastRunOutcome(this.client, userId, column);
  }

  subscribeToLastRunOutcome(
    userId: string,
    column: LastRunOutcomeColumn,
    onOutcome: (outcome: ManualRunOutcome | null) => void
  ): () => void {
    return realtimeApi.subscribeToLastRunOutcome(this.client, userId, column, onOutcome);
  }

  subscribeToWikiArticleChanges(userId: string, onChange: () => void): () => void {
    return realtimeApi.subscribeToWikiArticleChanges(this.client, userId, onChange);
  }

  subscribeToWikiRecordChanges(userId: string, onChange: () => void): () => void {
    return realtimeApi.subscribeToWikiRecordChanges(this.client, userId, onChange);
  }

  subscribeToMemoryChanges(userId: string, onChange: () => void): () => void {
    return realtimeApi.subscribeToMemoryChanges(this.client, userId, onChange);
  }

  subscribeToRecipeChanges(userId: string, onChange: () => void): () => void {
    return realtimeApi.subscribeToRecipeChanges(this.client, userId, onChange);
  }

  subscribeToGroceryChanges(userId: string, onChange: () => void): () => void {
    return realtimeApi.subscribeToGroceryChanges(this.client, userId, onChange);
  }

  subscribeToSamskaraInserts(
    userId: string,
    onMint: (detail: { tier: 1 | 2; valence: number; confidence: number }) => void
  ): () => void {
    return realtimeApi.subscribeToSamskaraInserts(this.client, userId, onMint);
  }

  subscribeToAgentRunProgress(
    userId: string,
    onEvent: (event: AgentRunProgressEvent) => void
  ): () => void {
    return realtimeApi.subscribeToAgentRunProgress(this.client, userId, onEvent);
  }

  // --- Samskara --------------------------------------------------------
  //
  // Extracted domain slice: the implementations and their doc comments
  // live in ./supabase/samskara.ts as plain functions taking the
  // client. These methods delegate one-for-one under the same names so
  // call sites and grep targets stay stable. Row types live in
  // ./supabase/types/samskara.ts.

  async samskaraRecordSubstrate(
    threadId: string,
    userMessageId: string,
    assistantMessageId: string | null
  ): Promise<string> {
    return samskaraApi.samskaraRecordSubstrate(
      this.client,
      threadId,
      userMessageId,
      assistantMessageId
    );
  }

  async samskaraGetCompoundSummary(): Promise<{
    summary: string | null;
    lastRegenAt: string | null;
    samskaraCountAtRegen: number;
  } | null> {
    return samskaraApi.samskaraGetCompoundSummary(this.client);
  }

  async samskaraListSubstrateForThread(
    threadId: string
  ): Promise<SamskaraSubstrateDiagnosticRow[]> {
    return samskaraApi.samskaraListSubstrateForThread(this.client, threadId);
  }

  async samskaraGetLatestFireMood(
    threadId: string
  ): Promise<{ valence: number; tier: 1 | 2; confidence: number } | null> {
    return samskaraApi.samskaraGetLatestFireMood(this.client, threadId);
  }

  async samskaraListFiresForThread(
    threadId: string
  ): Promise<SamskaraFireDiagnosticRow[]> {
    return samskaraApi.samskaraListFiresForThread(this.client, threadId);
  }

  async samskaraClusterThreadFires(
    threadId: string,
    threshold = 0.7
  ): Promise<Map<string, { clusterSeq: number; clusterSize: number }>> {
    return samskaraApi.samskaraClusterThreadFires(this.client, threadId, threshold);
  }

  async listSamskarasPage(opts: {
    offset: number;
    pageSize: number;
    tier?: number | null;
    sort: SamskaraBrowseSort;
  }): Promise<OffsetPage<SamskaraCorpusRow>> {
    return samskaraApi.listSamskarasPage(this.client, opts);
  }

  async searchSamskarasByEmbedding(
    embedding: number[],
    kMax: number,
    tier?: number | null
  ): Promise<SamskaraCorpusRow[]> {
    return samskaraApi.searchSamskarasByEmbedding(this.client, embedding, kMax, tier);
  }

  async searchSamskarasByText(
    query: string,
    limit: number,
    tier?: number | null
  ): Promise<SamskaraCorpusRow[]> {
    return samskaraApi.searchSamskarasByText(this.client, query, limit, tier);
  }

  async samskaraClusterCorpus(
    threshold: number,
    tier?: number | null
  ): Promise<Map<string, { seq: number; size: number }>> {
    return samskaraApi.samskaraClusterCorpus(this.client, threshold, tier);
  }

  async samskaraProvenanceDetail(samskaraId: string): Promise<SamskaraProvenanceRow[]> {
    return samskaraApi.samskaraProvenanceDetail(this.client, samskaraId);
  }

  async samskaraHealthSnapshot(): Promise<SamskaraHealthSnapshot> {
    return samskaraApi.samskaraHealthSnapshot(this.client);
  }

  async samskaraRates(days: number): Promise<SamskaraRates> {
    return samskaraApi.samskaraRates(this.client, days);
  }

  async samskaraVerdictCounts(samskaraId: string): Promise<SamskaraVerdictCounts> {
    return samskaraApi.samskaraVerdictCounts(this.client, samskaraId);
  }

  async samskaraTier2CandidateSize(): Promise<number> {
    return samskaraApi.samskaraTier2CandidateSize(this.client);
  }

  // --- Bias profile ------------------------------------------------------
  //
  // Extracted domain slice: the implementations and their doc comments
  // (including the note that the per-turn bias writes moved server-side
  // into the venice edge function's priming pass) live in
  // ./supabase/bias.ts as plain functions taking the client. These
  // methods delegate one-for-one under the same names so call sites
  // and grep targets stay stable.

  async biasListSummary(): Promise<
    {
      bias: string;
      effectiveN: number;
      posteriorAlpha: number;
      posteriorBeta: number;
      posteriorMean: number;
      ciLower: number;
      feedbackScore: number;
      tier: 'elided' | 'soft' | 'strong';
      computedAt: string;
    }[]
  > {
    return biasApi.biasListSummary(this.client);
  }

  async biasListObservationCounts(): Promise<Record<string, number>> {
    return biasApi.biasListObservationCounts(this.client);
  }

  async biasListReactionsForThread(threadId: string): Promise<
    {
      id: string;
      bias: string;
      wasConfirmed: boolean | null;
      reasoning: string;
      createdAt: string;
    }[]
  > {
    return biasApi.biasListReactionsForThread(this.client, threadId);
  }

  async biasGetThreadProcessedAt(threadId: string): Promise<string | null> {
    return biasApi.biasGetThreadProcessedAt(this.client, threadId);
  }

  async biasListObservationsForThread(threadId: string): Promise<
    {
      id: string;
      bias: string;
      confidence: number;
      reasoning: string;
      evidenceMessageId: string | null;
      createdAt: string;
    }[]
  > {
    return biasApi.biasListObservationsForThread(this.client, threadId);
  }

  async biasListObservationsForBiasKey(biasKey: string): Promise<
    {
      id: string;
      threadId: string;
      threadTitle: string | null;
      confidence: number;
      reasoning: string;
      createdAt: string;
    }[]
  > {
    return biasApi.biasListObservationsForBiasKey(this.client, biasKey);
  }

  async biasListProcessedThreads(limit: number = 30): Promise<
    {
      threadId: string;
      title: string;
      processedAt: string;
      observationCount: number;
    }[]
  > {
    return biasApi.biasListProcessedThreads(this.client, limit);
  }

  // --- MCP integrations -------------------------------------------------
  //
  // Extracted domain slice: the implementations and their doc comments
  // live in ./supabase/mcp.ts (the integrations list + cached tool-
  // catalog reads, plus the venice edge-function proxy calls that drive
  // the OAuth flow) as plain functions taking the client. These methods
  // delegate one-for-one under the same names so call sites and grep
  // targets stay stable. The browser never reads mcp_oauth_tokens -
  // token storage is edge-function-only.

  async listMcpIntegrations(): Promise<McpIntegration[]> {
    return mcpApi.listMcpIntegrations(this.client);
  }

  async listMcpToolSchemas(): Promise<McpToolSchema[]> {
    return mcpApi.listMcpToolSchemas(this.client);
  }

  async deleteMcpIntegration(integrationId: string): Promise<void> {
    return mcpApi.deleteMcpIntegration(this.client, integrationId);
  }

  async invokeMcpDiscover(serverUrl: string): Promise<McpDiscoveredMetadata> {
    return mcpApi.invokeMcpDiscover(this.client, serverUrl);
  }

  async invokeMcpRegister(
    serverUrl: string,
    redirectUri: string,
    label: string,
    integrationId?: string | null,
    clientId?: string | null,
  ): Promise<McpRegisterResult> {
    return mcpApi.invokeMcpRegister(this.client, serverUrl, redirectUri, label, integrationId, clientId);
  }

  async invokeMcpTokenExchange(
    integrationId: string,
    code: string,
    codeVerifier: string,
    state: string,
    redirectUri: string
  ): Promise<McpTokenExchangeResult> {
    return mcpApi.invokeMcpTokenExchange(
      this.client,
      integrationId,
      code,
      codeVerifier,
      state,
      redirectUri
    );
  }

  async invokeMcpRefresh(integrationId: string): Promise<McpTokenExchangeResult> {
    return mcpApi.invokeMcpRefresh(this.client, integrationId);
  }

  async invokeMcpDisconnect(integrationId: string): Promise<void> {
    return mcpApi.invokeMcpDisconnect(this.client, integrationId);
  }
}
