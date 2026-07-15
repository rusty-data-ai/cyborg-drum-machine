import { describe, expect, it } from 'vitest';
import {
  SHARE_VERSION,
  decodePattern,
  encodePattern,
  patternFromHash,
  patternToShareUrl,
} from './share';
import { DRUM_CLASSES, emptyPattern, type Pattern } from './types';

function rawEncode(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function demoPattern(): Pattern {
  const p = emptyPattern(112.5, 32);
  p.grid.kick[0] = 1;
  p.grid.kick[8] = 0.62;
  p.grid.snare[4] = 0.85;
  p.grid.snare[12] = 0.4;
  p.grid.hihat_closed[2] = 0.5;
  p.grid.hihat_open[14] = 0.93;
  p.grid.clap[20] = 0.7;
  p.grid.tom[31] = 1;
  return p;
}

describe('pattern share codec', () => {
  it('round-trips bpm, steps, and on/off placement exactly', () => {
    const p = demoPattern();
    const out = decodePattern(encodePattern(p))!;
    expect(out).not.toBeNull();
    expect(out.bpm).toBe(112.5);
    expect(out.steps).toBe(32);
    for (const drum of DRUM_CLASSES) {
      for (let s = 0; s < p.steps; s++) {
        expect(out.grid[drum][s] > 0).toBe(p.grid[drum][s] > 0);
      }
    }
  });

  it('round-trips velocities within 4-bit quantization error', () => {
    const p = demoPattern();
    const out = decodePattern(encodePattern(p))!;
    for (const drum of DRUM_CLASSES) {
      for (let s = 0; s < p.steps; s++) {
        expect(Math.abs(out.grid[drum][s] - p.grid[drum][s])).toBeLessThanOrEqual(1 / 30);
      }
    }
  });

  it('never quantizes a quiet-but-on cell to off', () => {
    const p = emptyPattern(100, 16);
    p.grid.kick[3] = 0.01;
    const out = decodePattern(encodePattern(p))!;
    expect(out.grid.kick[3]).toBeGreaterThan(0);
  });

  it('handles empty and max-size (4-bar) patterns', () => {
    expect(decodePattern(encodePattern(emptyPattern()))).toEqual(emptyPattern());
    const big = emptyPattern(180, 64);
    big.grid.tom[63] = 1;
    const out = decodePattern(encodePattern(big))!;
    expect(out.steps).toBe(64);
    expect(out.grid.tom[63]).toBe(1);
  });

  it('emits a URL-safe fragment of bounded length', () => {
    const enc = encodePattern(emptyPattern(180, 64));
    expect(enc).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(enc.length).toBeLessThan(280);
  });

  it('rejects garbage, truncation, and bad field values', () => {
    expect(decodePattern('')).toBeNull();
    expect(decodePattern('!!!not base64!!!')).toBeNull();
    expect(decodePattern('AAAA')).toBeNull(); // version 0
    const enc = encodePattern(demoPattern());
    expect(decodePattern(enc.slice(0, 8))).toBeNull(); // truncated payload
    expect(decodePattern(`${enc}AAAA`)).toBeNull(); // trailing bytes
  });

  it('rejects unknown future versions', () => {
    const bytes = new Uint8Array([SHARE_VERSION + 1, 200, 0, 16, 6]);
    expect(decodePattern(rawEncode(bytes))).toBeNull();
  });

  it('ignores extra drum rows from a future encoder with more pads', () => {
    // 1 step, 8 drums: header + 4 payload bytes, all velocities 15.
    const bytes = new Uint8Array([SHARE_VERSION, 200, 0, 1, 8, 0xff, 0xff, 0xff, 0xff]);
    const enc = rawEncode(bytes);
    const out = decodePattern(enc)!;
    expect(out).not.toBeNull();
    expect(out.grid.kick[0]).toBe(1);
    expect(out.grid.tom[0]).toBe(1);
  });

  it('URL helpers wrap the codec with the #p= prefix', () => {
    const p = demoPattern();
    const url = patternToShareUrl(p, 'https://example.test/');
    expect(url).toMatch(/^https:\/\/example\.test\/#p=[A-Za-z0-9_-]+$/);
    const out = patternFromHash(new URL(url).hash)!;
    expect(out.bpm).toBe(112.5);
    expect(patternFromHash('#other=1')).toBeNull();
    expect(patternFromHash('')).toBeNull();
  });
});
