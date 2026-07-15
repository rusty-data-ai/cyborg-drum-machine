import { expect, test } from '@playwright/test';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Numerical parity: the in-browser ONNX Runtime (WASM) must reproduce the
 * Python-side outputs on fixture waveforms exported by ml/export.py.
 * Runs the real classifier module inside Chromium via the Vite dev server.
 */

const MODEL_EXPORTED = existsSync(
  fileURLToPath(new URL('../public/models/beatbox.onnx', import.meta.url)),
);

test('browser inference matches Python fixtures', async ({ page }) => {
  test.skip(!MODEL_EXPORTED, 'model not exported yet — run ml/export.py');
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { HitClassifier } = await import('/src/lib/classifier.ts');
    const clf = new HitClassifier();
    await clf.load();
    const fixtures = await (await fetch('/models/fixtures.json')).json();
    let maxLogitErr = 0;
    let maxEmbErr = 0;
    for (const f of fixtures) {
      const { probs, embedding } = await clf.infer(new Float32Array(f.waveform));
      // Compare in softmax space (fixtures store raw logits).
      const m = Math.max(...f.logits);
      const exps = f.logits.map((v: number) => Math.exp(v - m));
      const s = exps.reduce((a: number, b: number) => a + b, 0);
      const refProbs = exps.map((v: number) => v / s);
      refProbs.forEach((p: number, i: number) => {
        maxLogitErr = Math.max(maxLogitErr, Math.abs(p - probs[i]));
      });
      f.embedding.forEach((v: number, i: number) => {
        maxEmbErr = Math.max(maxEmbErr, Math.abs(v - embedding[i]));
      });
    }
    return { maxLogitErr, maxEmbErr, n: fixtures.length };
  });
  expect(result.n).toBeGreaterThan(0);
  expect(result.maxLogitErr).toBeLessThan(1e-3);
  expect(result.maxEmbErr).toBeLessThan(1e-2);
});

test('inference latency is real-time capable', async ({ page }) => {
  test.skip(!MODEL_EXPORTED, 'model not exported yet — run ml/export.py');
  await page.goto('/');
  const ms = await page.evaluate(async () => {
    const { HitClassifier } = await import('/src/lib/classifier.ts');
    const clf = new HitClassifier();
    await clf.load(); // includes warmup
    const meta = await (await fetch('/models/beatbox.json')).json();
    const wave = new Float32Array(meta.patchLen).map(() => Math.random() * 0.1);
    const t0 = performance.now();
    const runs = 20;
    for (let i = 0; i < runs; i++) await clf.infer(wave);
    return (performance.now() - t0) / runs;
  });
  console.log(`mean inference: ${ms.toFixed(2)} ms`);
  expect(ms).toBeLessThan(50);
});
