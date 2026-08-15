/**
 * Pure timing math for the cyborg drummer's strike animation.
 *
 * A strike is wind-up → impact → recoil; the impact keyframe must land
 * exactly on the audible beat (a performance-timeline timestamp derived from
 * the sequencer's scheduled AudioContext time). At high tempo there isn't
 * room for a full wind-up, so both phases clamp to the step duration —
 * impacts never drift off the grid.
 */

export const MAX_WINDUP_MS = 120;
export const MAX_RECOIL_MS = 150;
/** Below this the motion stops reading as motion at all. */
export const MIN_PHASE_MS = 40;

/** Duration of one 16th-note grid step, ms. */
export function stepDurationMs(bpm: number): number {
  return (60 / bpm / 4) * 1000;
}

export interface StrikePlan {
  /** performance-timeline ms at which the wind-up starts (may be in the past). */
  startTime: number;
  /** Total animation duration (wind-up + recoil), ms. */
  duration: number;
  /** Keyframe offset (0..1) at which the impact pose lands. */
  impactOffset: number;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * Plan a strike whose impact lands at `impactPerfMs`. `stepMs` is the current
 * grid-step duration; wind-up and recoil each clamp to it so a retrigger on
 * the very next step begins after the previous recoil has finished.
 */
export function planStrike(impactPerfMs: number, stepMs: number): StrikePlan {
  const windup = clamp(stepMs, MIN_PHASE_MS, MAX_WINDUP_MS);
  const recoil = clamp(stepMs, MIN_PHASE_MS, MAX_RECOIL_MS);
  const duration = windup + recoil;
  return {
    startTime: impactPerfMs - windup,
    duration,
    impactOffset: windup / duration,
  };
}
