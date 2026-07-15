/**
 * Tunable app settings, persisted in localStorage. Defaults mirror the
 * constants they replaced (worklet MIN_GAP/NOISE_GATE_RMS, classifier
 * CONFIDENCE_FLOOR, KNN alpha cap, kit output gain).
 */

export interface AppSettings {
  /** Onset detector threshold, 0 (strict) .. 1 (permissive). */
  sensitivity: number;
  /** Minimum gap between detected hits, ms. */
  minGapMs: number;
  /** Ignore sounds quieter than this, dBFS RMS. */
  noiseGateDb: number;
  /** Classification confidence below this → hit rejected. */
  confidenceFloor: number;
  /** Cap on the personal-KNN blend weight ("trust my profile"). */
  profileWeight: number;
  /** Drum kit output gain, 0..1. */
  kitVolume: number;
}

export const SETTINGS_KEY = 'beatbox-settings';

export const DEFAULT_SETTINGS: AppSettings = {
  sensitivity: 0.5,
  minGapMs: 60,
  noiseGateDb: -48,
  confidenceFloor: 0.4,
  profileWeight: 0.85,
  kitVolume: 0.9,
};

export const SETTINGS_RANGES: Record<keyof AppSettings, [number, number]> = {
  sensitivity: [0, 1],
  minGapMs: [40, 120],
  noiseGateDb: [-60, -30],
  confidenceFloor: [0.25, 0.7],
  profileWeight: [0, 1],
  kitVolume: [0, 1],
};

/** Parse persisted JSON; unknown keys ignored, bad/missing values → defaults, all clamped. */
export function parseSettings(raw: string | null): AppSettings {
  const out = { ...DEFAULT_SETTINGS };
  if (!raw) return out;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return out;
  }
  if (typeof data !== 'object' || data === null) return out;
  for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof AppSettings)[]) {
    const v = (data as Record<string, unknown>)[key];
    if (typeof v !== 'number' || !Number.isFinite(v)) continue;
    const [lo, hi] = SETTINGS_RANGES[key];
    out[key] = Math.max(lo, Math.min(hi, v));
  }
  return out;
}

export function loadSettings(storage?: Storage): AppSettings {
  const s = storage ?? (typeof localStorage !== 'undefined' ? localStorage : null);
  return parseSettings(s?.getItem(SETTINGS_KEY) ?? null);
}

export function saveSettings(settings: AppSettings, storage?: Storage): void {
  const s = storage ?? (typeof localStorage !== 'undefined' ? localStorage : null);
  s?.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

export function dbToRms(db: number): number {
  return 10 ** (db / 20);
}

/** Settings → onset-worklet {type:'config'} payload fields. */
export function toWorkletConfig(settings: AppSettings): {
  sensitivity: number;
  minGap: number;
  noiseGateRms: number;
} {
  return {
    sensitivity: settings.sensitivity,
    minGap: settings.minGapMs / 1000,
    noiseGateRms: dbToRms(settings.noiseGateDb),
  };
}
