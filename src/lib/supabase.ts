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
import {
  createLogger,
  type SerializableLogEntry,
} from './logger.svelte';

const log = createLogger('supabase');
import type { OpenAIToolCall } from './tools/types';
import type {
  ChatCompletion,
  ChatRequest,
  Citation,
  EmbeddingRequest,
  EmbeddingResponse,
  TokenUsage,
} from './venice';
import type { UsageRequestOptions, UsageModelBucket } from './usage';
import { synthesizeRecoveryMessages } from './conversation-recovery';
import { SupabaseError } from './supabase/error';
import { base64ToBytes } from './supabase/query-utils';
// Agent-runs domain slice (the wiki/rem/deep-sleep run + retry
// routes), same delegation pattern as the slices below.
import * as agentRunsApi from './supabase/agent-runs';
// Cookbook domain slice (recipes, versions, photos), same delegation
// pattern.
import * as cookbookApi from './supabase/cookbook';
// Library / documents domain slice (document CRUD, Library paging and
// search, bucket upload + signed download URLs), same delegation
// pattern.
import * as documentsApi from './supabase/documents';
// Memories domain slice: the facade's memory methods (both the CRUD +
// changelog group and the confidence / search / relations group)
// delegate to these plain functions one-for-one under the same names
// (see the class preamble for the slice pattern).
import * as memoriesApi from './supabase/memories';
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
  WikiRetryResult,
  WikiManualUpdateResult,
  Recipe,
  RecipeVersion,
  RecipePhoto,
  RecipePhotoInput,
  Document,
  UserSettings,
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
} from './supabase/types';
import {
  coerceAttachmentRow,
  coerceManualRunOutcome,
} from './supabase/types';
import type { IntentRow } from './ui/intents-inspector';

