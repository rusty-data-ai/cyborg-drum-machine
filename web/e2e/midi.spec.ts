import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { encodePattern } from '../src/lib/share';
import { emptyPattern } from '../src/lib/types';

/**
 * MIDI output e2e. Real MIDI hardware doesn't exist in headless CI, so the
 * device layer is exercised through an injected fake MIDIAccess (verifying the
 * full sequencer → onTrigger → MIDIOutput.send path, message bytes and
 * timestamps included), plus graceful degradation with Web MIDI absent.
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
  pat.grid.snare[4] = 0.85;
  return `/#p=${encodePattern(pat)}`;
}

const FAKE_MIDI = `
  window.__midiSends = [];
  const output = {
    id: 'fake-1',
    name: 'Virtual Synth',
    state: 'connected',
    send: (data, ts) => window.__midiSends.push({ data: Array.from(data), ts }),
  };
  const access = {
    outputs: new Map([['fake-1', output]]),
    inputs: new Map(),
    onstatechange: null,
  };
  navigator.requestMIDIAccess = () => Promise.resolve(access);
`;

test('export .mid downloads a Format-0 SMF for the current pattern', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto(patternUrl());
  await expect(page.locator('.cell.on')).toHaveCount(5);
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'export .mid' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('beat-120bpm.mid');
  const bytes = readFileSync((await download.path())!);
  expect(bytes.subarray(0, 4).toString('latin1')).toBe('MThd');
  expect(bytes.subarray(14, 18).toString('latin1')).toBe('MTrk');
  // 5 active cells → 5 note-ons on channel 10.
  expect([...bytes].filter((b) => b === 0x99).length).toBeGreaterThanOrEqual(5);
  expect(realErrors(errors)).toEqual([]);
});

test('without Web MIDI: picker/toggle absent, export still works, no errors', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await page.addInitScript(() => {
    // Simulate Safari: no Web MIDI at all.
    delete (Navigator.prototype as unknown as Record<string, unknown>).requestMIDIAccess;
  });
  await page.goto(patternUrl());
  await expect(page.locator('.cell.on')).toHaveCount(5);
  await expect(page.getByRole('checkbox', { name: 'midi out' })).toHaveCount(0);
  await expect(page.getByLabel('midi output device')).toHaveCount(0);
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'export .mid' }).click();
  const download = await downloadPromise;
  const bytes = readFileSync((await download.path())!);
  expect(bytes.subarray(0, 4).toString('latin1')).toBe('MThd');
  expect(realErrors(errors)).toEqual([]);
});

test('live MIDI out: channel-10 notes with velocities + timestamps, all-notes-off on stop, persistence', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await page.addInitScript(FAKE_MIDI);
  await page.goto(patternUrl());
  await expect(page.locator('.cell.on')).toHaveCount(5);

  // Enable → device appears and is auto-selected. No sends before playback.
  await page.getByRole('checkbox', { name: 'midi out' }).check();
  const picker = page.getByLabel('midi output device');
  await expect(picker).toBeVisible();
  await expect(picker).toHaveValue('fake-1');

  await page.getByRole('button', { name: '▶ PLAY' }).click();
  await page.waitForFunction(
    () =>
      (window as unknown as { __midiSends: { data: number[] }[] }).__midiSends.filter(
        (s) => s.data[0] === 0x99,
      ).length >= 6,
  );
  await page.getByRole('button', { name: '❚❚ PAUSE' }).click();

  const sends = await page.evaluate(
    () => (window as unknown as { __midiSends: { data: number[]; ts?: number }[] }).__midiSends,
  );
  const ons = sends.filter((s) => s.data[0] === 0x99);
  // GM mapping: only kick (36) and snare (38) are in this pattern.
  expect(new Set(ons.map((s) => s.data[1]))).toEqual(new Set([36, 38]));
  // Velocity tracks stored grid velocity: kick 1.0 → 127; snare 0.85 arrives
  // via the share codec's 4-bit levels as 13/15 ≈ 0.867 → 110.
  expect(ons.filter((s) => s.data[1] === 36).every((s) => s.data[2] === 127)).toBe(true);
  expect(ons.filter((s) => s.data[1] === 38).every((s) => s.data[2] === 110)).toBe(true);
  // Timestamps come from the schedule (finite, forward-moving for same note).
  const kickTs = ons.filter((s) => s.data[1] === 36).map((s) => s.ts ?? NaN);
  expect(kickTs.every((t) => Number.isFinite(t) && t > 0)).toBe(true);
  for (let i = 1; i < kickTs.length; i++) expect(kickTs[i]).toBeGreaterThan(kickTs[i - 1]);
  // Each note-on has a matching later note-off.
  const offs = sends.filter((s) => s.data[0] === 0x89);
  expect(offs.length).toBeGreaterThanOrEqual(ons.length);
  // Stop sent All Notes Off (CC 123 on channel 10).
  expect(sends.some((s) => s.data[0] === 0xb9 && s.data[1] === 123)).toBe(true);

  // Enabled flag + device choice persist across reload.
  await page.reload();
  await expect(page.getByRole('checkbox', { name: 'midi out' })).toBeChecked();
  await expect(page.getByLabel('midi output device')).toHaveValue('fake-1');
  expect(realErrors(errors)).toEqual([]);
});
