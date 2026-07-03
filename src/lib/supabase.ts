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
import {
  base64ToBytes,
  ilikeLogicTreePattern,
} from './supabase/query-utils';
// Cookbook domain slice (recipes, versions, photos), same delegation
// pattern as the slices below.
import * as cookbookApi from './supabase/cookbook';
// Memories domain slice: the facade's memory methods (both the CRUD +
// changelog group and the confidence / search / relations group)
// delegate to these plain functions one-for-one under the same names
// (see the class preamble for the slice pattern).
import * as memoriesApi from './supabase/memories';
// Samskara domain slice, same delegation pattern.
import * as samskaraApi from './supabase/samskara';
// Settings + Venice-proxy domain slices, same delegation pattern.
// veniceFunctionError is pulled in by name because the wiki agent-run
// methods below still normalize their own functions.invoke failures
// through it.
import * as settingsApi from './supabase/settings';
import * as veniceProxyApi from './supabase/venice-proxy';
import { veniceFunctionError } from './supabase/venice-proxy';
// Threads + topic-vocabulary domain slices, same delegation pattern.
import * as threadsApi from './supabase/threads';
import * as topicsApi from './supabase/topics';

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
  coerceWikiArticle,
  coerceWikiRecord,
  coerceWikiRecordFile,
  coerceWikiRecordLink,
  coerceWikiChangelogEntry,
  coerceDocument,
} from './supabase/types';
// Pure helper for the record-changelog message wording; mirrored
// edge-side in venice/tools/_record_helpers.ts. The `import type` cycle
// back to this file from ./wiki is erased at runtime, so this value
// import is one-way.
import {
  buildRecordChangelogMessage,
  buildRecordFileChangelogMessage,
  buildRecordLinkChangelogMessage,
} from './wiki';
// sha256Hex lives in attachments.ts (recipe-photo dedup); reused here for
// wiki-record-file dedup so the manual UI attach and the agent-side
// record_file_attach key duplicates the same way. attachments.ts only
// `import type`s from this module, so this value import has no runtime cycle.
import { sha256Hex } from './attachments';
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
 * relations (./supabase/memories.ts), and Cookbook - recipes, versions,
 * photos (./supabase/cookbook.ts) - groups are extracted; the
 * remaining groups still carry their implementations inline and should
 * follow the same pattern when touched substantially.
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

  /**
   * Alphabetical listing of every wiki article for the current user.
   * Sort key is `lower(title)` so case differences ("Apple" vs
   * "apple") fold together. Limit defaults to 500, matching memories
   * - a single user is unlikely to author thousands of
   * encyclopedic articles, and pagination would complicate the
   * client-side store filtering pattern.
   */
  async listWikiArticles(opts: { limit?: number } = {}): Promise<WikiArticle[]> {
    const { data, error } = await this.client
      .from('wiki_articles')
      .select('id, title, content, favorite, created_at, updated_at')
      .order('title', { ascending: true })
      .limit(opts.limit ?? 500);
    if (error) throw new SupabaseError(error.message);
    return (data ?? []).map((row) => coerceWikiArticle(row as Record<string, unknown>));
  }

  /**
   * One offset page of the wiki browse list, alphabetical by title.
   * Powers the sidebar's infinite scroll for the empty-query case; an
   * active search still goes through `searchWikiArticles` (capped, not
   * paged). `id` is the final tiebreak so articles colliding on title
   * keep a stable cross-page order.
   *
   * Ordering is the DB collation's `title ASC`, so the sidebar renders
   * server order verbatim rather than re-sorting with a JS
   * `localeCompare` - a client re-sort over a partial page would
   * disagree with the server's page boundaries and shuffle rows across
   * the seam mid-scroll.
   */
  async listWikiArticlesPage(opts: {
    offset: number;
    pageSize: number;
  }): Promise<OffsetPage<WikiArticle>> {
    const { data, error } = await this.client
      .from('wiki_articles')
      .select('id, title, content, favorite, created_at, updated_at')
      .order('title', { ascending: true })
      .order('id', { ascending: true })
      .range(opts.offset, opts.offset + opts.pageSize);
    if (error) throw new SupabaseError(error.message);
    const all = (data ?? []).map((row) =>
      coerceWikiArticle(row as Record<string, unknown>)
    );
    const hasMore = all.length > opts.pageSize;
    return { rows: hasMore ? all.slice(0, opts.pageSize) : all, hasMore };
  }

  /**
   * Fetch one article by id, or null if it isn't there. The wiki
   * sidebar normally keeps the open article in `wikiStore.results`, so
   * this exists for the cases the list doesn't cover: a deep link to an
   * article that was never paged in, and the offline read-through
   * (`getArticleCached`) that needs an authoritative single-row fetch.
   * Clone of `getRecipe`.
   */
  async getWikiArticleById(id: string): Promise<WikiArticle | null> {
    const { data, error } = await this.client
      .from('wiki_articles')
      .select('id, title, content, favorite, created_at, updated_at')
      .eq('id', id)
      .maybeSingle();
    if (error) throw new SupabaseError(error.message);
    return data ? coerceWikiArticle(data as Record<string, unknown>) : null;
  }

  /**
   * Every article flagged `favorite`. Fetched whole (the flagged subset
   * is small and the partial index keeps it cheap) so the sidebar's
   * Favorites bucket and the offline-sync reconcile both see the
   * complete set rather than a page window. Twin of
   * `listFavoriteRecipes`.
   */
  async listFavoriteWikiArticles(): Promise<WikiArticle[]> {
    const { data, error } = await this.client
      .from('wiki_articles')
      .select('id, title, content, favorite, created_at, updated_at')
      .eq('favorite', true)
      .order('title', { ascending: true });
    if (error) throw new SupabaseError(error.message);
    return (data ?? []).map((row) =>
      coerceWikiArticle(row as Record<string, unknown>)
    );
  }

  /**
   * Toggle the `favorite` bookmark. Direct update, no version row and
   * no `updated_at` bump - favorite is a personal bookmark, not article
   * content. Mirrors `setRecipeFavorite`. The schema trigger
   * `clear_wiki_embedding_on_change` only fires on title/content, so
   * this leaves the embedding intact too.
   */
  async setWikiArticleFavorite(id: string, favorite: boolean): Promise<void> {
    const { error } = await this.client
      .from('wiki_articles')
      .update({ favorite })
      .eq('id', id);
    if (error) throw new SupabaseError(error.message);
  }

  async createWikiArticle(args: {
    title: string;
    content: string;
  }): Promise<WikiArticle> {
    const session = await this.getSession();
    if (!session) throw new SupabaseError('Not authenticated.');
    const { data, error } = await this.client
      .from('wiki_articles')
      .insert({
        user_id: session.user.id,
        title: args.title,
        content: args.content,
      })
      .select('id, title, content, favorite, created_at, updated_at')
      .single();
    if (error) throw new SupabaseError(error.message);
    return coerceWikiArticle(data as Record<string, unknown>);
  }

  /**
   * Patch an article's title or content. RLS owner-scopes the update.
   * The schema trigger `clear_wiki_embedding_on_change` nulls the
   * embedding + claim columns when title or content changes so the
   * worker re-embeds on its next poll.
   */
  async updateWikiArticle(
    id: string,
    patch: { title?: string; content?: string }
  ): Promise<WikiArticle> {
    const { data, error } = await this.client
      .from('wiki_articles')
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select('id, title, content, favorite, created_at, updated_at')
      .single();
    if (error) throw new SupabaseError(error.message);
    return coerceWikiArticle(data as Record<string, unknown>);
  }

  async deleteWikiArticle(id: string): Promise<void> {
    const { error } = await this.client.from('wiki_articles').delete().eq('id', id);
    if (error) throw new SupabaseError(error.message);
  }

  // Wiki records ---------------------------------------------------------
  //
  // Dated entries linked to a wiki article. The article body owns the
  // consolidated "current state"; records preserve the dated journey.
  // RLS owner-scopes every query; the `wiki_records` table cascades on
  // article delete. updated_at is stamped by a DB trigger, not here.

  /**
   * List records for one article, reverse-chronological by event date.
   * Optional date-range (inclusive) and tag filters. Tags use JSONB
   * containment (`tags @> [...]`) so a row must carry every requested
   * tag (AND semantics) - the GIN index on `tags` backs this.
   */
  async listWikiRecords(
    articleId: string,
    filters: { fromDate?: string; toDate?: string; tags?: string[]; limit?: number } = {}
  ): Promise<WikiRecord[]> {
    let query = this.client
      .from('wiki_records')
      .select(
        // wiki_record_files(count) embeds a per-record attachment count so a
        // collapsed row can show an attachment badge without N+1 file fetches.
        'id, article_id, date, content, tags, source_conversation_id, created_at, updated_at, wiki_record_files(count)'
      )
      .eq('article_id', articleId)
      .order('date', { ascending: false })
      .order('created_at', { ascending: false });
    if (filters.fromDate) query = query.gte('date', filters.fromDate);
    if (filters.toDate) query = query.lte('date', filters.toDate);
    if (filters.tags && filters.tags.length > 0) query = query.contains('tags', filters.tags);
    if (filters.limit) query = query.limit(filters.limit);
    const { data, error } = await query;
    if (error) throw new SupabaseError(error.message);
    return (data ?? []).map((row) => coerceWikiRecord(row as Record<string, unknown>));
  }

  async getWikiRecord(id: string): Promise<WikiRecord | null> {
    const { data, error } = await this.client
      .from('wiki_records')
      .select(
        'id, article_id, date, content, tags, source_conversation_id, created_at, updated_at'
      )
      .eq('id', id)
      .maybeSingle();
    if (error) throw new SupabaseError(error.message);
    return data ? coerceWikiRecord(data as Record<string, unknown>) : null;
  }

  async createWikiRecord(args: {
    articleId: string;
    date: string;
    content: string;
    tags?: string[];
    sourceConversationId?: string | null;
  }): Promise<WikiRecord> {
    const session = await this.getSession();
    if (!session) throw new SupabaseError('Not authenticated.');
    const { data, error } = await this.client
      .from('wiki_records')
      .insert({
        user_id: session.user.id,
        article_id: args.articleId,
        date: args.date,
        content: args.content,
        tags: args.tags ?? [],
        source_conversation_id: args.sourceConversationId ?? null,
      })
      .select(
        'id, article_id, date, content, tags, source_conversation_id, created_at, updated_at'
      )
      .single();
    if (error) throw new SupabaseError(error.message);
    const record = coerceWikiRecord(data as Record<string, unknown>);
    await this.appendRecordChangelog(
      record.article_id,
      'record_create',
      record.date,
      record.content
    );
    return record;
  }

  /**
   * Patch a record's date, content, or tags. RLS owner-scopes the
   * update. The `clear_wiki_record_embedding_on_change` trigger nulls
   * the embedding + claim columns when date or content changes so the
   * worker re-embeds; `touch_wiki_record_updated_at` stamps updated_at.
   */
  async updateWikiRecord(
    id: string,
    patch: { date?: string; content?: string; tags?: string[] }
  ): Promise<WikiRecord> {
    const { data, error } = await this.client
      .from('wiki_records')
      .update(patch)
      .eq('id', id)
      .select(
        'id, article_id, date, content, tags, source_conversation_id, created_at, updated_at'
      )
      .single();
    if (error) throw new SupabaseError(error.message);
    const record = coerceWikiRecord(data as Record<string, unknown>);
    await this.appendRecordChangelog(
      record.article_id,
      'record_update',
      record.date,
      record.content
    );
    return record;
  }

  async deleteWikiRecord(id: string): Promise<void> {
    // Read the record first so the changelog row (logged against the
    // surviving parent article) can carry its date + content preview;
    // the record itself is gone after the delete.
    const doomed = await this.getWikiRecord(id);
    const { error } = await this.client.from('wiki_records').delete().eq('id', id);
    if (error) throw new SupabaseError(error.message);
    if (doomed) {
      await this.appendRecordChangelog(
        doomed.article_id,
        'record_delete',
        doomed.date,
        doomed.content
      );
    }
  }

  /**
   * Append a wiki_changelog row for a record write, scoped to the parent
   * article. Best-effort: a record write must not fail because its audit
   * row didn't land (the record is the source of truth; the changelog is
   * a convenience). title_at_change is the parent article's current
   * title, fetched here so the changelog UI renders the row without a
   * join even after the article is later deleted.
   */
  private async appendRecordChangelog(
    articleId: string,
    kind: 'record_create' | 'record_update' | 'record_delete',
    date: string,
    content?: string
  ): Promise<void> {
    await this.appendRecordChangelogMessage(
      articleId,
      kind,
      buildRecordChangelogMessage(kind, date, content)
    );
  }

  /**
   * Lower-level changelog append that takes a pre-built message, so the
   * file/link mutations (which reuse the record_update kind but need
   * different wording than a content edit - "Attached image ...",
   * "Linked to ...") can land a history row through the same path. Same
   * best-effort contract: a failed audit insert never fails the caller's
   * already-completed write.
   */
  private async appendRecordChangelogMessage(
    articleId: string,
    kind: 'record_create' | 'record_update' | 'record_delete',
    message: string
  ): Promise<void> {
    try {
      const { data } = await this.client
        .from('wiki_articles')
        .select('title')
        .eq('id', articleId)
        .maybeSingle();
      const title =
        data && typeof (data as { title?: unknown }).title === 'string'
          ? (data as { title: string }).title
          : '(record)';
      await this.createWikiChangelogEntry({
        article_id: articleId,
        kind,
        title_at_change: title,
        message,
      });
    } catch {
      // Best-effort - see the doc comment. Swallow so the record write
      // the caller already completed still resolves successfully.
    }
  }

  /**
   * Semantic + substring search across ALL the user's records (every
   * article). Mirrors `searchWikiArticles`: vector hits first, then
   * ILIKE hits the vector path missed, deduped by id, capped at `limit`.
   * Empty query short-circuits to a recent-first listing.
   */
  async searchWikiRecords(opts: {
    query: string;
    queryEmbedding: number[] | null;
    limit?: number;
  }): Promise<WikiRecord[]> {
    const query = opts.query.trim();
    const limit = opts.limit ?? 20;
    if (query.length === 0) {
      const { data, error } = await this.client
        .from('wiki_records')
        .select(
          'id, article_id, date, content, tags, source_conversation_id, created_at, updated_at'
        )
        .order('date', { ascending: false })
        .limit(limit);
      if (error) throw new SupabaseError(error.message);
      return (data ?? []).map((row) => coerceWikiRecord(row as Record<string, unknown>));
    }

    const pattern = ilikeLogicTreePattern(query);
    const ilikePromise = this.client
      .from('wiki_records')
      .select(
        'id, article_id, date, content, tags, source_conversation_id, created_at, updated_at'
      )
      .ilike('content', pattern)
      .order('date', { ascending: false })
      .limit(limit);

    const semanticPromise = opts.queryEmbedding
      ? this.client.rpc('search_wiki_records_by_embedding', {
          query_embedding: opts.queryEmbedding,
          match_limit: limit,
        })
      : Promise.resolve({ data: [] as unknown[], error: null });

    const [ilikeRes, semRes] = await Promise.all([ilikePromise, semanticPromise]);
    if (ilikeRes.error) throw new SupabaseError(ilikeRes.error.message);
    const ilikeRows = (ilikeRes.data ?? []).map((row) =>
      coerceWikiRecord(row as Record<string, unknown>)
    );
    const semanticRows =
      semRes.error !== null
        ? []
        : ((semRes.data ?? []) as unknown[]).map((row) =>
            coerceWikiRecord(row as Record<string, unknown>)
          );

    const out: WikiRecord[] = [];
    const seen = new Set<string>();
    for (const r of semanticRows) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      out.push(r);
      if (out.length >= limit) return out;
    }
    for (const r of ilikeRows) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      out.push(r);
      if (out.length >= limit) return out;
    }
    return out;
  }

  // --- wiki record files -----------------------------------------------

  async listWikiRecordFiles(recordId: string): Promise<WikiRecordFile[]> {
    const { data, error } = await this.client
      .from('wiki_record_files')
      .select(
        'id, record_id, position, filename, mime_type, size_bytes, storage_path, extracted_text, created_at'
      )
      .eq('record_id', recordId)
      .order('position', { ascending: true })
      .order('created_at', { ascending: true });
    if (error) throw new SupabaseError(error.message);
    return (data ?? []).map((row) => coerceWikiRecordFile(row as Record<string, unknown>));
  }

  /**
   * Short-lived signed URLs per file id, for image previews / download
   * links. Skips rows with no `storage_path` (reclaimed). Batched into one
   * Storage call; best-effort per the attachment twin above.
   */
  async createWikiRecordFileSignedUrls(
    files: readonly Pick<WikiRecordFile, 'id' | 'storage_path'>[],
    expiresInSeconds = 3600
  ): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const live = files.filter(
      (f): f is { id: string; storage_path: string } => typeof f.storage_path === 'string'
    );
    if (live.length === 0) return out;
    const { data, error } = await this.client.storage
      .from('wiki-record-files')
      .createSignedUrls(
        live.map((f) => f.storage_path),
        expiresInSeconds
      );
    if (error) throw new SupabaseError(error.message);
    const urlByPath = new Map<string, string>();
    for (const entry of data ?? []) {
      if (entry.signedUrl && typeof entry.path === 'string') {
        urlByPath.set(entry.path, entry.signedUrl);
      }
    }
    for (const f of live) {
      const url = urlByPath.get(f.storage_path);
      if (url) out.set(f.id, url);
    }
    return out;
  }

  async downloadWikiRecordFileBlob(storagePath: string): Promise<Blob> {
    const { data, error } = await this.client.storage
      .from('wiki-record-files')
      .download(storagePath);
    if (error) throw new SupabaseError(error.message);
    return data;
  }

  /**
   * Upload bytes to the persistent wiki-record-files bucket and insert the
   * metadata row, then changelog the attach against the parent article.
   * The id is minted client-side so the upload key and the row reference
   * one path in a single pass (same as addAttachments). `articleId` +
   * `recordDate` come from the caller's already-loaded record so the
   * changelog row reads without an extra fetch.
   */
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
    const session = await this.getSession();
    if (!session) throw new SupabaseError('Not authenticated.');
    const userId = session.user.id;
    const bytes = base64ToBytes(args.dataBase64);
    // base64ToBytes allocates a fresh (never shared) ArrayBuffer, so the
    // narrowing off ArrayBufferLike is safe; the cast just satisfies the DOM
    // lib's ArrayBuffer-vs-SharedArrayBuffer split.
    const contentHash = await sha256Hex(bytes.buffer as ArrayBuffer);

    // Per-record content dedup, matching the agent-side record_file_attach.
    // Re-attaching the identical file to a record is never wanted (it stacks
    // a duplicate thumbnail), so probe by (record_id, content_hash) first and
    // short-circuit to the existing row - no upload, no insert, no changelog.
    const { data: dup, error: dupErr } = await this.client
      .from('wiki_record_files')
      .select(
        'id, record_id, position, filename, mime_type, size_bytes, storage_path, extracted_text, created_at'
      )
      .eq('record_id', args.recordId)
      .eq('content_hash', contentHash)
      .limit(1)
      .maybeSingle();
    if (dupErr) throw new SupabaseError(dupErr.message);
    if (dup) return coerceWikiRecordFile(dup as Record<string, unknown>);

    const id = crypto.randomUUID();
    const path = `${userId}/${id}/${args.filename}`;
    const { error: upErr } = await this.client.storage
      .from('wiki-record-files')
      .upload(path, bytes, {
        contentType: args.mimeType ?? undefined,
        upsert: true,
      });
    if (upErr) throw new SupabaseError(upErr.message);
    const { data, error } = await this.client
      .from('wiki_record_files')
      .insert({
        id,
        user_id: userId,
        record_id: args.recordId,
        position: args.position,
        filename: args.filename,
        mime_type: args.mimeType,
        size_bytes: args.sizeBytes,
        storage_path: path,
        content_hash: contentHash,
        extracted_text: args.extractedText ?? null,
      })
      .select(
        'id, record_id, position, filename, mime_type, size_bytes, storage_path, extracted_text, created_at'
      )
      .single();
    if (error) throw new SupabaseError(error.message);
    const file = coerceWikiRecordFile(data as Record<string, unknown>);
    await this.appendRecordChangelogMessage(
      args.articleId,
      'record_update',
      buildRecordFileChangelogMessage(
        'attach',
        args.recordDate,
        file.filename,
        (file.mime_type ?? '').startsWith('image/')
      )
    );
    return file;
  }

  /**
   * Delete a record file: remove the bucket object (best-effort - the
   * daily wiki-record-file-gc sweep reclaims a miss) then the row, and
   * changelog the removal. Reads the file + its record up front so the
   * changelog row can name the file even though both are gone afterward.
   */
  async deleteWikiRecordFile(id: string): Promise<void> {
    const { data: fileRow } = await this.client
      .from('wiki_record_files')
      .select('id, record_id, filename, mime_type, storage_path')
      .eq('id', id)
      .maybeSingle();
    const file = fileRow ? coerceWikiRecordFile(fileRow as Record<string, unknown>) : null;
    const record = file ? await this.getWikiRecord(file.record_id) : null;
    if (file?.storage_path) {
      // Best-effort: a failed object remove is reclaimed by the GC sweep.
      await this.client.storage.from('wiki-record-files').remove([file.storage_path]);
    }
    const { error } = await this.client.from('wiki_record_files').delete().eq('id', id);
    if (error) throw new SupabaseError(error.message);
    if (file && record) {
      await this.appendRecordChangelogMessage(
        record.article_id,
        'record_update',
        buildRecordFileChangelogMessage(
          'remove',
          record.date,
          file.filename,
          (file.mime_type ?? '').startsWith('image/')
        )
      );
    }
  }

  // --- wiki record links -----------------------------------------------

  /**
   * Every link touching `recordId`, projected from that record's point of
   * view: outgoing edges (this record -> other) and incoming edges (other
   * -> this record), each carrying the OTHER record's date + content for
   * the row label. Two queries plus one batched fetch of the endpoints -
   * avoids the two-FK-to-one-table PostgREST embedding ambiguity.
   */
  async listWikiRecordLinks(recordId: string): Promise<WikiRecordLinkView[]> {
    const [outRes, inRes] = await Promise.all([
      this.client
        .from('wiki_record_links')
        .select('id, from_record_id, to_record_id, label, created_at')
        .eq('from_record_id', recordId),
      this.client
        .from('wiki_record_links')
        .select('id, from_record_id, to_record_id, label, created_at')
        .eq('to_record_id', recordId),
    ]);
    if (outRes.error) throw new SupabaseError(outRes.error.message);
    if (inRes.error) throw new SupabaseError(inRes.error.message);
    const outgoing = (outRes.data ?? []).map((r) =>
      coerceWikiRecordLink(r as Record<string, unknown>)
    );
    const incoming = (inRes.data ?? []).map((r) =>
      coerceWikiRecordLink(r as Record<string, unknown>)
    );
    // The other endpoint of each edge.
    const otherIds = new Set<string>();
    for (const l of outgoing) otherIds.add(l.to_record_id);
    for (const l of incoming) otherIds.add(l.from_record_id);
    if (otherIds.size === 0) return [];
    const { data: recRows, error: recErr } = await this.client
      .from('wiki_records')
      .select('id, article_id, date, content')
      .in('id', Array.from(otherIds));
    if (recErr) throw new SupabaseError(recErr.message);
    const byId = new Map<
      string,
      { id: string; article_id: string; date: string; content: string }
    >();
    for (const r of recRows ?? []) {
      const row = r as Record<string, unknown>;
      byId.set(String(row.id), {
        id: String(row.id),
        article_id: String(row.article_id ?? ''),
        date: typeof row.date === 'string' ? row.date : '',
        content: typeof row.content === 'string' ? row.content : '',
      });
    }
    const views: WikiRecordLinkView[] = [];
    for (const l of outgoing) {
      const other = byId.get(l.to_record_id);
      if (other) views.push({ id: l.id, direction: 'outgoing', label: l.label, record: other });
    }
    for (const l of incoming) {
      const other = byId.get(l.from_record_id);
      if (other) views.push({ id: l.id, direction: 'incoming', label: l.label, record: other });
    }
    return views;
  }

  /**
   * Create or relabel a directed edge between two records. The unique
   * (from, to) constraint makes this an upsert on the pair - re-linking
   * updates the label rather than duplicating the edge. Changelogs the
   * link against the FROM record's article, naming the target record.
   */
  async createWikiRecordLink(args: {
    fromRecordId: string;
    toRecordId: string;
    label?: string | null;
  }): Promise<WikiRecordLink> {
    const session = await this.getSession();
    if (!session) throw new SupabaseError('Not authenticated.');
    const { data, error } = await this.client
      .from('wiki_record_links')
      .upsert(
        {
          user_id: session.user.id,
          from_record_id: args.fromRecordId,
          to_record_id: args.toRecordId,
          label: args.label ?? null,
        },
        { onConflict: 'from_record_id,to_record_id' }
      )
      .select('id, from_record_id, to_record_id, label, created_at')
      .single();
    if (error) throw new SupabaseError(error.message);
    const link = coerceWikiRecordLink(data as Record<string, unknown>);
    const [fromRec, toRec] = await Promise.all([
      this.getWikiRecord(args.fromRecordId),
      this.getWikiRecord(args.toRecordId),
    ]);
    if (fromRec && toRec) {
      await this.appendRecordChangelogMessage(
        fromRec.article_id,
        'record_update',
        buildRecordLinkChangelogMessage('create', toRec.date, toRec.content, link.label)
      );
    }
    return link;
  }

  async deleteWikiRecordLink(args: {
    fromRecordId: string;
    toRecordId: string;
  }): Promise<void> {
    const [fromRec, toRec] = await Promise.all([
      this.getWikiRecord(args.fromRecordId),
      this.getWikiRecord(args.toRecordId),
    ]);
    const { error } = await this.client
      .from('wiki_record_links')
      .delete()
      .eq('from_record_id', args.fromRecordId)
      .eq('to_record_id', args.toRecordId);
    if (error) throw new SupabaseError(error.message);
    if (fromRec && toRec) {
      await this.appendRecordChangelogMessage(
        fromRec.article_id,
        'record_update',
        buildRecordLinkChangelogMessage('delete', toRec.date, toRec.content, null)
      );
    }
  }

  // Documents (Library) --------------------------------------------------
  //
  // Upload flow is two-phase on purpose: createDocument writes the metadata
  // row first (status 'pending', storage_path null), then the caller uploads
  // the binary to the bucket and calls setDocumentStoragePath, then extracts
  // text in the browser and calls setDocumentExtraction.
  // Splitting it this way means a row always exists for the UI to show a
  // "processing" placeholder, and a crash mid-upload leaves a recoverable
  // pending row rather than an orphaned bucket object.

  // --- Library / documents ---------------------------------------------

  async createDocument(args: {
    title: string;
    description?: string;
    filename: string;
    mimeType: string;
    sizeBytes: number;
  }): Promise<Document> {
    const session = await this.getSession();
    if (!session) throw new SupabaseError('Not authenticated.');
    const { data, error } = await this.client
      .from('documents')
      .insert({
        user_id: session.user.id,
        title: args.title,
        description: args.description ?? '',
        filename: args.filename,
        mime_type: args.mimeType,
        size_bytes: args.sizeBytes,
      })
      .select(
        'id, title, description, filename, mime_type, size_bytes, storage_path, extracted_text, extraction_status, extraction_error, created_at, updated_at'
      )
      .single();
    if (error) throw new SupabaseError(error.message);
    return coerceDocument(data as Record<string, unknown>);
  }

  async setDocumentStoragePath(id: string, storagePath: string): Promise<void> {
    const { error } = await this.client
      .from('documents')
      .update({ storage_path: storagePath })
      .eq('id', id);
    if (error) throw new SupabaseError(error.message);
  }

  /**
   * Record the outcome of the browser-side text extraction. On success pass
   * the extracted text and status 'done'; on failure pass status 'failed' and
   * a trimmed error so the Library UI can explain why the doc isn't
   * searchable. The original file stays downloadable either way.
   */
  async setDocumentExtraction(
    id: string,
    result:
      | { status: 'done'; text: string }
      | { status: 'failed'; error: string }
  ): Promise<void> {
    const patch: Record<string, unknown> =
      result.status === 'done'
        ? { extraction_status: 'done', extracted_text: result.text, extraction_error: null }
        : { extraction_status: 'failed', extraction_error: result.error.slice(0, 500) };
    const { error } = await this.client.from('documents').update(patch).eq('id', id);
    if (error) throw new SupabaseError(error.message);
  }

  /**
   * One offset page of the Library list, newest first. Powers the drawer's
   * infinite scroll. `id` is the final tiebreak so docs sharing a created_at
   * keep a stable cross-page order.
   */
  async listDocumentsPage(opts: {
    offset: number;
    pageSize: number;
  }): Promise<OffsetPage<Document>> {
    const { data, error } = await this.client
      .from('documents')
      .select(
        'id, title, description, filename, mime_type, size_bytes, storage_path, extracted_text, extraction_status, extraction_error, created_at, updated_at'
      )
      .order('created_at', { ascending: false })
      .order('id', { ascending: true })
      .range(opts.offset, opts.offset + opts.pageSize);
    if (error) throw new SupabaseError(error.message);
    const all = (data ?? []).map((row) => coerceDocument(row as Record<string, unknown>));
    const hasMore = all.length > opts.pageSize;
    return { rows: hasMore ? all.slice(0, opts.pageSize) : all, hasMore };
  }

  async getDocumentById(id: string): Promise<Document | null> {
    const { data, error } = await this.client
      .from('documents')
      .select(
        'id, title, description, filename, mime_type, size_bytes, storage_path, extracted_text, extraction_status, extraction_error, created_at, updated_at'
      )
      .eq('id', id)
      .maybeSingle();
    if (error) throw new SupabaseError(error.message);
    if (!data) return null;
    return coerceDocument(data as Record<string, unknown>);
  }

  /**
   * Substring search over the user's documents for the Library drawer, newest
   * first. Matches the query against title, description, filename, and the
   * extracted body, so a document surfaces whether the user typed its name or a
   * phrase from inside it. This is the drawer's browse-by-keyword surface; the
   * chat model's precise in-document search is grep_documents (doc_grep).
   */
  async searchDocuments(opts: { query: string; limit?: number }): Promise<Document[]> {
    const query = opts.query.trim();
    if (query.length === 0) return [];
    const pattern = ilikeLogicTreePattern(query);
    const { data, error } = await this.client
      .from('documents')
      .select(
        'id, title, description, filename, mime_type, size_bytes, storage_path, extracted_text, extraction_status, extraction_error, created_at, updated_at'
      )
      .or(
        `title.ilike.${pattern},description.ilike.${pattern},filename.ilike.${pattern},extracted_text.ilike.${pattern}`
      )
      .order('created_at', { ascending: false })
      .limit(opts.limit ?? 100);
    if (error) throw new SupabaseError(error.message);
    return (data ?? []).map((row) => coerceDocument(row as Record<string, unknown>));
  }

  /**
   * Patch a document's user-editable metadata (title, description). The
   * extracted body is bound to the original file and is not editable here -
   * replacing content means re-uploading the file.
   */
  async updateDocument(
    id: string,
    patch: { title?: string; description?: string }
  ): Promise<Document> {
    const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (patch.title !== undefined) update.title = patch.title;
    if (patch.description !== undefined) update.description = patch.description;
    const { data, error } = await this.client
      .from('documents')
      .update(update)
      .eq('id', id)
      .select(
        'id, title, description, filename, mime_type, size_bytes, storage_path, extracted_text, extraction_status, extraction_error, created_at, updated_at'
      )
      .single();
    if (error) throw new SupabaseError(error.message);
    return coerceDocument(data as Record<string, unknown>);
  }

  /**
   * Delete a document, its chunks (FK cascade), and its original file in the
   * bucket. The bucket object is removed first; if that fails we still throw
   * before deleting the row, so we never orphan a bucket object behind a
   * deleted row. A leftover row whose object is already gone is the safer
   * failure direction (the UI can retry the delete).
   */
  async deleteDocument(id: string): Promise<void> {
    const doc = await this.getDocumentById(id);
    if (doc?.storage_path) {
      const { error: rmErr } = await this.client.storage
        .from('documents')
        .remove([doc.storage_path]);
      if (rmErr) throw new SupabaseError(rmErr.message);
    }
    const { error } = await this.client.from('documents').delete().eq('id', id);
    if (error) throw new SupabaseError(error.message);
  }

  // Documents Storage helpers --------------------------------------------

  /**
   * Upload an original file to the private `documents` bucket. The object key
   * convention `<user_id>/<document_id>/<filename>` is what the bucket RLS
   * policy keys on (top-level folder must equal auth.uid()).
   */
  async uploadDocumentFile(args: {
    documentId: string;
    filename: string;
    file: Blob;
    contentType: string;
  }): Promise<string> {
    const session = await this.getSession();
    if (!session) throw new SupabaseError('Not authenticated.');
    const path = `${session.user.id}/${args.documentId}/${args.filename}`;
    const { error } = await this.client.storage
      .from('documents')
      .upload(path, args.file, { contentType: args.contentType, upsert: true });
    if (error) throw new SupabaseError(error.message);
    return path;
  }

  /**
   * Time-limited signed URL for downloading an original file. The bucket is
   * private, so this is the only way the browser surfaces the binary.
   */
  async createDocumentDownloadUrl(storagePath: string, expiresInSeconds = 300): Promise<string> {
    const { data, error } = await this.client.storage
      .from('documents')
      .createSignedUrl(storagePath, expiresInSeconds);
    if (error) throw new SupabaseError(error.message);
    return data.signedUrl;
  }

  // Documents grep / read helpers ----------------------------------------
  //
  // The deterministic grep-then-read pair the chat model uses on a document.
  // Both run server-side over documents.extracted_text (see grep_documents /
  // read_document_lines in schema.sql) so a multi-MB document's text never
  // crosses the wire - only matching snippets or the requested line range come
  // back.

  // --- Wiki sources, changelog & agent runs ----------------------------

  /**
   * Return the bibliography for one article: every thread that has
   * been attributed, joined with the thread's title, ordered by
   * `last_processed_at` ascending so the reader sees the article's
   * narrative of growth (oldest contributing conversation first).
   *
   * Threads hard-deleted out from under their attribution rows show
   * up with a null title until the cascade catches up; the UI handles
   * that with a placeholder.
   */
  async listWikiArticleSources(articleId: string): Promise<WikiArticleSource[]> {
    const { data, error } = await this.client
      .from('wiki_article_sources')
      .select('thread_id, first_processed_at, last_processed_at, threads(title)')
      .eq('article_id', articleId)
      .order('last_processed_at', { ascending: true });
    if (error) throw new SupabaseError(error.message);
    const out: WikiArticleSource[] = [];
    for (const row of (data ?? []) as Array<Record<string, unknown>>) {
      const threadId = row.thread_id;
      if (typeof threadId !== 'string') continue;
      const thread = row.threads as { title?: unknown } | null;
      const title =
        thread && typeof thread.title === 'string' ? thread.title : null;
      out.push({
        thread_id: threadId,
        thread_title: title,
        first_processed_at: String(row.first_processed_at ?? ''),
        last_processed_at: String(row.last_processed_at ?? ''),
      });
    }
    return out;
  }

  /**
   * Batched source-thread lookup for a candidate set of article ids.
   * Returns a Map keyed by article id whose value is the set of thread
   * ids that fed that article. Articles with no rows in
   * `wiki_article_sources` are absent from the map (orphan articles -
   * never written from a recorded conversation).
   *
   * Powers the sole-source exclusion in `searchWikiArticlesSemantic`
   * (src/lib/wiki.ts, the `excludeSoleSourceThreadId` option; the
   * venice function's wiki_search carries the same filter on its tool
   * context): the recall path needs to know
   * "is the current thread the ONLY source of this article?", which is
   * cheaper to answer against an in-memory map of all sources for the
   * returned candidates than as a per-article round-trip. Empty input
   * returns an empty Map without a round-trip.
   */
  async listSourceThreadIdsForArticles(
    articleIds: readonly string[]
  ): Promise<Map<string, Set<string>>> {
    const out = new Map<string, Set<string>>();
    if (articleIds.length === 0) return out;
    const { data, error } = await this.client
      .from('wiki_article_sources')
      .select('article_id, thread_id')
      .in('article_id', [...articleIds]);
    if (error) throw new SupabaseError(error.message);
    for (const row of (data ?? []) as Array<Record<string, unknown>>) {
      const articleId = row.article_id;
      const threadId = row.thread_id;
      if (typeof articleId !== 'string' || typeof threadId !== 'string') continue;
      const set = out.get(articleId);
      if (set) set.add(threadId);
      else out.set(articleId, new Set([threadId]));
    }
    return out;
  }

  /**
   * See Also for an article. Single RPC call; the floor calculation
   * (minimum cosine similarity between the article and its source
   * conversations) lives server-side so the client never has to fetch
   * raw embeddings.
   *
   * Returns an empty array when the article has no embedding yet (the
   * embeddings worker hasn't caught up after a content change),
   * when no other articles clear the floor, or when there are simply
   * no other articles. All three are honest "nothing to suggest".
   */
  async findRelatedWikiArticles(
    articleId: string,
    limit = 5
  ): Promise<WikiArticleRelated[]> {
    const { data, error } = await this.client.rpc('find_related_wiki_articles', {
      p_article_id: articleId,
      p_limit: limit,
    });
    if (error) throw new SupabaseError(error.message);
    const out: WikiArticleRelated[] = [];
    for (const row of (data ?? []) as Array<Record<string, unknown>>) {
      const id = row.id;
      const title = row.title;
      const similarity = row.similarity;
      if (typeof id !== 'string' || typeof title !== 'string') continue;
      out.push({
        id,
        title,
        similarity: typeof similarity === 'number' ? similarity : 0,
      });
    }
    return out;
  }

  /**
   * Append a wiki-changelog row. Called by every wiki write path: the
   * three tools (`wiki_create`/`wiki_update`/`wiki_delete`), the
   * librarian's same three tools, and the user's direct edits in
   * Wiki.svelte. Throws on a failed insert so callers can decide
   * whether to surface the error or swallow it - the tool path
   * currently swallows (the mutation already landed; a missed
   * changelog row is a smaller harm than a confusing post-success
   * error).
   *
   * `article_id` is null for deletes (the article is already gone by
   * the time this lands). For create/update it points at the live
   * article; if the article is later deleted the FK cascades to null
   * but `title_at_change` keeps the row meaningful.
   */
  async createWikiChangelogEntry(args: {
    article_id: string | null;
    kind: WikiChangelogKind;
    title_at_change: string;
    message: string;
  }): Promise<void> {
    const session = await this.getSession();
    if (!session) throw new SupabaseError('Not authenticated.');
    const title = args.title_at_change.trim();
    const message = args.message.trim();
    if (title.length === 0 || message.length === 0) return;
    const { error } = await this.client.from('wiki_changelog').insert({
      user_id: session.user.id,
      article_id: args.article_id,
      kind: args.kind,
      title_at_change: title,
      message,
    });
    if (error) throw new SupabaseError(error.message);
  }

  /**
   * Paged listing of the wiki changelog, newest first. `before` is the
   * exclusive cursor in `created_at desc` order - pass the last entry's
   * `created_at` from the prior page to fetch the next one. The
   * (user_id, created_at desc) index makes this a one-row-per-page
   * range scan rather than a sort, so the modal can lazy-load deep
   * history cheaply.
   */
  async listWikiChangelog(opts: {
    limit?: number;
    before?: string | null;
  } = {}): Promise<WikiChangelogEntry[]> {
    const limit = Math.max(1, Math.min(opts.limit ?? 50, 200));
    let q = this.client
      .from('wiki_changelog')
      .select('id, article_id, kind, title_at_change, message, created_at')
      .order('created_at', { ascending: false })
      .limit(limit);
    if (opts.before) q = q.lt('created_at', opts.before);
    const { data, error } = await q;
    if (error) throw new SupabaseError(error.message);
    const out: WikiChangelogEntry[] = [];
    for (const row of (data ?? []) as Array<Record<string, unknown>>) {
      const entry = coerceWikiChangelogEntry(row);
      if (entry) out.push(entry);
    }
    return out;
  }

  /**
   * Nuke the wiki subsystem for the current user. Deletes every
   * `wiki_articles` row and nulls `last_wiki_processed_msg_id` + the
   * wiki claim columns on the user's threads so the per-conversation
   * agent re-evaluates from scratch. Wraps both statements in a single
   * server-side transaction (see `reset_wiki_data` in schema.sql) so
   * the articles and the per-thread pipeline state stay in lockstep.
   *
   * Callers (Settings -> Wiki -> Reset) MUST gate this behind an
   * explicit user confirmation - it's irreversible.
   */
  async resetWikiData(): Promise<void> {
    const { error } = await this.client.rpc('reset_wiki_data');
    if (error) throw new SupabaseError(error.message);
  }

  /**
   * Semantic + substring search over wiki articles. Vector hits first
   * (RPC), then unembedded ILIKE hits, deduped by id. Empty `query`
   * returns the alphabetical listing without embedding.
   * `queryEmbedding` may be null - callers without Venice get
   * ILIKE-only results.
   */
  async searchWikiArticles(opts: {
    query: string;
    queryEmbedding: number[] | null;
    limit?: number;
  }): Promise<WikiArticle[]> {
    const query = opts.query.trim();
    const limit = opts.limit ?? 20;
    if (query.length === 0) return this.listWikiArticles({ limit });

    const pattern = ilikeLogicTreePattern(query);

    const ilikePromise = this.client
      .from('wiki_articles')
      .select('id, title, content, favorite, created_at, updated_at')
      .or(`title.ilike.${pattern},content.ilike.${pattern}`)
      .order('title', { ascending: true })
      .limit(limit);

    const semanticPromise = opts.queryEmbedding
      ? this.client.rpc('search_wiki_articles_by_embedding', {
          query_embedding: opts.queryEmbedding,
          match_limit: limit,
        })
      : Promise.resolve({ data: [] as unknown[], error: null });

    const [ilikeRes, semRes] = await Promise.all([ilikePromise, semanticPromise]);
    if (ilikeRes.error) throw new SupabaseError(ilikeRes.error.message);
    const ilikeRows = (ilikeRes.data ?? []).map((row) =>
      coerceWikiArticle(row as Record<string, unknown>)
    );
    const semanticRows =
      semRes.error !== null
        ? []
        : ((semRes.data ?? []) as unknown[]).map((row) =>
            coerceWikiArticle(row as Record<string, unknown>)
          );

    const out: WikiArticle[] = [];
    const seen = new Set<string>();
    // Semantic first - meaning matches outrank substring matches.
    for (const a of semanticRows) {
      if (seen.has(a.id)) continue;
      seen.add(a.id);
      out.push(a);
      if (out.length >= limit) return out;
    }
    for (const a of ilikeRows) {
      if (seen.has(a.id)) continue;
      seen.add(a.id);
      out.push(a);
      if (out.length >= limit) return out;
    }
    return out;
  }

  // Wiki background pipeline ---------------------------------------------

  /**
   * List the user's wiki-skipped threads, most recent first. The
   * Wiki tab's Skipped panel renders this; a row drops off the list
   * automatically when the next successful wiki run on that thread
   * clears the skip marker (mark_thread_wiki_processed_if_claimed
   * nulls both columns in one update).
   */
  async listWikiSkippedThreads(): Promise<
    {
      threadId: string;
      title: string | null;
      lastSkipAt: string;
      lastSkipReason: string | null;
      /**
       * A per-thread wiki claim is currently held - a manual retry (or
       * the sweep's recovery branch) is processing this thread. The
       * Skipped panel renders it as "Retrying..." and recovers the
       * in-flight state across a reload, since the claim is durable
       * server state rather than the panel's in-memory spinner.
       */
      retrying: boolean;
    }[]
  > {
    const { data, error } = await this.client.rpc('list_wiki_skipped_threads');
    if (error) throw new SupabaseError(error.message);
    const rows = (data ?? []) as {
      thread_id: string;
      title: string | null;
      last_skip_at: string;
      last_skip_reason: string | null;
      retrying: boolean | null;
    }[];
    return rows.map((r) => ({
      threadId: r.thread_id,
      title: r.title,
      lastSkipAt: r.last_skip_at,
      lastSkipReason: r.last_skip_reason,
      retrying: r.retrying === true,
    }));
  }

  /**
   * Ask the venice function to re-run the wiki agent against one
   * skipped thread (the Skipped panel's Retry button). The whole retry
   * cycle - per-thread claim, terminal-message resolution, the agent's
   * tool loop with the content-filter fallback, the pointer advance that
   * clears the skip marker, claim release - runs server-side under
   * EdgeRuntime.waitUntil, so it survives a reload mid-retry; this is a
   * thin authenticated POST. `busy` means the thread was already claimed
   * (the sweep, or a concurrent retry). Agent-level failures come back as
   * `kind: 'error'` in the union (an application outcome, not a transport
   * error); only transport/auth failures throw.
   */
  async retryWikiThread(threadId: string): Promise<WikiRetryResult> {
    const { data, error } = await this.client.functions.invoke('venice/wiki-retry', {
      body: { threadId },
    });
    if (error) throw await veniceFunctionError(error);
    const result = data as Partial<WikiRetryResult> | null;
    // Boundary validation: the function returns the union below; an
    // unrecognised shape collapses to an error result rather than
    // letting a malformed payload masquerade as success.
    if (result && result.kind === 'ok' && typeof result.terminalMsgId === 'string') {
      return {
        kind: 'ok',
        terminalMsgId: result.terminalMsgId,
        toolCalls: typeof result.toolCalls === 'number' ? result.toolCalls : 0,
        reasoning: typeof result.reasoning === 'string' ? result.reasoning : '(none)',
      };
    }
    if (result && result.kind === 'no-op' && typeof result.reason === 'string') {
      return { kind: 'no-op', reason: result.reason };
    }
    if (result && result.kind === 'error' && typeof result.error === 'string') {
      return { kind: 'error', error: result.error };
    }
    return { kind: 'error', error: 'wiki-retry returned an unrecognised response' };
  }

  /**
   * Ask the venice function to run the manual per-article wiki agent
   * (the "Ask agent to update" panel). The prompt build, the single
   * JSON completion, and the article + record reads all happen
   * server-side; this is a thin authenticated POST. Returns the
   * preview / noop the panel renders. The function's union also has a
   * kind:'error' for parse / read / transport failures - this method
   * turns that (and any transport/auth failure) into a thrown Error so
   * the panel's existing catch shows a retry banner; callers only ever
   * see preview or noop on a resolved promise.
   */
  async runWikiManualUpdate(args: {
    articleId: string;
    instructions: string;
  }): Promise<WikiManualUpdateResult> {
    const { data, error } = await this.client.functions.invoke('venice/wiki-manual-update', {
      body: { articleId: args.articleId, instructions: args.instructions },
    });
    if (error) throw await veniceFunctionError(error);
    // Boundary validation: the function returns the preview / noop /
    // error union below. An error outcome becomes a throw (the panel
    // wants a banner, not an inline kind); an unrecognised shape throws
    // too rather than masquerading as a no-op.
    const result = data as
      | Partial<WikiManualUpdateResult>
      | { kind?: string; error?: unknown }
      | null;
    if (
      result &&
      result.kind === 'preview' &&
      typeof (result as { title?: unknown }).title === 'string' &&
      typeof (result as { content?: unknown }).content === 'string'
    ) {
      const preview = result as Extract<WikiManualUpdateResult, { kind: 'preview' }>;
      return {
        kind: 'preview',
        title: preview.title,
        content: preview.content,
        reason: typeof preview.reason === 'string' ? preview.reason : '',
        recordOps: Array.isArray(preview.recordOps) ? preview.recordOps : [],
      };
    }
    if (result && result.kind === 'noop') {
      const reason =
        typeof (result as { reason?: unknown }).reason === 'string'
          ? (result as { reason: string }).reason
          : 'No change applied.';
      return { kind: 'noop', reason };
    }
    if (
      result &&
      result.kind === 'error' &&
      typeof (result as { error?: unknown }).error === 'string'
    ) {
      throw new Error((result as { error: string }).error);
    }
    throw new Error('wiki-manual-update returned an unrecognised response');
  }

  /**
   * Ask the venice function to run the wiki librarian now (the Wiki
   * panel's sparkles button). The whole run - article snapshot,
   * prompt build, the tool loop, the in-flight guard shared with the
   * scheduled sweep and the chat-dispatched path - happens
   * server-side; this is a thin authenticated POST. `runId` is the
   * client-minted demux key for the live step events: subscribe via
   * subscribeToAgentRunProgress BEFORE calling this, or the first
   * events race the subscription.
   */
  async runWikiLibrarian(args: {
    instructions: string | null;
    runId: string;
  }): Promise<void> {
    // Detached route: the body is {accepted:true} and the run continues
    // in the background past the gateway window. The outcome arrives
    // later as a `result` event on the agent-runs channel (await it via
    // awaitDetachedRun), so this POST only KICKS the run - a non-error
    // response means accepted. A transport/auth failure throws.
    const { error } = await this.client.functions.invoke('venice/wiki-librarian-run', {
      body: { instructions: args.instructions, runId: args.runId },
    });
    if (error) throw await veniceFunctionError(error);
  }

  /**
   * Ask the venice function to run the rem (associative integration)
   * memory-librarian pass now (the Memories panel's manual button).
   * The whole run - eligibility pick, prompt build, the tool loop,
   * the in-flight guard shared with the scheduled sweeps and the
   * deep-sleep paths - happens server-side; this is a thin
   * authenticated POST. `runId` is the client-minted demux key for
   * the live step events: subscribe via subscribeToAgentRunProgress
   * BEFORE calling this, or the first events race the subscription.
   */
  async runRem(args: { runId: string }): Promise<void> {
    // Detached route: the body is {accepted:true} and the run continues
    // in the background past the gateway window. The RemRunResult arrives
    // later as a `result` event on the agent-runs channel (await it via
    // awaitDetachedRun), so this POST only KICKS the run - a non-error
    // response means accepted. A transport/auth failure throws.
    const { error } = await this.client.functions.invoke('venice/rem-run', {
      body: { runId: args.runId },
    });
    if (error) throw await veniceFunctionError(error);
  }

  /**
   * Ask the venice function to run the deep-sleep memory-librarian
   * pass now. Same contract as runRem (and the wiki librarian's
   * runWikiLibrarian): subscribe to the progress channel before the
   * POST; the in-flight collision comes back as kind 'busy'.
   */
  async runDeepSleep(args: { runId: string }): Promise<void> {
    // Detached route, same contract as runRem: returns {accepted:true};
    // the DeepSleepRunResult arrives as a `result` event on the
    // agent-runs channel (await via awaitDetachedRun). KICK only.
    const { error } = await this.client.functions.invoke('venice/deep-sleep-run', {
      body: { runId: args.runId },
    });
    if (error) throw await veniceFunctionError(error);
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
