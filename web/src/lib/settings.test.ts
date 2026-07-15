import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SETTINGS,
  dbToRms,
  parseSettings,
  toWorkletConfig,
} from './settings';

describe('parseSettings', () => {
  it('returns defaults for null / garbage / non-object input', () => {
    expect(parseSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings('not json {{')).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings('42')).toEqual(DEFAULT_SETTINGS);
  });

  it('round-trips a full settings object', () => {
    const s = { ...DEFAULT_SETTINGS, sensitivity: 0.7, minGapMs: 90, noiseGateDb: -55 };
    expect(parseSettings(JSON.stringify(s))).toEqual(s);
  });

  it('fills missing keys with defaults and ignores unknown keys', () => {
    const parsed = parseSettings(JSON.stringify({ kitVolume: 0.5, bogus: 99 }));
    expect(parsed.kitVolume).toBe(0.5);
    expect(parsed.sensitivity).toBe(DEFAULT_SETTINGS.sensitivity);
    expect('bogus' in parsed).toBe(false);
  });

  it('clamps out-of-range and rejects non-numeric values', () => {
    const parsed = parseSettings(
      JSON.stringify({ minGapMs: 999, confidenceFloor: -1, profileWeight: 'high' }),
    );
    expect(parsed.minGapMs).toBe(120);
    expect(parsed.confidenceFloor).toBe(0.25);
    expect(parsed.profileWeight).toBe(DEFAULT_SETTINGS.profileWeight);
  });
});

describe('worklet config mapping', () => {
  it('dbToRms matches the old NOISE_GATE_RMS constant at -48 dB', () => {
    expect(dbToRms(-48)).toBeCloseTo(0.004, 3);
  });

  it('converts ms to seconds and dB to linear RMS', () => {
    const cfg = toWorkletConfig({ ...DEFAULT_SETTINGS, minGapMs: 80, noiseGateDb: -40 });
    expect(cfg.minGap).toBeCloseTo(0.08);
    expect(cfg.noiseGateRms).toBeCloseTo(0.01);
    expect(cfg.sensitivity).toBe(DEFAULT_SETTINGS.sensitivity);
  });
});
