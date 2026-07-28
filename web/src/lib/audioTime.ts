/**
 * Audio-clock → performance-clock conversion, shared by MIDI output and the
 * cyborg drummer animation. The sequencer schedules hits at AudioContext
 * times (seconds); consumers (WAAPI animations, MIDIOutput.send) want
 * DOMHighResTimeStamps on the performance.now() timeline. Where available,
 * AudioContext.getOutputTimestamp anchors the mapping at the *output* of the
 * audio pipeline, so converted times include output latency — i.e. they line
 * up with what the user actually hears.
 */

export interface ClockMapping {
  /** AudioContext time (seconds) of the reference instant. */
  contextTime: number;
  /** performance.now() time (milliseconds) of the same instant. */
  performanceTime: number;
}

/** Pure conversion: AudioContext time (s) → performance timeline (ms). */
export function audioToPerfTime(audioTime: number, m: ClockMapping): number {
  return m.performanceTime + (audioTime - m.contextTime) * 1000;
}

/** The subset of AudioContext that clock mapping needs (injectable in tests). */
export interface AudioClockSource {
  currentTime: number;
  getOutputTimestamp?: () => { contextTime?: number; performanceTime?: number };
}

/**
 * Snapshot the current audio↔performance clock relationship. Prefers
 * getOutputTimestamp (tracks true output latency); falls back to
 * currentTime/performance.now() where it is unavailable or returns an
 * empty/invalid dictionary (some UAs while the context is suspended).
 */
export function clockMapping(ctx: AudioClockSource): ClockMapping {
  const ts = typeof ctx.getOutputTimestamp === 'function' ? ctx.getOutputTimestamp() : undefined;
  if (
    ts &&
    Number.isFinite(ts.contextTime ?? NaN) &&
    Number.isFinite(ts.performanceTime ?? NaN)
  ) {
    return { contextTime: ts.contextTime!, performanceTime: ts.performanceTime! };
  }
  return { contextTime: ctx.currentTime, performanceTime: performance.now() };
}
