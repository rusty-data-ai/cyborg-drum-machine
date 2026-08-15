import type { DrumClass, Pattern } from './types';
import { DRUM_CLASSES } from './types';

/**
 * Standard MIDI File (Format 0) export of a Pattern, plus the General MIDI
 * percussion mapping shared with real-time MIDI out. Pure byte-pushing — no
 * browser APIs — so it is fully unit-testable.
 */

/** GM percussion notes (channel 10), fixed mapping per pad. */
export const GM_NOTES: Record<DrumClass, number> = {
  kick: 36, // Bass Drum 1
  snare: 38, // Acoustic Snare
  hihat_closed: 42, // Closed Hi-Hat
  hihat_open: 46, // Open Hi-Hat
  clap: 39, // Hand Clap
  tom: 45, // Low Tom
};

/** Channel 10 (0-indexed 9) status bytes. */
export const NOTE_ON_CH10 = 0x99;
export const NOTE_OFF_CH10 = 0x89;
export const CC_CH10 = 0xb9;
export const CC_ALL_NOTES_OFF = 123;

export const TICKS_PER_QUARTER = 480;
/** One grid step is a 16th note. */
export const TICKS_PER_STEP = TICKS_PER_QUARTER / 4;

/** Grid velocity (0..1] → MIDI velocity, clamped to 1..127. */
export function velocityToMidi(v: number): number {
  return Math.min(127, Math.max(1, Math.round(v * 127)));
}

/** MIDI variable-length quantity encoding (7 bits per byte, MSB-first). */
export function encodeVarLen(n: number): number[] {
  if (n < 0 || !Number.isInteger(n)) throw new Error(`bad varlen: ${n}`);
  const bytes = [n & 0x7f];
  let rest = n >> 7;
  while (rest > 0) {
    bytes.unshift((rest & 0x7f) | 0x80);
    rest >>= 7;
  }
  return bytes;
}

/** Suggested download filename, e.g. "beat-96bpm.mid" / "beat-127.5bpm.mid". */
export function smfFilename(p: Pattern): string {
  return `beat-${p.bpm.toFixed(1).replace(/\.0$/, '')}bpm.mid`;
}

/**
 * Encode one pass through the pattern loop as a Format-0 SMF:
 * header (division 480), tempo meta from pattern.bpm, channel-10 note-on/off
 * pairs (note-off half a step after note-on), end-of-track at the loop end.
 */
export function encodePatternToSmf(p: Pattern): Uint8Array {
  interface Ev {
    tick: number;
    /** Sort key: offs before ons at the same tick. */
    order: number;
    data: number[];
  }
  const events: Ev[] = [];
  for (let s = 0; s < p.steps; s++) {
    for (const drum of DRUM_CLASSES) {
      const vel = p.grid[drum][s] ?? 0;
      if (vel <= 0) continue;
      const note = GM_NOTES[drum];
      const onTick = s * TICKS_PER_STEP;
      events.push({ tick: onTick, order: 1, data: [NOTE_ON_CH10, note, velocityToMidi(vel)] });
      events.push({
        tick: onTick + TICKS_PER_STEP / 2,
        order: 0,
        data: [NOTE_OFF_CH10, note, 0],
      });
    }
  }
  events.sort((a, b) => a.tick - b.tick || a.order - b.order);

  const track: number[] = [];
  // Tempo meta at tick 0: microseconds per quarter note.
  const usPerQuarter = Math.round(60_000_000 / p.bpm);
  track.push(0, 0xff, 0x51, 0x03, (usPerQuarter >> 16) & 0xff, (usPerQuarter >> 8) & 0xff, usPerQuarter & 0xff);
  let lastTick = 0;
  for (const ev of events) {
    track.push(...encodeVarLen(ev.tick - lastTick), ...ev.data);
    lastTick = ev.tick;
  }
  // End of track at the loop boundary, so the file carries the full loop length.
  const endTick = p.steps * TICKS_PER_STEP;
  track.push(...encodeVarLen(Math.max(0, endTick - lastTick)), 0xff, 0x2f, 0x00);

  const header = [
    0x4d, 0x54, 0x68, 0x64, // "MThd"
    0, 0, 0, 6, // header length
    0, 0, // format 0
    0, 1, // one track
    (TICKS_PER_QUARTER >> 8) & 0xff, TICKS_PER_QUARTER & 0xff,
  ];
  const trackHeader = [
    0x4d, 0x54, 0x72, 0x6b, // "MTrk"
    (track.length >>> 24) & 0xff,
    (track.length >>> 16) & 0xff,
    (track.length >>> 8) & 0xff,
    track.length & 0xff,
  ];
  return Uint8Array.from([...header, ...trackHeader, ...track]);
}
