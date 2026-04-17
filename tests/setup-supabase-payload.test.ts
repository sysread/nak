import { describe, it, expect } from 'vitest';
// @ts-expect-error — .mjs has no declarations, test behavior only
import { buildAuthConfigPatch } from '../scripts/lib/auth-config.mjs';

const PAGES = 'https://alice.github.io/nak/';

describe('buildAuthConfigPatch', () => {
  it('sign-ups disallowed → disable_signup true, autoconfirm true', () => {
    const patch = buildAuthConfigPatch({
      currentConfig: {},
      pagesUrl: PAGES,
      allowSignups: false,
      requireConfirmation: false,
    });
    expect(patch.disable_signup).toBe(true);
    expect(patch.mailer_autoconfirm).toBe(true);
    expect(patch.external_email_enabled).toBe(true);
  });

  it('sign-ups allowed + confirmation required → disable_signup false, autoconfirm false', () => {
    const patch = buildAuthConfigPatch({
      currentConfig: {},
      pagesUrl: PAGES,
      allowSignups: true,
      requireConfirmation: true,
    });
    expect(patch.disable_signup).toBe(false);
    expect(patch.mailer_autoconfirm).toBe(false);
  });

  it('sign-ups allowed + no confirmation → disable_signup false, autoconfirm true', () => {
    const patch = buildAuthConfigPatch({
      currentConfig: {},
      pagesUrl: PAGES,
      allowSignups: true,
      requireConfirmation: false,
    });
    expect(patch.disable_signup).toBe(false);
    expect(patch.mailer_autoconfirm).toBe(true);
  });

  it('ignores requireConfirmation when sign-ups are disabled', () => {
    const patch = buildAuthConfigPatch({
      currentConfig: {},
      pagesUrl: PAGES,
      allowSignups: false,
      // Even if caller accidentally passes true, autoconfirm should still be true
      // because the admin-created user is pre-confirmed anyway.
      requireConfirmation: true,
    });
    expect(patch.mailer_autoconfirm).toBe(true);
  });

  it('merges the Pages URL into an existing uri_allow_list without clobbering', () => {
    const patch = buildAuthConfigPatch({
      currentConfig: {
        uri_allow_list: 'https://other.example.com,https://preview.example.com',
      },
      pagesUrl: PAGES,
      allowSignups: false,
      requireConfirmation: false,
    });
    const entries = patch.uri_allow_list.split(',');
    expect(entries).toContain('https://other.example.com');
    expect(entries).toContain('https://preview.example.com');
    expect(entries).toContain(PAGES);
    expect(entries).toContain(`${PAGES}*`);
  });

  it('deduplicates allowlist entries on re-run', () => {
    const first = buildAuthConfigPatch({
      currentConfig: {},
      pagesUrl: PAGES,
      allowSignups: false,
      requireConfirmation: false,
    });
    const second = buildAuthConfigPatch({
      currentConfig: { uri_allow_list: first.uri_allow_list },
      pagesUrl: PAGES,
      allowSignups: false,
      requireConfirmation: false,
    });
    expect(second.uri_allow_list).toBe(first.uri_allow_list);
  });

  it('preserves a custom site_url that the user already set', () => {
    const patch = buildAuthConfigPatch({
      currentConfig: { site_url: 'https://nak.my-custom-domain.com/' },
      pagesUrl: PAGES,
      allowSignups: false,
      requireConfirmation: false,
    });
    expect(patch.site_url).toBe('https://nak.my-custom-domain.com/');
  });

  it('falls back to pagesUrl when no site_url is set', () => {
    const patch = buildAuthConfigPatch({
      currentConfig: {},
      pagesUrl: PAGES,
      allowSignups: false,
      requireConfirmation: false,
    });
    expect(patch.site_url).toBe(PAGES);
  });

  it('requires a pagesUrl', () => {
    expect(() =>
      buildAuthConfigPatch({
        currentConfig: {},
        pagesUrl: '',
        allowSignups: false,
        requireConfirmation: false,
      })
    ).toThrow();
  });
});
