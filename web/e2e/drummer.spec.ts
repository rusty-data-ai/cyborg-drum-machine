import { expect, test, type Page } from '@playwright/test';
import { encodePattern } from '../src/lib/share';
import { emptyPattern } from '../src/lib/types';

/**
 * Cyborg drummer e2e: rig renders, limbs animate only for their own drums
 * during playback (WAAPI driven from the sequencer schedule), and
 * prefers-reduced-motion suppresses all continuous motion.
 */

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

function patternUrl(): string {
  const pat = emptyPattern(120, 16);
  for (const i of [0, 4, 8, 12]) pat.grid.kick[i] = 1;
  for (const i of [4, 12]) pat.grid.snare[i] = 0.85;
  return `/#p=${encodePattern(pat)}`;
}

/** Which limbs run a WAAPI animation at any point during `ms` of observation. */
function observeAnimatedLimbs(page: Page, ms: number): Promise<string[]> {
  return page.evaluate(
    (duration) =>
      new Promise<string[]>((resolve) => {
        const seen = new Set<string>();
        const iv = setInterval(() => {
          for (const el of document.querySelectorAll('.drummer [data-limb]')) {
            if (el.getAnimations().length > 0) seen.add(el.getAttribute('data-limb')!);
          }
        }, 25);
        setTimeout(() => {
          clearInterval(iv);
          resolve([...seen]);
        }, duration);
      }),
    ms,
  );
}

test('drummer renders with six limbs and six strike targets, resting when stopped', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await page.goto('/');
  await expect(page.locator('.drummer')).toBeVisible();
  await expect(page.locator('.drummer [data-limb]')).toHaveCount(6);
  await expect(page.locator('.drummer [data-target]')).toHaveCount(6);
  // Resting: nothing animates before playback.
  const idleCount = await page.evaluate(
    () =>
      document
        .getAnimations()
        .filter((a) => {
          const t = (a.effect as KeyframeEffect | null)?.target as Element | null;
          return t?.closest('.drummer') != null;
        }).length,
  );
  expect(idleCount).toBe(0);
  // Hideable, shown by default.
  await page.getByRole('button', { name: 'hide' }).click();
  await expect(page.locator('.drummer')).toHaveCount(0);
  await page.getByRole('button', { name: 'show drummer' }).click();
  await expect(page.locator('.drummer')).toBeVisible();
  expect(realErrors(errors)).toEqual([]);
});

test('limbs strike their own drums (and only those) during playback, with idle motion', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await page.goto(patternUrl());
  await expect(page.locator('.cell.on')).toHaveCount(6);
  await page.getByRole('button', { name: '▶ PLAY' }).click();
  // Observe a bit over one 2 s loop: only kick + snare limbs may animate.
  const animated = await observeAnimatedLimbs(page, 2400);
  expect(new Set(animated)).toEqual(new Set(['kick', 'snare']));
  // Idle motion runs on the figure (CSS animation) while playing.
  const idle = await page.evaluate(() =>
    document.getAnimations().some((a) => {
      const t = (a.effect as KeyframeEffect | null)?.target as Element | null;
      return t?.closest('.drummer-figure') != null;
    }),
  );
  expect(idle).toBe(true);
  await page.getByRole('button', { name: '❚❚ PAUSE' }).click();
  // Settles back to rest: idle animation gone once stopped.
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          document
            .getAnimations()
            .filter((a) => {
              const t = (a.effect as KeyframeEffect | null)?.target as Element | null;
              return t?.closest('.drummer') != null;
            }).length,
      ),
    )
    .toBe(0);
  expect(realErrors(errors)).toEqual([]);
});

test('prefers-reduced-motion: figure is static — no WAAPI or CSS animations at all', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(patternUrl());
  await expect(page.locator('.drummer')).toBeVisible();
  await page.getByRole('button', { name: '▶ PLAY' }).click();
  // Watch across more than a full loop: zero animations inside the drummer.
  const count = await page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        let seen = 0;
        const iv = setInterval(() => {
          seen += document.getAnimations().filter((a) => {
            const t = (a.effect as KeyframeEffect | null)?.target as Element | null;
            return t?.closest('.drummer') != null;
          }).length;
        }, 40);
        setTimeout(() => {
          clearInterval(iv);
          resolve(seen);
        }, 2400);
      }),
  );
  expect(count).toBe(0);
  // Playback itself still works.
  await expect(page.locator('.cell.playhead').first()).toBeVisible();
  expect(realErrors(errors)).toEqual([]);
});
