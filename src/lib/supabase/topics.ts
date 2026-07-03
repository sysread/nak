/**
 * Topic-vocabulary domain slice of the Supabase data layer: the
 * list_user_*_topics RPC wrappers behind the topic-filter dropdowns.
 * Its own module rather than a corner of the threads slice because
 * the vocabularies serve threads, memories, AND recipes alike -
 * parking them under any one consumer would misstate ownership.
 *
 * Plain async functions taking the shared SupabaseClient as their
 * first argument - no class, no state - so each can be unit-tested
 * against a stubbed client without constructing SupabaseService. The
 * SupabaseService facade (../supabase.ts) delegates its topic methods
 * here one-for-one under the same names; UI code calls
 * `app.supabase.<method>()` and should not import this module
 * directly. The TopicVocabulary shape and its parser live in ./types.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { SupabaseError } from './error';
import type { TopicVocabulary } from './types';
import { parseTopicVocabulary } from './types';

/**
 * Topic vocabulary + per-topic counts for the current user. Backs the
 * drawer's topic-filter dropdown; called on drawer mount and
 * refreshed after a tagging event. Returns the alphabetised topics
 * the server-side topics agent has assigned across all threads, each with its corpus
 * count, plus the count of zero-topic threads (the "(untagged)"
 * dropdown row the UI synthesises - never a member of `topics`).
 */
export async function listUserTopics(client: SupabaseClient): Promise<TopicVocabulary> {
  const { data, error } = await client.rpc('list_user_topics');
  if (error) throw new SupabaseError(error.message);
  return parseTopicVocabulary(data);
}

/**
 * Memory-topic vocabulary + per-topic counts for the current user.
 * Backs the Memories drawer's topic-filter dropdown; called on drawer
 * mount and refreshed after a tagging event. Counts span the whole
 * memory corpus, not the capped search-result set the panel holds.
 * The "(untagged)" pseudo-topic is NOT in `topics` - the UI
 * synthesises it from the `untagged` count.
 */
export async function listUserMemoryTopics(client: SupabaseClient): Promise<TopicVocabulary> {
  const { data, error } = await client.rpc('list_user_memory_topics');
  if (error) throw new SupabaseError(error.message);
  return parseTopicVocabulary(data);
}

/**
 * Recipe-topic vocabulary + per-topic counts for the current user.
 * Backs the Cookbook drawer's topic-filter dropdown. Distinct from
 * `listUserTopics` (threads) and `listUserMemoryTopics`
 * (memories) so a user's vocabularies don't cross-pollute.
 */
export async function listUserRecipeTopics(client: SupabaseClient): Promise<TopicVocabulary> {
  const { data, error } = await client.rpc('list_user_recipe_topics');
  if (error) throw new SupabaseError(error.message);
  return parseTopicVocabulary(data);
}
