// Pure builder for the Supabase auth-config PATCH payload. Isolated into its
// own module so it can be unit-tested without pulling in the wizard's
// top-level side effects (prompts, process.exit, etc.).

/**
 * Build a PATCH body for `/v1/projects/{ref}/config/auth`.
 *
 * Inputs:
 *   currentConfig       — current auth config GETted from the Management API.
 *                         Used to preserve `site_url` if already set and to
 *                         merge `uri_allow_list` entries.
 *   pagesUrl            — the deployed Pages URL for this fork, e.g.
 *                         "https://alice.github.io/nak/". Both the bare URL
 *                         and a wildcard variant are added to the allowlist.
 *   allowSignups        — true to allow public email sign-ups. When false,
 *                         only admin-seeded accounts can log in.
 *   requireConfirmation — true to require email confirmation on sign-up.
 *                         Only meaningful when allowSignups is true; ignored
 *                         otherwise because the wizard admin-creates users
 *                         with email_confirm=true anyway.
 */
export function buildAuthConfigPatch({
  currentConfig = {},
  pagesUrl,
  allowSignups,
  requireConfirmation,
}) {
  if (typeof pagesUrl !== 'string' || pagesUrl.length === 0) {
    throw new TypeError('pagesUrl is required');
  }

  const existingAllow = String(currentConfig.uri_allow_list || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const wanted = [pagesUrl, `${pagesUrl}*`];
  const merged = Array.from(new Set([...existingAllow, ...wanted]));

  // Preserve an existing site_url if the project already has one set —
  // users may have deliberately pointed it at a custom domain.
  const siteUrl = currentConfig.site_url || pagesUrl;

  const autoconfirm = !allowSignups || !requireConfirmation;

  return {
    site_url: siteUrl,
    uri_allow_list: merged.join(','),
    external_email_enabled: true,
    disable_signup: !allowSignups,
    mailer_autoconfirm: autoconfirm,
  };
}
