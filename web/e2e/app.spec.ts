import { expect, test, type Page } from '@playwright/test';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * End-to-end smoke tests. The fake mic device plays a real AVP beatbox
 * recording (e2e/fixtures/beatbox.wav), so the record flow exercises the true
 * pipeline: worklet onset detection → segment capture → (model, if exported)
 * classification → quantization → sequencer.
 */

const MODEL_EXPORTED = existsSync(
  fileURLToPath(new URL('../public/models/beatbox.onnx', import.meta.url)),
);

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  page.on('pageerror', (err) => errors.push(String(err)));
  return errors;
}

/** Errors we accept: model fetch 404s when the model hasn't been trained yet. */
function realErrors(errors: string[]): string[] {
  return errors.filter(
    (e) =>
      !e.includes('beatbox.onnx') &&
      !e.includes('beatbox.json') &&
      !e.includes('models/') &&
      !e.includes('model load failed') &&
      !e.includes('Failed to load resource'),
  );
}

test('loads with grid, transport, and no console errors', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /drum machine/i })).toBeVisible();
  await expect(page.locator('.grid-row')).toHaveCount(4);
  await expect(page.locator('.cell')).toHaveCount(64);
  await expect(page.getByRole('button', { name: '● REC' })).toBeVisible();
  await page.waitForTimeout(1500); // let the model load settle
  expect(realErrors(errors)).toEqual([]);
});

test('manual pattern editing and playback', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/');
  // Toggle four cells on the kick row.
  const kickCells = page.locator('.grid-row').first().locator('.cell');
  for (const i of [0, 4, 8, 12]) await kickCells.nth(i).click();
  await expect(page.locator('.cell.on')).toHaveCount(4);

  await page.getByRole('button', { name: '▶ PLAY' }).click();
  // Playhead should sweep the grid.
  await expect(page.locator('.cell.playhead').first()).toBeVisible({ timeout: 4000 });
  await page.getByRole('button', { name: '❚❚ PAUSE' }).click();
  await expect(page.locator('.cell.playhead')).toHaveCount(0);

  // Toggling off works too.
  await kickCells.nth(0).click();
  await expect(page.locator('.cell.on')).toHaveCount(3);
  expect(realErrors(errors)).toEqual([]);
});

test('record flow captures hits from the (fake) mic', async ({ page }) => {
  test.skip(!MODEL_EXPORTED, 'model not exported yet — run ml/export.py');
  const errors = collectErrors(page);
  await page.goto('/');
  const rec = page.getByRole('button', { name: '● REC' });
  await expect(rec).toBeEnabled({ timeout: 15_000 }); // model load
  await rec.click();

  // The fixture wav plays through the fake mic; hits should register.
  await expect(page.locator('.hint')).toContainText(/hits captured/, { timeout: 12_000 });
  await page.getByRole('button', { name: '■ STOP' }).click();

  // Transcription should populate the grid and start looping playback.
  await expect(page.locator('.cell.on').first()).toBeVisible({ timeout: 4000 });
  await expect(page.locator('.cell.playhead').first()).toBeVisible({ timeout: 4000 });
  expect(realErrors(errors)).toEqual([]);
});

test('teach flow records calibration examples', async ({ page }) => {
  test.skip(!MODEL_EXPORTED, 'model not exported yet — run ml/export.py');
  const errors = collectErrors(page);
  await page.goto('/');
  await expect(page.getByRole('button', { name: '● REC' })).toBeEnabled({ timeout: 15_000 });
  await page.getByRole('button', { name: /teach it your sounds/i }).click();
  await page.getByRole('button', { name: /^kick/i }).click();
  // Fake mic keeps playing beatbox sounds → examples accumulate.
  await expect(page.locator('.teach-pad').first()).toContainText(/[1-9]\d* \/ 8/, {
    timeout: 12_000,
  });
  expect(realErrors(errors)).toEqual([]);
});
