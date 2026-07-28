import { expect, test, type Page } from '@playwright/test';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Teach-flow clarity e2e: the leave-one-out improvement stat (profile seeded
 * straight into IndexedDB) and learn-from-corrections via the review strip
 * (driven by the fake-mic beatbox fixture, i.e. the real pipeline).
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

/** Seed a clustered kick/snare profile (+ 2 legacy examples) into IndexedDB. */
async function seedProfile(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const meta = (await (await fetch('/models/beatbox.json')).json()) as { version: string };
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open('beatbox', 1);
      req.onupgradeneeded = () =>
        req.result.createObjectStore('examples', { keyPath: 'id', autoIncrement: true });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const emb = (axis: number, jitter: number) =>
      Array.from({ length: 128 }, (_, i) => (i === axis ? 1 : Math.sin(i * jitter) * 0.05));
    const mk = (
      label: string,
      axis: number,
      jitter: number,
      modelProbs?: number[],
    ) => ({
      label,
      embedding: emb(axis, jitter),
      modelVersion: meta.version,
      createdAt: Date.now(),
      ...(modelProbs ? { modelProbs } : {}),
    });
    const kickProbs = [0.7, 0.1, 0.1, 0.05, 0.05];
    const snareProbs = [0.1, 0.7, 0.1, 0.05, 0.05];
    const rows = [
      ...Array.from({ length: 6 }, (_, i) => mk('kick', 0, 0.1 + i * 0.07, kickProbs)),
      ...Array.from({ length: 6 }, (_, i) => mk('snare', 1, 0.1 + i * 0.07, snareProbs)),
      // Legacy examples (pre-modelProbs): load fine, vote, excluded from N.
      mk('kick', 0, 0.9),
      mk('snare', 1, 0.9),
    ];
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('examples', 'readwrite');
      const store = tx.objectStore('examples');
      for (const r of rows) store.add(r);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  });
}

test('teach tab shows the leave-one-out improvement stat and updates on delete', async ({
  page,
}) => {
  test.skip(!MODEL_EXPORTED, 'model not exported yet — run ml/export.py');
  const errors = collectErrors(page);
  await page.goto('/');
  await expect(page.getByRole('button', { name: '● REC' })).toBeEnabled({ timeout: 15_000 });
  await seedProfile(page);
  await page.reload(); // profile loads at startup
  await expect(page.getByRole('button', { name: '● REC' })).toBeEnabled({ timeout: 15_000 });
  await page.getByRole('button', { name: /teach it your sounds/i }).click();

  // Stat unlocked: measured on the 12 evaluable examples (legacy 2 excluded
  // from N but present in the profile: footer says 14).
  const status = page.locator('.teach-status');
  await expect(status).toContainText('with your profile:');
  await expect(status).toContainText('measured on your 12 taught examples');
  await expect(page.locator('.teach-footer')).toContainText('14 examples');
  // Clean clusters + correct global probs → both accuracies high.
  await expect(status).toContainText(/global model alone: (9[0-9]|100)%/);

  // Deleting an example recomputes the stat immediately.
  const kickPad = page.locator('.teach-pad').first();
  await kickPad.locator('.chip-x').first().click();
  await expect(status).toContainText(/measured on your 1[12] taught examples/);
  await expect(page.locator('.teach-footer')).toContainText('13 examples');

  // Reset returns to the locked/progress state.
  page.on('dialog', (d) => void d.accept());
  await page.getByRole('button', { name: 'reset profile' }).click();
  await expect(status).toContainText('unlock your accuracy score');
  expect(realErrors(errors)).toEqual([]);
});

test('review strip: correcting a chip moves the cell and teaches the profile', async ({
  page,
}) => {
  test.skip(!MODEL_EXPORTED, 'model not exported yet — run ml/export.py');
  const errors = collectErrors(page);
  await page.goto('/');
  const rec = page.getByRole('button', { name: '● REC' });
  await expect(rec).toBeEnabled({ timeout: 15_000 });
  await rec.click();
  await expect(page.locator('.hint')).toContainText(/hits captured/, { timeout: 12_000 });
  await page.getByRole('button', { name: '■ STOP' }).click();
  await expect(page.locator('.cell.on').first()).toBeVisible({ timeout: 4000 });

  // Chips appear in time order with drum + confidence.
  const chips = page.locator('.review-chip');
  const nChips = await chips.count();
  expect(nChips).toBeGreaterThan(0);
  await expect(chips.first()).toContainText('%');

  // Tap a chip → chooser offers the six drums + "not a drum".
  await chips.first().click();
  const chooser = page.locator('.review-chooser');
  await expect(chooser).toBeVisible();
  await expect(chooser.getByRole('menuitem')).toHaveCount(7);

  // Correct it to Tom (never the model's own call: tom is KNN-only and the
  // profile is empty) → chip marked, grid row updated, profile grew by one.
  const tomCellsBefore = await page.locator('.grid-row').nth(5).locator('.cell.on').count();
  await chooser.getByRole('menuitem', { name: 'Tom', exact: true }).click();
  await expect(page.locator('.review-chip.corrected')).toHaveCount(1);
  await expect(page.locator('.review-note')).toContainText('learned: that was a Tom');
  const tomCellsAfter = await page.locator('.grid-row').nth(5).locator('.cell.on').count();
  expect(tomCellsAfter).toBe(tomCellsBefore + 1);
  await expect(page.locator('.profile-note')).toContainText('1 example');

  // The teach tab reflects the correction without reload.
  await page.getByRole('button', { name: /teach it your sounds/i }).click();
  await expect(page.locator('.teach-pad').nth(5)).toContainText('1 / 8');

  // "Not a drum": back on Play, chip stays, cell cleared, nothing stored.
  await page.getByRole('button', { name: /^play$/i }).click();
  const totalOnBefore = await page.locator('.cell.on').count();
  await page.locator('.review-chip').nth(1).click();
  await page.locator('.review-chooser').getByRole('menuitem', { name: 'not a drum' }).click();
  await expect(page.locator('.review-chip.corrected')).toHaveCount(2);
  await expect
    .poll(() => page.locator('.cell.on').count())
    .toBeLessThanOrEqual(totalOnBefore);
  await expect(page.locator('.profile-note')).toContainText('1 example'); // unchanged
  expect(realErrors(errors)).toEqual([]);
});
