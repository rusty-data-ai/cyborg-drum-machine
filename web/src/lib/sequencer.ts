import type { DrumKit } from './drumSynth';
import type { DrumClass, Pattern } from './types';
import { DRUM_CLASSES } from './types';

/**
 * Lookahead step sequencer using the standard "tale of two clocks" pattern:
 * a coarse setInterval timer schedules events a short window ahead on the
 * sample-accurate AudioContext clock.
 */
export class Sequencer {
  private ctx: AudioContext;
  private kit: DrumKit;
  private pattern: Pattern;
  private timer: number | null = null;
  private nextStepTime = 0;
  private nextStep = 0;
  /** Called (from the timer thread, slightly ahead of audio) so the UI can animate the playhead. */
  onStep: ((step: number, time: number) => void) | null = null;
  /**
   * Called synchronously at *schedule* time (up to SCHEDULE_AHEAD_S ahead of
   * the beat) for every active cell, carrying the exact AudioContext time the
   * hit will sound. Consumers (MIDI out, drummer animation) use the lead to
   * schedule precisely against the audio clock; keep handlers cheap.
   */
  onTrigger: ((drum: DrumClass, velocity: number, time: number) => void) | null = null;

  private static readonly LOOKAHEAD_MS = 25;
  private static readonly SCHEDULE_AHEAD_S = 0.12;

  constructor(ctx: AudioContext, kit: DrumKit, pattern: Pattern) {
    this.ctx = ctx;
    this.kit = kit;
    this.pattern = pattern;
  }

  get playing(): boolean {
    return this.timer !== null;
  }

  setPattern(pattern: Pattern): void {
    const stepsChanged = pattern.steps !== this.pattern.steps;
    this.pattern = pattern;
    if (stepsChanged) this.nextStep = this.nextStep % pattern.steps;
  }

  private stepDuration(): number {
    // 16th notes: 4 steps per beat.
    return 60 / this.pattern.bpm / 4;
  }

  start(): void {
    if (this.timer !== null) return;
    this.nextStep = 0;
    this.nextStepTime = this.ctx.currentTime + 0.06;
    this.timer = window.setInterval(() => this.scheduleWindow(), Sequencer.LOOKAHEAD_MS);
    this.scheduleWindow();
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private scheduleWindow(): void {
    while (this.nextStepTime < this.ctx.currentTime + Sequencer.SCHEDULE_AHEAD_S) {
      this.scheduleStep(this.nextStep, this.nextStepTime);
      this.nextStepTime += this.stepDuration();
      this.nextStep = (this.nextStep + 1) % this.pattern.steps;
    }
  }

  private scheduleStep(step: number, time: number): void {
    for (const drum of DRUM_CLASSES) {
      const vel = this.pattern.grid[drum][step] ?? 0;
      if (vel > 0) {
        this.kit.trigger(drum, time, vel);
        this.onTrigger?.(drum, vel, time);
      }
    }
    const delayMs = Math.max(0, (time - this.ctx.currentTime) * 1000);
    if (this.onStep) {
      const cb = this.onStep;
      window.setTimeout(() => cb(step, time), delayMs);
    }
  }
}