/**
 * The browser's single handle on the user's Supabase project. One class,
 * ~160 methods, grouped by domain with `// --- <group> ---` banners in
 * declaration order. Grep a banner to jump to its block:
 *
 *   Auth & session            sign-in / out, session, password
 *   Settings & Venice proxies user settings + the /complete, /embed,
 *                             /usage, /models, /generate-image, text
 *                             extraction edge-function calls
 *   Threads                   list / search / CRUD / per-thread setters
 *   Memories                  memory CRUD + changelog + paging
 *   Cookbook                  recipes, versions, photos
 *   Wiki articles             article CRUD + paging
 *   Library / documents       document CRUD, upload, grep, stat
 *   Wiki sources, changelog & agent runs
 *                             bibliography, See-Also, changelog, the
 *                             wiki/rem/deep-sleep run + retry routes
 *   Thread response claims    cross-device "responding here" claim
 *   Topic vocabularies        list_user_*_topics
 *   Memory confidence, search & relations
 *                             reaffirm/doubt, embedding search, graph
 *   Messages & attachments    message read/write, attachment storage
 *   Realtime subscriptions & message fetch
 *                             subscribe* + getMessage + inflight lease
 *   Samskara                  fire / substrate / health / clustering
 *   Bias profile              bias summary + observations + reactions
 *
 * Row types and their coercers live in ./supabase/types/*; this file
 * keeps the class plus its query/util helpers.
 *
 * Domain-slice extraction: query implementations are moving out of
 * this class into plain-function modules under ./supabase/<domain>.ts
 * (first argument: the SupabaseClient), with this class keeping
 * one-line delegating methods under unchanged names. Callers never
 * change; the slices are unit-testable against a stubbed client. The
 * Samskara (./supabase/samskara.ts), Settings (./supabase/settings.ts),
 * Venice-proxy (./supabase/venice-proxy.ts), Threads incl. the
 * response claims (./supabase/threads.ts), Topic-vocabulary
 * (./supabase/topics.ts), Memories incl. confidence / search /
 * relations (./supabase/memories.ts), Cookbook - recipes, versions,
 * photos (./supabase/cookbook.ts), Wiki articles (./supabase/wiki.ts),
 * Wiki records incl. files + links (./supabase/wiki-records.ts),
 * Wiki satellites - bibliography, See-Also, changelog
 * (./supabase/wiki-sources.ts), Agent runs - the wiki/rem/
 * deep-sleep run + retry routes (./supabase/agent-runs.ts), and
 * Library / documents (./supabase/documents.ts) -
 * groups are extracted; the remaining groups still carry their
 * implementations inline and should follow the same pattern when
 * touched substantially.
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

  async fetchUsage(opts: UsageRequestOptions = {}): Promise<UsageModelBucket[]> {
    return veniceProxyApi.fetchUsage(this.client, opts);
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
  }): Promise<void> {
    return wikiSourcesApi.createWikiChangelogEntry(this.client, args);
  }

  async listWikiChangelog(opts: {
    limit?: number;
    before?: string | null;
  } = {}): Promise<WikiChangelogEntry[]> {
    return wikiSourcesApi.listWikiChangelog(this.client, opts);
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

  async listMessages(threadId: string): Promise<Message[]> {
    const { data, error } = await this.client
      .from('messages')
      .select('*')
      .eq('thread_id', threadId)
      .order('created_at', { ascending: true });
    if (error) throw new SupabaseError(error.message);
    const messages = (data ?? []) as Message[];
    // Hydrate attachments in a second query keyed by message id. Keeps
    // the base SELECT cheap (no large base64 payloads on the wire for
    // rows without attachments, which is the common case) and lets
    // the realtime subscribe path reuse the same hydration helper
    // later.
    // User rows carry uploads; assistant rows carry generate_image
    // output (attached at end of turn by the chat-loop). Both hydrate
    // through the same query; tool / system rows never carry
    // attachments so they're left out to keep the IN-list small.
    const attachableIds = messages
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => m.id);
    if (attachableIds.length > 0) {
      const attachmentsByMessageId = await this.listAttachmentsByMessageIds(attachableIds);
      for (const m of messages) {
        if (m.role === 'user' || m.role === 'assistant') {
          m.attachments = attachmentsByMessageId.get(m.id) ?? [];
        }
      }
    }
    // Repair an interrupted-exchange tail in memory so every reader -
    // chat UI, summary worker, reflection worker, recall agents,
    // samskara worker, wiki worker - sees a wire-format-valid
    // sequence. The synthesized rows ride through the wire projection
    // like normal rows; the chat-loop's send path persists them ahead
    // of the next user turn so the DB heals on revisit. See
    // lib/conversation-recovery.ts for the cases handled.
    return synthesizeRecoveryMessages(messages);
  }

  /**
   * Fetch every attachment belonging to the given user-message ids, in
   * one round trip. Returns a map keyed by `message_id` so the caller
   * can hang the array straight onto each message. Ordered by
   * `position` within each bucket so the message renderer doesn't have
   * to re-sort.
   *
   * Used by `listMessages` for the initial load and by the realtime
   * subscription path when a user row arrives with attachments.
   */
  async listAttachmentsByMessageIds(
    messageIds: string[]
  ): Promise<Map<string, Attachment[]>> {
    const result = new Map<string, Attachment[]>();
    if (messageIds.length === 0) return result;
    // Bytes are NOT projected - they live in the `attachments` bucket
    // (pointed at by storage_path) and are fetched on demand via a
    // signed URL. Thread load carries metadata only, so a thread full of
    // images no longer ships megabytes of base64 on every open.
    const { data, error } = await this.client
      .from('message_attachments')
      .select(
        'id, message_id, position, filename, mime_type, size_bytes, storage_path, extracted_text, expired_at, created_at'
      )
      .in('message_id', messageIds)
      .order('position', { ascending: true });
    if (error) throw new SupabaseError(error.message);
    for (const row of (data ?? []) as Attachment[]) {
      const existing = result.get(row.message_id) ?? [];
      existing.push({
        id: row.id,
        message_id: row.message_id,
        position: row.position,
        filename: row.filename,
        mime_type: row.mime_type,
        size_bytes: row.size_bytes,
        storage_path: typeof row.storage_path === 'string' ? row.storage_path : null,
        extracted_text: row.extracted_text,
        expired_at: row.expired_at,
        created_at: row.created_at,
      });
      result.set(row.message_id, existing);
    }
    return result;
  }

  /**
   * Bulk-insert attachments for a just-written message. For each row we
   * mint the attachment id client-side, upload its bytes to the
   * `attachments` bucket at `<user_id>/<id>/<filename>`, then insert the
   * row carrying `storage_path` (never the bytes). Client-minted ids let
   * the upload and the insert reference the same path in one pass.
   *
   * Returns the hydrated rows (with `storage_path` set, bytes left in the
   * bucket) so the caller can append them to the in-memory message; the
   * UI fetches a signed URL when it needs to render them.
   */
  async addAttachments(
    messageId: string,
    rows: NewAttachment[]
  ): Promise<Attachment[]> {
    if (rows.length === 0) return [];
    const session = await this.getSession();
    if (!session) throw new SupabaseError('Not authenticated.');
    const userId = session.user.id;

    const prepared = await Promise.all(
      rows.map(async (r) => {
        const id = crypto.randomUUID();
        const path = `${userId}/${id}/${r.filename}`;
        const { error: upErr } = await this.client.storage
          .from('attachments')
          .upload(path, base64ToBytes(r.data_base64), {
            contentType: r.mime_type,
            upsert: true,
          });
        if (upErr) throw new SupabaseError(upErr.message);
        return {
          id,
          message_id: messageId,
          position: r.position,
          filename: r.filename,
          mime_type: r.mime_type,
          size_bytes: r.size_bytes,
          storage_path: path,
          extracted_text: r.extracted_text,
        };
      })
    );

    const { data, error } = await this.client
      .from('message_attachments')
      .insert(prepared)
      .select(
        'id, message_id, position, filename, mime_type, size_bytes, storage_path, extracted_text, expired_at, created_at'
      );
    if (error) throw new SupabaseError(error.message);
    return ((data ?? []) as Attachment[]).map((row) => ({
      id: row.id,
      message_id: row.message_id,
      position: row.position,
      filename: row.filename,
      mime_type: row.mime_type,
      size_bytes: row.size_bytes,
      storage_path: typeof row.storage_path === 'string' ? row.storage_path : null,
      extracted_text: row.extracted_text,
      expired_at: row.expired_at,
      created_at: row.created_at,
    }));
  }

  /**
   * A short-lived signed URL per attachment id, for rendering image
   * previews / download links and for handing image bytes to Venice (its
   * vision input fetches public URLs). Skips expired attachments
   * (storage_path null). Batched into one Storage call. Best-effort: an
   * attachment whose signed URL can't be minted is simply omitted from
   * the map rather than failing the whole batch.
   */
  async createAttachmentSignedUrls(
    attachments: readonly Pick<Attachment, 'id' | 'storage_path'>[],
    expiresInSeconds = 3600
  ): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const live = attachments.filter(
      (a): a is { id: string; storage_path: string } => typeof a.storage_path === 'string'
    );
    if (live.length === 0) return out;
    const { data, error } = await this.client.storage
      .from('attachments')
      .createSignedUrls(
        live.map((a) => a.storage_path),
        expiresInSeconds
      );
    if (error) throw new SupabaseError(error.message);
    const urlByPath = new Map<string, string>();
    for (const entry of data ?? []) {
      if (entry.signedUrl && typeof entry.path === 'string') {
        urlByPath.set(entry.path, entry.signedUrl);
      }
    }
    for (const a of live) {
      const url = urlByPath.get(a.storage_path);
      if (url) out.set(a.id, url);
    }
    return out;
  }

  /**
   * Page through the signed-in user's LIVE attachments across every
   * conversation, for the Artifacts management tab. Joins each attachment
   * to its owning thread's title so the list can show (and link to) the
   * conversation a file lives in. Filterable by filename substring and by
   * kind (image vs other), orderable newest- or largest-first.
   *
   * Only live rows (non-null `storage_path`) are returned - an
   * already-deleted attachment has no object to manage. RLS scopes the
   * whole query to the caller via the attachment -> message -> thread
   * chain, so the embedded `messages`/`threads` resolve only the user's
   * own rows.
   *
   * Fetches one extra row past `pageSize` to compute `hasMore` without a
   * separate count query.
   */
  async listArtifacts(opts: {
    offset: number;
    pageSize: number;
    query?: string;
    kind?: 'all' | 'image' | 'file';
    sort?: 'newest' | 'largest';
  }): Promise<{ rows: ArtifactListRow[]; hasMore: boolean }> {
    const { offset, pageSize, query, kind = 'all', sort = 'newest' } = opts;
    let q = this.client
      .from('message_attachments')
      // The `threads` embed is hinted with the FK constraint name
      // (`messages_thread_id_fkey`) because `messages` and `threads` are
      // joined by more than one relationship: `messages.thread_id ->
      // threads.id` (the one we want) plus six reverse cursor columns on
      // `threads` (last_reflected_msg_id, last_evaluated_msg_id,
      // last_summarised_msg_id, last_topics_msg_id, last_wiki_processed_msg_id,
      // last_wiki_record_processed_msg_id) that each reference messages.id.
      // Without the hint PostgREST can't choose and fails the whole query
      // with "more than one relationship was found for 'messages' and
      // 'threads'".
      .select(
        'id, filename, mime_type, size_bytes, storage_path, created_at, messages!inner(thread_id, threads!messages_thread_id_fkey!inner(title))'
      )
      .not('storage_path', 'is', null);
    const trimmed = (query ?? '').trim();
    // ilike wildcards in the user's text are escaped so a literal % or _
    // in a filename doesn't widen the match.
    if (trimmed.length > 0) {
      const escaped = trimmed.replace(/[%_\\]/g, '\\$&');
      q = q.ilike('filename', `%${escaped}%`);
    }
    if (kind === 'image') q = q.ilike('mime_type', 'image/%');
    else if (kind === 'file') q = q.not('mime_type', 'ilike', 'image/%');
    q =
      sort === 'largest'
        ? q.order('size_bytes', { ascending: false })
        : q.order('created_at', { ascending: false });
    q = q.range(offset, offset + pageSize);
    const { data, error } = await q;
    if (error) throw new SupabaseError(error.message);
    const raw = (data ?? []) as Array<{
      id: string;
      filename: string;
      mime_type: string;
      size_bytes: number;
      storage_path: string;
      created_at: string;
      // PostgREST returns a to-one embed as an object; older typings can
      // surface it as a single-element array, so accept either shape.
      messages?:
        | { thread_id: string; threads?: { title?: string } | { title?: string }[] | null }
        | { thread_id: string; threads?: { title?: string } | { title?: string }[] | null }[]
        | null;
    }>;
    const hasMore = raw.length > pageSize;
    const rows: ArtifactListRow[] = raw.slice(0, pageSize).map((r) => {
      const msg = Array.isArray(r.messages) ? r.messages[0] : r.messages;
      const thr = Array.isArray(msg?.threads) ? msg?.threads[0] : msg?.threads;
      return {
        id: r.id,
        filename: r.filename,
        mime_type: r.mime_type,
        size_bytes: r.size_bytes,
        storage_path: r.storage_path,
        created_at: r.created_at,
        thread_id: msg?.thread_id ?? '',
        thread_title: thr?.title ?? 'Untitled conversation',
      };
    });
    return { rows, hasMore };
  }

  /**
   * Delete one attachment from the Artifacts tab: mark the row expired
   * (null `storage_path` + stamp `expired_at`) so the conversation
   * re-renders the file as the greyed placeholder, then best-effort remove
   * the bucket object. The row is UPDATED, not deleted, so the message it
   * belongs to still reads sensibly (filename + extracted_text survive).
   *
   * Row-first ordering (the inverse of deleteMessages): nulling the path
   * first stops the row from referencing the object, so a Storage hiccup
   * can't strand a live row pointing at a deleted object - the daily
   * `attachment-gc` sweep reclaims the object if the remove below misses.
   * The "attachments are self-updatable via thread" RLS policy scopes the
   * update to the caller's own rows.
   */
  async deleteAttachment(attachmentId: string): Promise<void> {
    const { data, error: selErr } = await this.client
      .from('message_attachments')
      .select('storage_path')
      .eq('id', attachmentId)
      .maybeSingle();
    if (selErr) throw new SupabaseError(selErr.message);
    const path = (data as { storage_path: string | null } | null)?.storage_path ?? null;

    const { error: updErr } = await this.client
      .from('message_attachments')
      .update({ storage_path: null, expired_at: new Date().toISOString() })
      .eq('id', attachmentId);
    if (updErr) throw new SupabaseError(updErr.message);

    if (path) {
      // Swallowed on purpose: attachment-gc reclaims any object the remove
      // misses, and the row is already marked expired regardless.
      await this.client.storage.from('attachments').remove([path]);
    }
  }

  /**
   * Find the most recent image attachment in this thread whose filename
   * matches exactly. Returns the row regardless of expiry state - the
   * caller distinguishes "not found" (null return) from "expired"
   * (`data_base64 === null` on the returned row) and produces the right
   * diagnostic for the model.
   *
   * Why thread-scoped instead of message-scoped: the analyze_image tool
   * needs to reach images attached on prior turns of the same conversation,
   * not just the user message that opened the current turn. The earlier
   * design passed only the current message's attachments into ToolContext,
   * which left the model unable to re-analyze an image once the user sent
   * any follow-up message. RLS on `message_attachments` already scopes
   * access to the signed-in user via the via-parent-of-parent chain
   * (attachment -> message -> thread -> user_id), so the join here adds
   * thread filtering without weakening the security model.
   */
  async findImageByFilenameInThread(
    threadId: string,
    filename: string
  ): Promise<Attachment | null> {
    const { data, error } = await this.client
      .from('message_attachments')
      .select(
        'id, message_id, position, filename, mime_type, size_bytes, storage_path, extracted_text, expired_at, created_at, messages!inner(thread_id)'
      )
      .eq('messages.thread_id', threadId)
      .eq('filename', filename)
      .like('mime_type', 'image/%')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw new SupabaseError(error.message);
    if (!data) return null;
    return coerceAttachmentRow(data as Record<string, unknown>);
  }

  /**
   * Lightweight summary of every attachment in a thread, used to render
   * the `<thread_attachments>` system block in chat-loop. Omits
   * `extracted_text` (potentially huge) since the block only needs
   * filenames + categorisation.
   *
   * Live vs expired is read off `expired_at`: the expiry sweep stamps it
   * when it deletes an object, and the one-time legacy reclaim stamped it
   * on pre-bucket rows, so a non-null `expired_at` is equivalent to
   * `storage_path is null` here without projecting storage_path.
   */
  async listAttachmentSummariesForThread(
    threadId: string
  ): Promise<ThreadAttachmentSummary[]> {
    const { data, error } = await this.client
      .from('message_attachments')
      .select(
        'filename, mime_type, expired_at, created_at, messages!inner(thread_id)'
      )
      .eq('messages.thread_id', threadId)
      .order('created_at', { ascending: true });
    if (error) throw new SupabaseError(error.message);
    return ((data ?? []) as Array<{
      filename: string;
      mime_type: string;
      expired_at: string | null;
      created_at: string;
    }>).map((row) => ({
      filename: row.filename,
      mime_type: row.mime_type,
      is_image: row.mime_type.startsWith('image/'),
      expired: row.expired_at !== null,
      created_at: row.created_at,
    }));
  }

  /**
   * Insert one message row and touch the thread's updated_at in a
   * follow-up call. The two writes aren't in a transaction — if the
   * second call fails, we've still saved the message and the thread
   * just keeps its old ordering timestamp until the next activity.
   * That's intentional: losing the message would be a bigger regression
   * than a briefly stale sort order.
   *
   * The optional OpenAI-shape fields let assistant-with-tool-calls and
   * tool-result rows round-trip faithfully. `tool_calls` applies to
   * assistant rows that invoked tools; `tool_call_id` and `name` apply
   * to role='tool' rows pairing the assistant call to its result.
   */
  async addMessage(
    threadId: string,
    role: Message['role'],
    content: string,
    opts: {
      tool_calls?: OpenAIToolCall[] | null;
      tool_call_id?: string | null;
      name?: string | null;
      /** Concrete Venice model id that produced this assistant row. */
      model?: string | null;
      /** Token-usage object returned by the provider for this turn. */
      usage?: TokenUsage | null;
      /** Chain-of-thought text; null when the model didn't produce any. */
      reasoning?: string | null;
      /** Venice web-search citations for this turn. */
      citations?: Citation[] | null;
      /**
       * Override created_at. The column defaults to now() on the
       * server; almost every caller wants that. The exception is
       * the synthetic-recovery persistence path, which heals a
       * wire-shape gap mid-conversation and needs the new row to
       * land at the gap's position in created_at order rather than
       * piling up at the tail.
       */
      created_at?: string;
    } = {}
  ): Promise<Message> {
    // Trim outer whitespace at the write boundary. LLM responses
    // sometimes land with a leading newline or indent (often from
    // Venice's SSE parser peeling the reasoning channel off the
    // content stream), which the markdown renderer interprets as a
    // code-indent and sets the whole reply at a blockquote offset.
    // User inputs occasionally carry trailing blank lines from
    // mobile autocomplete or paste. Trimming at insert keeps the DB
    // canonical; the Markdown component trims at render too so
    // existing rows benefit without a backfill.
    const trimmedContent = content.trim();
    const row: Record<string, unknown> = { thread_id: threadId, role, content: trimmedContent };
    if (opts.tool_calls !== undefined) row.tool_calls = opts.tool_calls;
    if (opts.tool_call_id !== undefined) row.tool_call_id = opts.tool_call_id;
    if (opts.name !== undefined) row.name = opts.name;
    if (opts.model !== undefined) row.model = opts.model;
    if (opts.usage !== undefined) row.usage = opts.usage;
    if (opts.reasoning !== undefined) row.reasoning = opts.reasoning;
    if (opts.citations !== undefined) row.citations = opts.citations;
    if (opts.created_at !== undefined) row.created_at = opts.created_at;
    const { data, error } = await this.client
      .from('messages')
      .insert(row)
      .select()
      .single();
    if (error) throw new SupabaseError(error.message);
    await this.client
      .from('threads')
      .update({ updated_at: new Date().toISOString() })
      .eq('id', threadId);
    return data as Message;
  }

  /**
   * Replace the `content` field on a single `role='tool'` row, located
   * by its (thread_id, tool_call_id) pair. The ONLY caller is the
   * ask_user suspend/resume path: the chat-loop initially writes a
   * pending sentinel as the tool row content, and the UI rewrites it
   * to the real answer payload when the user submits (or to an
   * abandonment payload on refresh / new send / sibling cancel).
   *
   * Scoped to role='tool' at the application layer in addition to the
   * RLS UPDATE policy's role check, so a future caller can't
   * accidentally rewrite an assistant or user row's content through
   * this surface. The tool_call_id pair is unique within a thread
   * (one tool result per call) so `single()` is correct here.
   *
   * Returns the updated row so the caller can append/replace it in
   * the in-memory message list.
   */
  async updateToolMessageContent(
    threadId: string,
    toolCallId: string,
    content: string
  ): Promise<Message> {
    const { data, error } = await this.client
      .from('messages')
      .update({ content })
      .eq('thread_id', threadId)
      .eq('tool_call_id', toolCallId)
      .eq('role', 'tool')
      .select()
      .single();
    if (error) throw new SupabaseError(error.message);
    return data as Message;
  }

  /**
   * Mark an assistant row's second-thoughts verdict as acted-on (the
   * user clicked the refinement button). Routes through the
   * `mark_second_thoughts_acted` SECURITY DEFINER RPC because the
   * client's messages-UPDATE RLS policy only covers role='tool' rows;
   * the RPC gates on thread ownership and touches only the `acted` key.
   * Callers fire-and-forget - a failure just means the flag won't
   * survive a reload (this turn's wire is driven by the local patch).
   */
  async markSecondThoughtsActed(messageId: string): Promise<void> {
    const { error } = await this.client.rpc('mark_second_thoughts_acted', {
      p_message_id: messageId,
    });
    if (error) throw new SupabaseError(error.message);
  }

  // --- Realtime subscriptions & message fetch --------------------------

  /**
   * Realtime: stream INSERTs for a single thread's messages. Keeps a
   * thread open on two devices in sync — when device A's chat-loop
   * commits a user / assistant / tool row, device B sees it land in
   * the transcript without a refresh. Filtering happens server-side
   * (`filter: thread_id=eq.<id>`), layered on top of RLS so a
   * compromised client can't just listen to other users' threads.
   *
   * The caller is responsible for deduping — the inserting device
   * also receives an echo of its own write, and a race can push the
   * echo ahead of the promise resolution for `addMessage`. Dedupe by
   * `Message.id` at the append site handles both orderings.
   */
  subscribeToMessages(
    threadId: string,
    onMessage: (msg: Message) => void
  ): () => void {
    // Defend the realtime channel: if the consumer throws, the
    // postgres_changes subscription dies silently and the transcript
    // stops receiving echoes for this thread until the user re-selects
    // it. Log and swallow so subsequent echoes still arrive.
    const dispatch = (msg: Message): void => {
      try {
        onMessage(msg);
      } catch (err) {
        log.error('subscribeToMessages handler threw', err);
      }
    };
    const channel = this.client
      .channel(`messages:${threadId}`)
      .on(
        // `postgres_changes` is the realtime-js event shape for
        // replication-stream rows. Typed loose here — the supabase-js
        // generic is over a whole DB schema and we don't have one.
        'postgres_changes' as never,
        {
          event: 'INSERT',
          schema: 'public',
          table: 'messages',
          filter: `thread_id=eq.${threadId}`,
        },
        (payload: { new: Message }) => {
          dispatch(payload.new);
        }
      )
      .on(
        // UPDATE echoes are how the streaming-root assistant row arrives
        // in its terminal state. The function INSERTs the row with
        // `status='streaming'` at first content delta (which the
        // subscriber filters out) and later UPDATEs the same row when
        // the round chain settles - flipping status to `'complete' |
        // 'aborted' | 'error' | 'suspended_for_ask_user'` and pinning
        // the canonical content/reasoning/citations. Without listening
        // for UPDATEs the terminal row would never enter the local
        // `messages` array; the consumer's id-keyed append handles the
        // INSERT-then-UPDATE ordering.
        'postgres_changes' as never,
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'messages',
          filter: `thread_id=eq.${threadId}`,
        },
        (payload: { new: Message }) => {
          dispatch(payload.new);
        }
      )
      .subscribe();
    return () => {
      // removeChannel returns a promise but we don't care to await —
      // the caller is teardown path, and stray events after this
      // would be no-ops (the channel is detached). Fire-and-forget
      // matches the onAuthChange unsubscribe contract above.
      void this.client.removeChannel(channel);
    };
  }

  /**
   * Fetch a single message by id. Returns null when the row doesn't
   * exist or is owned by another user (RLS filters those rows out, so
   * the two cases are indistinguishable). Used by the chat-loop at
   * END time to hydrate the assistant row the streaming function just
   * committed so the slot's persistedRows replay buffer carries a
   * canonical record - the realtime UPDATE echo also delivers the
   * same row separately for the live `messages` view, but the
   * end-of-turn synth path needs the row before the echo races in.
   */
  async getMessage(id: string): Promise<Message | null> {
    const { data, error } = await this.client
      .from('messages')
      .select('*')
      .eq('id', id)
      .maybeSingle();
    if (error) throw new SupabaseError(error.message);
    return (data as Message | null) ?? null;
  }

  /**
   * Realtime: stream INSERT / UPDATE / DELETE on the current user's
   * threads. Keeps the sidebar in sync across devices — a rename on
   * phone reflects on desktop, a newly-created thread appears in the
   * list, and the `updated_at` bump that each message triggers
   * reorders the list newest-first without polling. RLS enforces the
   * user_id scoping; the filter here just narrows the wire traffic.
   *
   * DELETE payloads only carry the primary key (the default
   * `replica identity` — we don't need old-column values), so the
   * handler receives just the id.
   */
  subscribeToThreads(
    userId: string,
    handlers: {
      onInsert?: (thread: Thread) => void;
      onUpdate?: (thread: Thread) => void;
      onDelete?: (id: string) => void;
    }
  ): () => void {
    const channel = this.client
      .channel(`threads:${userId}`)
      .on(
        'postgres_changes' as never,
        {
          event: 'INSERT',
          schema: 'public',
          table: 'threads',
          filter: `user_id=eq.${userId}`,
        },
        (payload: { new: Thread }) => {
          handlers.onInsert?.(payload.new);
        }
      )
      .on(
        'postgres_changes' as never,
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'threads',
          filter: `user_id=eq.${userId}`,
        },
        (payload: { new: Thread }) => {
          handlers.onUpdate?.(payload.new);
        }
      )
      .on(
        'postgres_changes' as never,
        {
          event: 'DELETE',
          schema: 'public',
          table: 'threads',
          filter: `user_id=eq.${userId}`,
        },
        (payload: { old: { id: string } }) => {
          handlers.onDelete?.(payload.old.id);
        }
      )
      .subscribe();
    return () => {
      void this.client.removeChannel(channel);
    };
  }

  /**
   * Subscribe to the signed-in user's edge-function log channel. Server-
   * side background work (reflection, and the agent fleets as they
   * migrate off the browser) publishes structured entries to the private
   * `logs:<userId>` Broadcast topic; this feeds each one to `onEntry`,
   * which the caller routes into the Logs drawer via `appendFromEdge`.
   *
   * `private: true` engages the "log channel: owner subscribe" policy on
   * realtime.messages (supabase/schema.sql) - a user only receives their
   * own logs. The edge function publishes under service_role and bypasses
   * the policy. Returns an unsubscribe teardown, same shape as
   * subscribeToThreads.
   */
  subscribeToUserLogs(
    userId: string,
    onEntry: (entry: SerializableLogEntry) => void
  ): () => void {
    const channel = this.client
      .channel(`logs:${userId}`, { config: { private: true } })
      .on('broadcast', { event: 'nak-log' }, ({ payload }) => {
        onEntry(payload as SerializableLogEntry);
      })
      // Surface the channel lifecycle at debug so a future "edge logs
      // aren't reaching the drawer" report can confirm whether the
      // private subscribe reached SUBSCRIBED (vs CHANNEL_ERROR /
      // TIMED_OUT). Drawer-only; not console noise.
      .subscribe((status, err) => {
        log.debug(`logs channel subscribe status: ${status}`, err ?? '');
      });
    return () => {
      void this.client.removeChannel(channel);
    };
  }

  /**
   * Subscribe to any change on the signed-in user's wiki articles.
   * The autonomous wiki agent writes articles server-side (the
   * cron-driven sweep), where the browser's emitWikiChange event bus
   * is unreachable - this replication-stream subscription is how an
   * open Wiki panel learns a background write landed. The caller
   * (Chat.svelte) routes the notification into emitWikiChange so
   * every existing wiki surface refetches through the path it
   * already had.
   *
   * Coarse on purpose: no per-event payloads, just "something
   * changed". The wiki surfaces refetch their own lists; pushing row
   * deltas through would duplicate their loaders for no win.
   */
  /**
   * Read whether a background-agent in-flight lease is currently held
   * for this user. The wiki/memory librarian manual + scheduled runs
   * claim a lease on the profiles row (<agent>_inflight_expires_at);
   * held = a future expiry. RLS lets a user read their own profile.
   * Returns the expiry ISO string when held, else null. The caller
   * derives "running" and arms a timer at the expiry for the crash/TTL
   * case - a lease that lapses without an explicit release writes no
   * row, so no realtime UPDATE fires.
   */
  async getInflightLeaseExpiry(
    userId: string,
    column: InflightLeaseColumn
  ): Promise<string | null> {
    const { data, error } = await this.client
      .from('profiles')
      .select(column)
      .eq('user_id', userId)
      .maybeSingle();
    if (error) throw new Error(`getInflightLeaseExpiry failed: ${error.message}`);
    const exp = (data as Record<string, unknown> | null)?.[column];
    if (typeof exp !== 'string') return null;
    return new Date(exp).getTime() > Date.now() ? exp : null;
  }

  /**
   * Subscribe to in-flight lease transitions for this user via realtime
   * profiles UPDATEs (requires profiles in the supabase_realtime
   * publication - schema.sql). Calls back with the lease expiry ISO when
   * a run claims/holds it, or null when released. Does NOT fire on a TTL
   * lapse (that writes no row) - the caller's expiry timer covers that.
   * Filtering on user_id is safe for UPDATE delivery because the new
   * tuple always carries it (no replica-identity index needed, unlike
   * the DELETE-delivery relays). Returns an unsubscribe.
   */
  subscribeToInflightLease(
    userId: string,
    column: InflightLeaseColumn,
    onChange: (expiry: string | null) => void
  ): () => void {
    const channel = this.client
      .channel(`inflight_lease:${column}:${userId}`)
      .on(
        'postgres_changes' as never,
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'profiles',
          filter: `user_id=eq.${userId}`,
        },
        (payload: { new?: Record<string, unknown> | null }) => {
          const exp = payload.new?.[column];
          if (typeof exp !== 'string') {
            onChange(null);
            return;
          }
          onChange(new Date(exp).getTime() > Date.now() ? exp : null);
        }
      )
      .subscribe();
    return () => {
      void this.client.removeChannel(channel);
    };
  }

  /**
   * Read the most-recent manual-run outcome for this user from the
   * `*_last_run_outcome` profiles column. Returns the coerced envelope
   * (runId / source / finishedAt / result) or null when no run has
   * finished yet or the stored shape is unrecognised. Paired with
   * subscribeToLastRunOutcome: this is the on-mount read that recovers a
   * run that finished while the tab was away; the subscription delivers
   * one that finishes while the tab is open. RLS lets a user read their
   * own profile.
   */
  async getLastRunOutcome(
    userId: string,
    column: LastRunOutcomeColumn
  ): Promise<ManualRunOutcome | null> {
    const { data, error } = await this.client
      .from('profiles')
      .select(column)
      .eq('user_id', userId)
      .maybeSingle();
    if (error) throw new Error(`getLastRunOutcome failed: ${error.message}`);
    return coerceManualRunOutcome((data as Record<string, unknown> | null)?.[column]);
  }

  /**
   * Subscribe to manual-run-outcome writes for this user via realtime
   * profiles UPDATEs (the same row + publication the in-flight lease
   * rides). The venice function writes the outcome column when a detached
   * run finishes, so the UPDATE's new tuple carries the fresh envelope -
   * delivering it race-free without a re-read. Calls back with the
   * coerced outcome, or null if the new tuple's column is empty/garbage.
   * Returns an unsubscribe.
   */
  subscribeToLastRunOutcome(
    userId: string,
    column: LastRunOutcomeColumn,
    onOutcome: (outcome: ManualRunOutcome | null) => void
  ): () => void {
    const channel = this.client
      .channel(`last_run_outcome:${column}:${userId}`)
      .on(
        'postgres_changes' as never,
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'profiles',
          filter: `user_id=eq.${userId}`,
        },
        (payload: { new?: Record<string, unknown> | null }) => {
          onOutcome(coerceManualRunOutcome(payload.new?.[column]));
        }
      )
      .subscribe();
    return () => {
      void this.client.removeChannel(channel);
    };
  }

  subscribeToWikiArticleChanges(userId: string, onChange: () => void): () => void {
    const channel = this.client
      .channel(`wiki_articles:${userId}`)
      .on(
        'postgres_changes' as never,
        {
          event: '*',
          schema: 'public',
          table: 'wiki_articles',
          filter: `user_id=eq.${userId}`,
        },
        () => {
          onChange();
        }
      )
      .subscribe();
    return () => {
      void this.client.removeChannel(channel);
    };
  }

  /**
   * Subscribe to any change on the signed-in user's wiki records. Twin
   * of subscribeToWikiArticleChanges - the extraction agent, the
   * librarian, the chat record tools, and the in-app compose form all
   * write records, so the open article view refetches its Records
   * section on a coarse "something changed" signal.
   */
  subscribeToWikiRecordChanges(userId: string, onChange: () => void): () => void {
    // One channel, three tables: the record rows plus their two relations
    // (files + links). A server-side write on any of them - chat tool,
    // extraction agent, librarian - flows into the same coarse
    // "something changed" notification, and an open article view refetches
    // its records / files / links. Each table's DELETE delivery rides its
    // (id, user_id) replica-identity index (see schema.sql).
    const channel = this.client.channel(`wiki_records:${userId}`);
    for (const table of ['wiki_records', 'wiki_record_files', 'wiki_record_links']) {
      channel.on(
        'postgres_changes' as never,
        {
          event: '*',
          schema: 'public',
          table,
          filter: `user_id=eq.${userId}`,
        },
        () => {
          onChange();
        }
      );
    }
    channel.subscribe();
    return () => {
      void this.client.removeChannel(channel);
    };
  }

  /**
   * Subscribe to any change on the signed-in user's memories. The
   * wiki-articles twin above, for the memory writers that all live
   * server-side now (reflection on the chat-turn tail, the rem and
   * deep-sleep librarian sweeps): the caller (Chat.svelte) routes the
   * notification into emitMemoryChange so an open Memories panel
   * refetches through the path it already had. Same coarse contract -
   * "something changed", no row deltas.
   */
  subscribeToMemoryChanges(userId: string, onChange: () => void): () => void {
    const channel = this.client
      .channel(`memories:${userId}`)
      .on(
        'postgres_changes' as never,
        {
          event: '*',
          schema: 'public',
          table: 'memories',
          filter: `user_id=eq.${userId}`,
        },
        () => {
          onChange();
        }
      )
      .subscribe();
    return () => {
      void this.client.removeChannel(channel);
    };
  }

  /**
   * Subscribe to any change on the signed-in user's recipes. Third of
   * the wiki-articles / memories family: the chat-reachable recipe
   * writers (the recipe_* tools) all run server-side, so this is how
   * an open Cookbook modal or the drawer's Recipes tab learns a
   * model-driven recipe write landed. The caller (Chat.svelte) routes
   * the notification into emitCookbookChange. Same coarse contract -
   * "something changed", no row deltas.
   */
  subscribeToRecipeChanges(userId: string, onChange: () => void): () => void {
    const channel = this.client
      .channel(`recipes:${userId}`)
      .on(
        'postgres_changes' as never,
        {
          event: '*',
          schema: 'public',
          table: 'recipes',
          filter: `user_id=eq.${userId}`,
        },
        () => {
          onChange();
        }
      )
      .subscribe();
    return () => {
      void this.client.removeChannel(channel);
    };
  }

  /**
   * Subscribe to the signed-in user's freshly minted samskaras. The
   * formation pipeline runs in the venice function and publishes a
   * `samskara-mint` Broadcast event per mint (insertMint ->
   * publishSamskaraMint); this relay maps its (tier, valence,
   * confidence) payload into the mood-pill toast (the caller routes it to
   * notifySamskaraMint).
   *
   * Broadcast rather than a postgres_changes echo on purpose: only the
   * server-side INSERT emits the event, so dedup-reinforce hits (which
   * UPDATE an existing row) stay silent - the intended toast semantics -
   * and `samskaras` stays out of the realtime publication, where its
   * fire-bookkeeping UPDATE churn used to flood the WAL decoder (see
   * supabase/functions/_shared/samskara-mint.ts). Payloads with an
   * unexpected shape are dropped: a toast is decoration, never worth
   * surfacing an error for.
   *
   * `private: true` engages the "samskara mint channel: owner subscribe"
   * policy on realtime.messages (supabase/schema.sql) - a user only
   * receives their own mints. The edge function publishes under
   * service_role and bypasses the policy.
   */
  subscribeToSamskaraInserts(
    userId: string,
    onMint: (detail: { tier: 1 | 2; valence: number; confidence: number }) => void
  ): () => void {
    const channel = this.client
      .channel(`samskaras:${userId}`, { config: { private: true } })
      .on('broadcast', { event: 'samskara-mint' }, ({ payload }) => {
        const detail = payload as Record<string, unknown> | undefined;
        if (!detail) return;
        const tier = detail.tier;
        if (tier !== 1 && tier !== 2) return;
        onMint({
          tier,
          valence: typeof detail.valence === 'number' ? detail.valence : 0,
          confidence: typeof detail.confidence === 'number' ? detail.confidence : 0.5,
        });
      })
      // Surface the channel lifecycle at debug so a "mint toasts aren't
      // popping" report can tell an RLS-rejected private subscribe
      // (CHANNEL_ERROR / TIMED_OUT) from a publish-side miss. Same
      // breadcrumb subscribeToUserLogs keeps for the logs channel.
      .subscribe((status, err) => {
        log.debug(`samskaras channel subscribe status: ${status}`, err ?? '');
      });
    return () => {
      void this.client.removeChannel(channel);
    };
  }

  /**
   * Subscribe to the signed-in user's agent-run progress channel. The
   * venice function publishes live step events (model rounds, tool
   * calls with their narration) for user-triggered agent runs - the
   * Wiki librarian's manual-run strip and the Memories panel's
   * rem / deep-sleep strips are the consumers. Subscribe
   * BEFORE issuing the run's POST (the pre-subscribe rule streaming
   * chat established); filter by runId at the call site since the
   * topic is per-user, not per-run. `private: true` engages the
   * "agent-run channel: owner subscribe" policy on realtime.messages.
   */
  subscribeToAgentRunProgress(
    userId: string,
    onEvent: (event: AgentRunProgressEvent) => void
  ): () => void {
    const channel = this.client
      .channel(`agent-runs:${userId}`, { config: { private: true } })
      .on('broadcast', { event: 'agent-progress' }, ({ payload }) => {
        onEvent(payload as AgentRunProgressEvent);
      })
      .subscribe((status, err) => {
        log.debug(`agent-runs channel subscribe status: ${status}`, err ?? '');
      });
    return () => {
      void this.client.removeChannel(channel);
    };
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
  // The per-turn bias writes (active-set snapshot + new-message clear)
  // moved server-side when priming relocated into the venice edge
  // function (supabase/functions/venice/priming.ts). The browser keeps
  // only biasListSummary, the read the diagnostics modal renders from.

  /**
   * Chat-loop: read every cached aggregate for the user. Returns
   * empty array on cold-start (no row in bias_summary yet) or on
   * any RPC error - the format pass treats both as "no bias block
   * this turn", matching samskara's null-on-empty contract.
   */
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
    const { data, error } = await this.client
      .from('bias_summary')
      .select(
        'bias, effective_n, posterior_alpha, posterior_beta, posterior_mean, ci_lower, feedback_score, tier, computed_at'
      );
    if (error) throw new SupabaseError(error.message);
    const rows = (data ?? []) as {
      bias: string;
      effective_n: number;
      posterior_alpha: number;
      posterior_beta: number;
      posterior_mean: number;
      ci_lower: number;
      feedback_score: number | null;
      tier: 'elided' | 'soft' | 'strong';
      computed_at: string;
    }[];
    return rows.map((r) => ({
      bias: r.bias,
      effectiveN: r.effective_n,
      posteriorAlpha: r.posterior_alpha,
      posteriorBeta: r.posterior_beta,
      posteriorMean: r.posterior_mean,
      ciLower: r.ci_lower,
      // feedback_score column was added in v2; pre-v2 rows return
      // null which we treat as the neutral 0.
      feedbackScore: r.feedback_score ?? 0,
      tier: r.tier,
      computedAt: r.computed_at,
    }));
  }

  /**
   * Debug modal: per-bias raw observation counts across the user's
   * full history. Distinct from `effective_n` on the summary row -
   * effective_n is the recency-weighted sum of ALL processed
   * conversations (including the pConv=0 "no-hit" denominator), so
   * every catalog entry the worker has touched ends up with a
   * non-zero effective_n even when it was never flagged. The
   * observation count answers the user's question "has anything
   * ever been recorded against this bias for me?" - zero means the
   * row's posterior is just the prior plus the cumulative no-hit
   * mass, and the modal renders it as "no evidence" rather than
   * the ~5% prior 10th-percentile.
   *
   * Aggregation is client-side. The bias_observations table has no
   * native group-by in the PostgREST surface, and observation
   * counts are small enough (worker-rate-limited, bounded by the
   * catalog size times processed conversations) that pulling the
   * `bias` column and tallying in JS is cheaper than adding an
   * RPC for it.
   */
  async biasListObservationCounts(): Promise<Record<string, number>> {
    const { data, error } = await this.client
      .from('bias_observations')
      .select('bias');
    if (error) throw new SupabaseError(error.message);
    const rows = (data ?? []) as { bias: string }[];
    const counts: Record<string, number> = {};
    for (const r of rows) {
      counts[r.bias] = (counts[r.bias] ?? 0) + 1;
    }
    return counts;
  }

  /**
   * Debug modal: list per-conversation reactions for one thread.
   * The current-conversation section uses this to surface "did the
   * user affirm or push back on the compensation for X here?"
   * alongside the observations for the same thread.
   */
  async biasListReactionsForThread(threadId: string): Promise<
    {
      id: string;
      bias: string;
      wasConfirmed: boolean | null;
      reasoning: string;
      createdAt: string;
    }[]
  > {
    const { data, error } = await this.client
      .from('bias_reactions')
      .select('id, bias, was_confirmed, reasoning, created_at')
      .eq('thread_id', threadId)
      .order('created_at', { ascending: true });
    if (error) throw new SupabaseError(error.message);
    const rows = (data ?? []) as {
      id: string;
      bias: string;
      was_confirmed: boolean | null;
      reasoning: string;
      created_at: string;
    }[];
    return rows.map((r) => ({
      id: r.id,
      bias: r.bias,
      wasConfirmed: r.was_confirmed,
      reasoning: r.reasoning,
      createdAt: r.created_at,
    }));
  }

  /**
   * Debug modal: fetch a thread's bias_processed_at timestamp.
   * Returns null if the thread row doesn't exist yet (e.g. a brand-
   * new draft conversation that hasn't been materialized to the DB)
   * or if the worker hasn't analyzed it yet. The bias-profile modal
   * uses this to distinguish "not yet analyzed" (no observations
   * because the worker hasn't gotten to it) from "already analyzed,
   * no findings" (no observations because the worker scanned and
   * came up empty) - otherwise a fresh conversation reads as the
   * latter, which is wrong and misleading.
   */
  async biasGetThreadProcessedAt(threadId: string): Promise<string | null> {
    const { data, error } = await this.client
      .from('threads')
      .select('bias_processed_at')
      .eq('id', threadId)
      .maybeSingle();
    if (error) throw new SupabaseError(error.message);
    const row = data as { bias_processed_at: string | null } | null;
    return row?.bias_processed_at ?? null;
  }

  /**
   * Debug modal: list observations for one thread. Used by the
   * per-conversation drill-down. Includes the cited message id so
   * the modal can deep-link back to the original.
   */
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
    const { data, error } = await this.client
      .from('bias_observations')
      .select('id, bias, confidence, reasoning, evidence_message_id, created_at')
      .eq('thread_id', threadId)
      .order('created_at', { ascending: true });
    if (error) throw new SupabaseError(error.message);
    const rows = (data ?? []) as {
      id: string;
      bias: string;
      confidence: number;
      reasoning: string;
      evidence_message_id: string | null;
      created_at: string;
    }[];
    return rows.map((r) => ({
      id: r.id,
      bias: r.bias,
      confidence: r.confidence,
      reasoning: r.reasoning,
      evidenceMessageId: r.evidence_message_id,
      createdAt: r.created_at,
    }));
  }

  /**
   * Debug modal: list every observation for one bias key across
   * every thread the user has, joined to the source thread's
   * title so each row can render as a navigable link. Drives the
   * per-bias drill-down ("which conversations triggered this?")
   * on the bias-profile screen.
   *
   * Sorted newest-first - the user's mental model is "what got
   * flagged recently for this bias?", not chronological reading
   * order. RLS scopes the read to the current user; deleted
   * threads have already cascaded their observations away, so a
   * missing thread title here means the auto-titler hasn't run
   * yet, not a dangling reference.
   */
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
    const { data, error } = await this.client
      .from('bias_observations')
      .select('id, thread_id, confidence, reasoning, created_at, threads(title)')
      .eq('bias', biasKey)
      .order('created_at', { ascending: false });
    if (error) throw new SupabaseError(error.message);
    const out: {
      id: string;
      threadId: string;
      threadTitle: string | null;
      confidence: number;
      reasoning: string;
      createdAt: string;
    }[] = [];
    for (const row of (data ?? []) as Array<Record<string, unknown>>) {
      const id = row.id;
      const threadId = row.thread_id;
      if (typeof id !== 'string' || typeof threadId !== 'string') continue;
      // PostgREST returns a many-to-one embed as a single object,
      // but the supabase-js type inference treats it as either an
      // object or array depending on FK metadata. Mirror the
      // unwrap pattern from listWikiArticleSources so this stays
      // robust against either shape.
      const thread = row.threads as { title?: unknown } | { title?: unknown }[] | null;
      const threadObj = Array.isArray(thread) ? thread[0] : thread;
      const title =
        threadObj && typeof threadObj.title === 'string' ? threadObj.title : null;
      out.push({
        id,
        threadId,
        threadTitle: title,
        confidence: typeof row.confidence === 'number' ? row.confidence : 0,
        reasoning: typeof row.reasoning === 'string' ? row.reasoning : '',
        createdAt: typeof row.created_at === 'string' ? row.created_at : '',
      });
    }
    return out;
  }

  /**
   * Debug modal: list the most-recently-processed threads with
   * counts of observations and the message-count token. Drives the
   * "Processed conversations" table on the bias-profile screen.
   */
  async biasListProcessedThreads(limit: number = 30): Promise<
    {
      threadId: string;
      title: string;
      processedAt: string;
      observationCount: number;
    }[]
  > {
    const { data, error } = await this.client
      .from('threads')
      .select(
        'id, title, bias_processed_at, bias_observations(count)'
      )
      .not('bias_processed_at', 'is', null)
      .order('bias_processed_at', { ascending: false })
      .limit(limit);
    if (error) throw new SupabaseError(error.message);
    const rows = (data ?? []) as {
      id: string;
      title: string | null;
      bias_processed_at: string;
      // Supabase's `embedded count` returns an array containing
      // one row with { count: N }; the cast is fragile in the
      // type system, careful at the boundary.
      bias_observations: { count: number }[] | null;
    }[];
    return rows.map((r) => ({
      threadId: r.id,
      title: r.title ?? '',
      processedAt: r.bias_processed_at,
      observationCount: r.bias_observations?.[0]?.count ?? 0,
    }));
  }
}
