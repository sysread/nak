import { test, expect } from '@playwright/test';

test('loading with #setup= pre-fills the setup form and strips the hash', async ({ page }) => {
  await page.addInitScript(() => localStorage.clear());
  // Uses the legacy `supabaseAnonKey` field on purpose: this exercises the
  // back-compat fallback for setup links generated before the
  // anon->publishable rename. The value lands in the publishable-key field.
  const payload = {
    supabaseUrl: 'https://fromhash.supabase.co',
    supabaseAnonKey: 'anon-from-hash',
    veniceApiKey: 'venice-from-hash',
  };
  // base64url encode, no padding.
  const b64 = Buffer.from(JSON.stringify(payload), 'utf8')
    .toString('base64')
    .replace(/=+$/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');

  await page.goto(`/#setup=${b64}`);

  await expect(page.getByRole('heading', { name: 'Initial setup' })).toBeVisible();
  await expect(page.getByLabel('Supabase URL')).toHaveValue('https://fromhash.supabase.co');
  await expect(page.getByLabel('Supabase publishable key')).toHaveValue('anon-from-hash');
  await expect(page.getByLabel('Venice API key')).toHaveValue('venice-from-hash');

  // The hash should be stripped so the secret doesn't sit in the address bar.
  await expect.poll(() => page.evaluate(() => location.hash)).toBe('');
});
