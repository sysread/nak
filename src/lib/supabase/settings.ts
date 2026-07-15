/**
 * Settings domain slice of the Supabase data layer: the
 * profiles.settings jsonb reads/writes (getSettings, updateSettings)
 * plus the app_config price-caps read the model pickers consult.
 *
 * Plain async functions taking the shared SupabaseClient as their
 * first argument - no class, no state - so each can be unit-tested
 * against a stubbed client without constructing SupabaseService. The
 * SupabaseService facade (../supabase.ts) delegates its settings
 * methods here one-for-one under the same names; UI code calls
 * `app.supabase.<method>()` and should not import this module
 * directly. The UserSettings shape and its coercers live in
 * ./types/settings.ts.
 *
 * The Venice edge-function proxy calls that used to share a banner
 * with these methods live in ./venice-proxy.ts - settings CRUD and
 * edge-function invocation are separate concerns.
 */
import type { SupabaseClient, Session } from '@supabase/supabase-js';
import { SupabaseError } from './error';
import {
  coerceSettings,
  coerceSystemPrompt,
  USER_PROFILE_FIELD_MAX,
} from './types';
import type { UserSettings, SystemPrompt } from './types';
import { coerceModelProfiles } from '../models';
import {
  coercePriceCaps,
  NO_PRICE_CAPS,
  type ModelPriceCaps,
} from '../models/price-caps';
import { isAccent, isColorMode, isUiStyle } from '../theme';
import { isLogLevel } from '../logger.svelte';

/**
 * Mirror of the facade's getSession: unwrap client.auth.getSession(),
 * throwing SupabaseError on failure. Private to this slice so the
 * settings reads/writes keep their exact error behavior without
 * reaching back into SupabaseService.
 */
async function getSession(client: SupabaseClient): Promise<Session | null> {
  const { data, error } = await client.auth.getSession();
  if (error) throw new SupabaseError(error.message);
  return data.session;
}

export async function getSettings(client: SupabaseClient): Promise<UserSettings> {
  const session = await getSession(client);
  if (!session) throw new SupabaseError('Not authenticated.');
  const { data, error } = await client
    .from('profiles')
    .select('settings')
    .eq('user_id', session.user.id)
    .maybeSingle();
  if (error) throw new SupabaseError(error.message);
  return coerceSettings((data as { settings?: unknown } | null)?.settings);
}

/**
 * Read the project-global model price caps from app_config. Selects only
 * the cap columns - never venice_api_key - so the shared key stays off
 * the wire to the browser even though RLS would permit reading the whole
 * row. Returns NO_PRICE_CAPS on any error or an unseeded row so a fetch
 * failure degrades to "no cap" (the picker shows everything) rather than
 * throwing - the server is the real enforcement point regardless.
 */
export async function getPriceCaps(client: SupabaseClient): Promise<ModelPriceCaps> {
  const { data, error } = await client
    .from('app_config')
    .select('max_input_usd_per_m, max_output_usd_per_m, max_image_usd')
    .eq('id', true)
    .maybeSingle();
  if (error || !data) return NO_PRICE_CAPS;
  return coercePriceCaps(data);
}

/**
 * Merge a partial settings patch into the profiles.settings jsonb.
 *
 * Atomic via the `merge_profile_settings` RPC: this builds a validated
 * `set` object (the top-level keys to write) plus a `remove` list (keys
 * to drop) and the database applies both in one UPDATE against the live
 * row. The earlier read-then-write shape (fetch the whole blob, merge a
 * key in JS, write it back) lost a field whenever two writes overlapped
 * - both read the pre-write blob, so the second clobbered the first.
 * That bit single-tab too: flipping two adjacent toggles in quick
 * succession, or a fire-and-forget theme write racing a toggle, dropped
 * one of the changes intermittently. The merge happening server-side in
 * a single statement removes that window. See `merge_profile_settings`
 * in supabase/schema.sql.
 *
 * The scrub below is unchanged: only known keys pass, each validated.
 * A `patch[field] === undefined` (or an empty profile string) deletes
 * the field; a present-but-invalid value is silently ignored so it
 * neither writes garbage nor clears the existing value.
 */
