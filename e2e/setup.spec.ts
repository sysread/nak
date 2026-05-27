import { test, expect } from '@playwright/test';

test('fresh load shows setup screen', async ({ page }) => {
  await page.addInitScript(() => localStorage.clear());
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Initial setup' })).toBeVisible();
  await expect(page.getByLabel('Supabase URL')).toBeVisible();
  await expect(page.getByLabel('Venice API key')).toBeVisible();
});

test('after saving config, reload shows unlock screen', async ({ page }) => {
  await page.addInitScript(() => localStorage.clear());
  await page.goto('/');
  await page.getByLabel('Supabase URL').fill('https://demo.supabase.co');
  await page.getByLabel('Supabase publishable key').fill('sb_publishable_demo');
  await page.getByLabel('Venice API key').fill('venice-demo');
  await page.getByLabel('Master password', { exact: true }).fill('test-password');
  await page.getByLabel('Confirm master password').fill('test-password');
  await page.getByRole('button', { name: /save and continue/i }).click();

  // Reload simulates a fresh session.
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Unlock' })).toBeVisible();

  // Wrong password surfaces a clear error.
  await page.getByLabel('Master password').fill('nope');
  await page.getByRole('button', { name: 'Unlock', exact: true }).click();
  await expect(page.getByText(/wrong password|corrupted|decryption/i)).toBeVisible();
});
