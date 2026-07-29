import { expect, test, type Page } from '@playwright/test';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

/**
 * Accounts plan Phase 0 e2e: profile export/import round-trip through a real
 * browser download and a real file chooser (no fetch mocking).
 */

const MODEL_EXPORTED = existsSync(
  fileURLToPath(new URL('../public/models/beatbox.onnx', import.meta.url)),
);

/** Seed kick/snare examples straight into IndexedDB — all pre-uuid (legacy). */
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
    const kickProbs = [0.7, 0.1, 0.1, 0.05, 0.05];
    const rows = [
      ...Array.from({ length: 3 }, (_, i) => ({
        label: 'kick',
        embedding: emb(0, 0.1 + i * 0.07),
        modelVersion: meta.version,
        createdAt: Date.now(),
        modelProbs: kickProbs,
      })),
      ...Array.from({ length: 3 }, (_, i) => ({
        label: 'snare',
        embedding: emb(1, 0.1 + i * 0.07),
        modelVersion: meta.version,
        createdAt: Date.now(),
      })),
    ];
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('examples', 'readwrite');
      for (const r of rows) tx.objectStore('examples').add(r);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  });
}

test('profile export/import round-trip: download, reset, restore via file chooser', async ({
  page,
}, testInfo) => {
  test.skip(!MODEL_EXPORTED, 'model not exported yet — run ml/export.py');
  await page.goto('/');
  await expect(page.getByRole('button', { name: '● REC' })).toBeEnabled({ timeout: 15_000 });
  await seedProfile(page);
  await page.reload(); // profile (incl. lazy uuid assignment) loads at startup
  await expect(page.getByRole('button', { name: '● REC' })).toBeEnabled({ timeout: 15_000 });
  await page.getByRole('button', { name: /teach it your sounds/i }).click();
  await expect(page.locator('.teach-footer')).toContainText('6 examples');

  // Export: a real download with the dated filename and the versioned format.
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'export profile' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^beatbox-profile-\d{8}\.json$/);
  const savedPath = testInfo.outputPath(download.suggestedFilename());
  await download.saveAs(savedPath);
  const file = JSON.parse(await readFile(savedPath, 'utf8')) as {
    formatVersion: number;
    modelVersion: string;
    examples: { uuid: string; label: string; embedding: number[]; modelProbs?: number[] }[];
    settings: Record<string, number>;
  };
  expect(file.formatVersion).toBe(1);
  expect(file.examples).toHaveLength(6);
  // Legacy rows were seeded without uuids — load() must have assigned them.
  for (const e of file.examples) {
    expect(e.uuid).toMatch(/^[0-9a-f-]{36}$/);
    expect(e.embedding).toHaveLength(128);
  }
  expect(new Set(file.examples.map((e) => e.uuid)).size).toBe(6);
  expect(file.settings).toHaveProperty('sensitivity');

  // Importing the same file on top is a pure dedup no-op.
  const chooser1 = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'import profile' }).click();
  await (await chooser1).setFiles(savedPath);
  await expect(page.locator('.teach-transfer-note')).toContainText(
    'imported 0 examples · skipped 6 duplicates',
  );
  await expect(page.locator('.teach-footer')).toContainText('6 examples');

  // Wipe the profile, then restore it from the exported file.
  page.on('dialog', (d) => void d.accept());
  await page.getByRole('button', { name: 'reset profile' }).click();
  await expect(page.locator('.teach-footer')).toContainText('No personal profile yet');
  const chooser2 = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'import profile' }).click();
  await (await chooser2).setFiles(savedPath);
  await expect(page.locator('.teach-transfer-note')).toContainText('imported 6 examples');
  await expect(page.locator('.teach-footer')).toContainText('6 examples');
  await expect(page.locator('.teach-pad').first()).toContainText('3 / 8');

  // Restored examples survive a reload (they were really written to IndexedDB).
  await page.reload();
  await expect(page.getByRole('button', { name: '● REC' })).toBeEnabled({ timeout: 15_000 });
  await page.getByRole('button', { name: /teach it your sounds/i }).click();
  await expect(page.locator('.teach-footer')).toContainText('6 examples');
});

test('import rejects malformed and wrong-version files without touching the profile', async ({
  page,
}, testInfo) => {
  test.skip(!MODEL_EXPORTED, 'model not exported yet — run ml/export.py');
  await page.goto('/');
  await expect(page.getByRole('button', { name: '● REC' })).toBeEnabled({ timeout: 15_000 });
  await page.getByRole('button', { name: /teach it your sounds/i }).click();

  const junkPath = testInfo.outputPath('junk.json');
  await writeFile(junkPath, 'this is not json', 'utf8');
  const chooser1 = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'import profile' }).click();
  await (await chooser1).setFiles(junkPath);
  await expect(page.locator('.teach-transfer-note')).toContainText('import failed: not a JSON file');

  const futurePath = testInfo.outputPath('future.json');
  await writeFile(
    futurePath,
    JSON.stringify({ formatVersion: 99, modelVersion: 'v2', examples: [] }),
    'utf8',
  );
  const chooser2 = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'import profile' }).click();
  await (await chooser2).setFiles(futurePath);
  await expect(page.locator('.teach-transfer-note')).toContainText('unsupported profile format');

  const wrongModelPath = testInfo.outputPath('wrong-model.json');
  await writeFile(
    wrongModelPath,
    JSON.stringify({
      formatVersion: 1,
      modelVersion: 'some-other-model',
      examples: [],
    }),
    'utf8',
  );
  const chooser3 = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'import profile' }).click();
  await (await chooser3).setFiles(wrongModelPath);
  await expect(page.locator('.teach-transfer-note')).toContainText(
    /import failed: that file is from model some-other-model/,
  );
  await expect(page.locator('.teach-footer')).toContainText('No personal profile yet');
});