export async function updateSettings(
  client: SupabaseClient,
  patch: Partial<UserSettings>
): Promise<UserSettings> {
  const session = await getSession(client);
  if (!session) throw new SupabaseError('Not authenticated.');
  // toSet: top-level keys to write (shallow-merged server-side).
  // toRemove: keys to delete. A key lands in exactly one of the two,
  // or neither when its patch value fails validation.
  const toSet: Record<string, unknown> = {};
  const toRemove: string[] = [];
  if ('modelProfiles' in patch) {
    // Re-run the coercer so a sloppy caller can't persist a malformed
    // profile or a broken default invariant; an all-empty result
    // clears the key entirely (read-side substitutes the seed).
    const cleaned = coerceModelProfiles(patch.modelProfiles);
    if (cleaned) toSet.modelProfiles = cleaned;
    else toRemove.push('modelProfiles');
    // Clear the pre-profile keys in the same merge so a blob written
    // before profiles existed doesn't keep ghosting the retired tier
    // system alongside the profiles that replaced it.
    toRemove.push(
      'defaultModel',
      'tierModels',
      'defaultReasoningEffort',
      'defaultVerbosity'
    );
  }
  if ('imageModel' in patch) {
    // A non-empty string sets the override; undefined / empty clears it
    // so the server falls back to VENICE_DEFAULT_IMAGE_MODEL.
    if (typeof patch.imageModel === 'string' && patch.imageModel.length > 0) {
      toSet.imageModel = patch.imageModel;
    } else {
      toRemove.push('imageModel');
    }
  }
  if ('groceryShoppingStartedAt' in patch) {
    // Undefined clears the trip ("Finish shopping"); a parseable
    // timestamp starts one. Invalid strings are ignored, like every
    // other field.
    if (patch.groceryShoppingStartedAt === undefined) {
      toRemove.push('groceryShoppingStartedAt');
    } else if (
      typeof patch.groceryShoppingStartedAt === 'string' &&
      !Number.isNaN(Date.parse(patch.groceryShoppingStartedAt))
    ) {
      toSet.groceryShoppingStartedAt = patch.groceryShoppingStartedAt;
    }
  }
  if ('colorMode' in patch) {
    if (patch.colorMode === undefined) toRemove.push('colorMode');
    else if (isColorMode(patch.colorMode)) toSet.colorMode = patch.colorMode;
  }
  if ('accent' in patch) {
    if (patch.accent === undefined) toRemove.push('accent');
    else if (isAccent(patch.accent)) toSet.accent = patch.accent;
  }
  if ('uiStyle' in patch) {
    if (patch.uiStyle === undefined) toRemove.push('uiStyle');
    else if (isUiStyle(patch.uiStyle)) toSet.uiStyle = patch.uiStyle;
  }
  if ('systemPrompts' in patch) {
    if (patch.systemPrompts === undefined) toRemove.push('systemPrompts');
    else if (Array.isArray(patch.systemPrompts)) {
      // Run each prompt through the coercer so the stored shape is
      // always well-formed, regardless of caller sloppiness.
      const cleaned = patch.systemPrompts
        .map((p) => coerceSystemPrompt(p))
        .filter((p): p is SystemPrompt => p !== null);
      toSet.systemPrompts = cleaned;
    }
  }
  if ('defaultLogLevel' in patch) {
    if (patch.defaultLogLevel === undefined) toRemove.push('defaultLogLevel');
    else if (isLogLevel(patch.defaultLogLevel)) {
      toSet.defaultLogLevel = patch.defaultLogLevel;
    }
  }
  if ('emphasisMarkdown' in patch) {
    if (patch.emphasisMarkdown === undefined) toRemove.push('emphasisMarkdown');
    else if (typeof patch.emphasisMarkdown === 'boolean') {
      toSet.emphasisMarkdown = patch.emphasisMarkdown;
    }
  }
  if ('notifyOnComplete' in patch) {
    if (patch.notifyOnComplete === undefined) toRemove.push('notifyOnComplete');
    else if (typeof patch.notifyOnComplete === 'boolean') {
      toSet.notifyOnComplete = patch.notifyOnComplete;
    }
  }
  if ('wikiAutomaticEnabled' in patch) {
    if (patch.wikiAutomaticEnabled === undefined) {
      toRemove.push('wikiAutomaticEnabled');
    } else if (typeof patch.wikiAutomaticEnabled === 'boolean') {
      toSet.wikiAutomaticEnabled = patch.wikiAutomaticEnabled;
    }
  }
  if ('intentsEnabled' in patch) {
    if (patch.intentsEnabled === undefined) {
      toRemove.push('intentsEnabled');
    } else if (typeof patch.intentsEnabled === 'boolean') {
      toSet.intentsEnabled = patch.intentsEnabled;
    }
  }
  if ('wikiRecordExtractionEnabled' in patch) {
    if (patch.wikiRecordExtractionEnabled === undefined) {
      toRemove.push('wikiRecordExtractionEnabled');
    } else if (typeof patch.wikiRecordExtractionEnabled === 'boolean') {
      toSet.wikiRecordExtractionEnabled = patch.wikiRecordExtractionEnabled;
    }
  }
  if ('wikiLibrarianEnabled' in patch) {
    if (patch.wikiLibrarianEnabled === undefined) {
      toRemove.push('wikiLibrarianEnabled');
    } else if (typeof patch.wikiLibrarianEnabled === 'boolean') {
      toSet.wikiLibrarianEnabled = patch.wikiLibrarianEnabled;
    }
  }
  if ('memoryLibrarianEnabled' in patch) {
    if (patch.memoryLibrarianEnabled === undefined) {
      toRemove.push('memoryLibrarianEnabled');
    } else if (typeof patch.memoryLibrarianEnabled === 'boolean') {
      toSet.memoryLibrarianEnabled = patch.memoryLibrarianEnabled;
    }
  }
  if ('displayTimezone' in patch) {
    if (patch.displayTimezone === undefined) toRemove.push('displayTimezone');
    else if (
      typeof patch.displayTimezone === 'string' &&
      patch.displayTimezone.length > 0 &&
      patch.displayTimezone.length < 128
    ) {
      toSet.displayTimezone = patch.displayTimezone;
    }
    // Clear the legacy key in the same merge so a profile written
    // before the rename doesn't keep ghosting the old value
    // alongside the canonical one.
    toRemove.push('journalTimezone');
  }
  // Profile strings: an empty string from the patch means "clear
  // it" (the user blanked the input and hit save), so we delete
  // the key rather than persist `''`. coerceSettings drops empty
  // strings on read too, but persisting the absence keeps the
  // stored blob compact.
  if ('userName' in patch) {
    if (
      patch.userName === undefined ||
      (typeof patch.userName === 'string' && patch.userName.length === 0)
    ) {
      toRemove.push('userName');
    } else if (
      typeof patch.userName === 'string' &&
      patch.userName.length <= USER_PROFILE_FIELD_MAX
    ) {
      toSet.userName = patch.userName;
    }
  }
  if ('userLocation' in patch) {
    if (
      patch.userLocation === undefined ||
      (typeof patch.userLocation === 'string' && patch.userLocation.length === 0)
    ) {
      toRemove.push('userLocation');
    } else if (
      typeof patch.userLocation === 'string' &&
      patch.userLocation.length <= USER_PROFILE_FIELD_MAX
    ) {
      toSet.userLocation = patch.userLocation;
    }
  }
  const { data, error } = await client.rpc('merge_profile_settings', {
    p_set: toSet,
    p_remove: toRemove,
  });
  if (error) throw new SupabaseError(error.message);
  // The RPC returns the post-merge blob; coerce it so callers adopt the
  // canonical shape (e.g. an all-empty tierModels collapsing to absence)
  // exactly as a fresh getSettings would have.
  return coerceSettings(data);
}
