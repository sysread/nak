// Shared "About the user" profile block for the wiki agents.
//
// The autonomous agent (./wiki.ts) and the manual per-article agent
// (./wiki_manual.ts) render an IDENTICAL profile block and read the
// same Settings -> AI -> About you fields, so the rendering + the DB
// read live here and both import them. The wiki librarian
// (./wiki_librarian.ts) deliberately keeps its OWN renderer - it is a
// CORRECTIVE variant (it tells the model to re-attribute or drop
// mis-named claims already on disk), genuinely different content, not
// a copy to fold in here.

import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * The user's name + location from Settings -> AI -> About you. Both
 * fields optional; null means "not set".
 */
export interface WikiUserProfile {
  name: string | null;
  location: string | null;
}

/**
 * Render the "About the user" block. Returns the empty string when
 * the profile is null or both fields are empty - a fresh account that
 * hasn't filled the Settings form pays zero tokens for the section.
 *
 * Two distinct rules around the name, both load-bearing:
 *
 *   1. POSITIVE: prefer the configured name over "the user" -
 *      articles read like a personal wiki rather than session notes.
 *   2. NEGATIVE: never invent another name. Production traffic showed
 *      the model writing articles about "Elliot" when the configured
 *      name was "Jeff", because the conversation mentioned a friend
 *      named Elliot and the model conflated the user with someone
 *      else in context.
 *
 * The unknown-name path (location set, name not) is split out so we
 * don't tell the model to "use their name" when no name was supplied.
 */
export function renderUserProfileBlock(profile: WikiUserProfile | null): string {
  if (!profile) return '';
  const name =
    profile.name && profile.name.trim().length > 0 ? profile.name.trim() : null;
  const location =
    profile.location && profile.location.trim().length > 0
      ? profile.location.trim()
      : null;
  if (!name && !location) return '';
  const lines: string[] = ['**About the user:**', ''];
  if (name) {
    lines.push(`The user's name is **${name}**.`);
    lines.push(
      `**Use "${name}" by default when an article refers to the user.** ` +
        `Avoid the generic phrase "the user" wherever "${name}" fits ` +
        `the sentence. This applies in articles ABOUT the user (the ` +
        `subject is ${name}), articles about projects ${name} is ` +
        `building ("${name} started this project in ..."), articles ` +
        `about people in ${name}'s life ("Maya is ${name}'s sister"), ` +
        `and any other place the user appears. A natural pronoun ` +
        `("they", "their") is also fine where prose flows better than ` +
        `repeating the name.`,
    );
    lines.push(
      `The name is **${name}** and ONLY ${name}. NEVER invent another ` +
        `name for the user, even if other names appear in the ` +
        `conversation - those other names belong to other people the ` +
        `user knows. If the conversation mentions a friend named ` +
        `Maya, an article about the user does not call the user ` +
        `Maya; it calls the user ${name}. If you are uncertain ` +
        `whether the article subject IS the user, default to using ` +
        `the literal name from context (Maya, Elliot, etc.) for that ` +
        `subject and reserve "${name}" for explicit references to ` +
        `the user.`,
    );
  } else {
    lines.push(
      'The user has not supplied a name in Settings. When an article ' +
        'refers to the user themselves, use a natural pronoun ' +
        '("they") or the phrase "the user". NEVER invent a name ' +
        'for the user, even if other names appear in the conversation ' +
        '- those names belong to other people the user knows.',
    );
  }
  if (location) {
    lines.push(`Their location is ${location}.`);
  }
  return lines.join('\n');
}

/**
 * Read the user's name + location (Settings -> AI -> About you) for
 * the prompt's "About the user" block. Null when unset or both fields
 * empty, which suppresses the block entirely - same semantics as the
 * browser worker's buildProfile.
 */
export async function loadWikiProfile(
  adminClient: SupabaseClient,
  userId: string,
): Promise<WikiUserProfile | null> {
  const { data, error } = await adminClient
    .from('profiles')
    .select('settings')
    .eq('user_id', userId)
    .maybeSingle<{ settings: Record<string, unknown> | null }>();
  if (error || !data?.settings) return null;
  const rawName = data.settings.userName;
  const rawLocation = data.settings.userLocation;
  const name = typeof rawName === 'string' ? rawName.trim() : '';
  const location = typeof rawLocation === 'string' ? rawLocation.trim() : '';
  if (!name && !location) return null;
  return { name: name || null, location: location || null };
}
