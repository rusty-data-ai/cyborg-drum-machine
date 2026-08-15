import { describe, expect, it } from 'vitest';
import {
  GM_NOTES,
  NOTE_OFF_CH10,
  NOTE_ON_CH10,
  TICKS_PER_QUARTER,
  TICKS_PER_STEP,
  encodePatternToSmf,
  encodeVarLen,
  smfFilename,
  velocityToMidi,
} from './midiFile';
import { emptyPattern } from './types';

describe('velocityToMidi', () => {
  it('scales and clamps to 1..127', () => {
    expect(velocityToMidi(1)).toBe(127);
    expect(velocityToMidi(0.85)).toBe(108);
    expect(velocityToMidi(0.5)).toBe(64);
    expect(velocityToMidi(0.001)).toBe(1); // never 0 (that would be a note-off)
    expect(velocityToMidi(2)).toBe(127);
  });
});

describe('encodeVarLen', () => {
  it('encodes canonical MIDI spec examples', () => {
    expect(encodeVarLen(0)).toEqual([0x00]);
    expect(encodeVarLen(0x40)).toEqual([0x40]);
    expect(encodeVarLen(0x7f)).toEqual([0x7f]);
    expect(encodeVarLen(0x80)).toEqual([0x81, 0x00]);
    expect(encodeVarLen(0x2000)).toEqual([0xc0, 0x00]);
    expect(encodeVarLen(0x3fff)).toEqual([0xff, 0x7f]);
    expect(encodeVarLen(0x4000)).toEqual([0x81, 0x80, 0x00]);
    expect(encodeVarLen(0x0fffffff)).toEqual([0xff, 0xff, 0xff, 0x7f]);
  });
});

describe('GM_NOTES', () => {
  it('uses the fixed GM percussion mapping', () => {
    expect(GM_NOTES).toEqual({
      kick: 36,
      snare: 38,
      hihat_closed: 42,
      hihat_open: 46,
      clap: 39,
      tom: 45,
    });
  });
});

/** Tiny SMF reader: splits chunks and walks track events for assertions. */
function parseSmf(bytes: Uint8Array) {
  const ascii = (o: number, n: number) => String.fromCharCode(...bytes.slice(o, o + n));
  expect(ascii(0, 4)).toBe('MThd');
  const headerLen = (bytes[4] << 24) | (bytes[5] << 16) | (bytes[6] << 8) | bytes[7];
  const format = (bytes[8] << 8) | bytes[9];
  const ntrks = (bytes[10] << 8) | bytes[11];
  const division = (bytes[12] << 8) | bytes[13];
  expect(ascii(14, 4)).toBe('MTrk');
  const trackLen = (bytes[18] << 24) | (bytes[19] << 16) | (bytes[20] << 8) | bytes[21];
  const track = bytes.slice(22, 22 + trackLen);
  expect(22 + trackLen).toBe(bytes.length);

  // Walk events (no running status is emitted by the encoder).
  const events: { tick: number; data: number[] }[] = [];
  let i = 0;
  let tick = 0;
  while (i < track.length) {
    let delta = 0;
    while (track[i] & 0x80) {
      delta = (delta << 7) | (track[i] & 0x7f);
      i++;
    }
    delta = (delta << 7) | track[i++];
    tick += delta;
    const status = track[i];
    if (status === 0xff) {
      const len = track[i + 2];
      events.push({ tick, data: Array.from(track.slice(i, i + 3 + len)) });
      i += 3 + len;
    } else {
      events.push({ tick, data: Array.from(track.slice(i, i + 3)) });
      i += 3;
    }
  }
  return { headerLen, format, ntrks, division, trackLen, events };
}

describe('encodePatternToSmf', () => {
  it('emits a byte-exact minimal file for a single kick', () => {
    const p = emptyPattern(120, 16);
    p.grid.kick[0] = 1;
    const bytes = encodePatternToSmf(p);
    // Header chunk.
    expect(Array.from(bytes.slice(0, 14))).toEqual([
      0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, 0x01, 0xe0,
    ]);
    const { events, format, ntrks, division } = parseSmf(bytes);
    expect(format).toBe(0);
    expect(ntrks).toBe(1);
    expect(division).toBe(480);
    // Tempo: 120 bpm → 500000 µs/quarter = 0x07A120.
    expect(events[0]).toEqual({ tick: 0, data: [0xff, 0x51, 0x03, 0x07, 0xa1, 0x20] });
    expect(events[1]).toEqual({ tick: 0, data: [NOTE_ON_CH10, 36, 127] });
    expect(events[2]).toEqual({ tick: 60, data: [NOTE_OFF_CH10, 36, 0] });
    // End of track at the loop boundary (16 steps × 120 ticks).
    expect(events[3]).toEqual({ tick: 16 * TICKS_PER_STEP, data: [0xff, 0x2f, 0x00] });
  });

  it('carries every active cell as a channel-10 on/off pair with grid velocity', () => {
    const p = emptyPattern(96, 32);
    p.grid.kick[0] = 1;
    p.grid.kick[8] = 0.5;
    p.grid.snare[4] = 0.85;
    p.grid.hihat_open[31] = 0.3;
    p.grid.clap[2] = 0.7;
    p.grid.tom[17] = 0.9;
    const { events } = parseSmf(encodePatternToSmf(p));
    const ons = events.filter((e) => e.data[0] === NOTE_ON_CH10);
    const offs = events.filter((e) => e.data[0] === NOTE_OFF_CH10);
    expect(ons).toHaveLength(6);
    expect(offs).toHaveLength(6);
    // Tempo meta from the pattern: 96 bpm → 625000 µs.
    expect(events[0].data).toEqual([0xff, 0x51, 0x03, 0x09, 0x89, 0x68]);
    // Spot-check placements + velocity mapping.
    expect(ons).toContainEqual({ tick: 0, data: [NOTE_ON_CH10, GM_NOTES.kick, 127] });
    expect(ons).toContainEqual({ tick: 8 * 120, data: [NOTE_ON_CH10, GM_NOTES.kick, 64] });
    expect(ons).toContainEqual({ tick: 4 * 120, data: [NOTE_ON_CH10, GM_NOTES.snare, 108] });
    expect(ons).toContainEqual({ tick: 31 * 120, data: [NOTE_ON_CH10, GM_NOTES.hihat_open, 38] });
    expect(ons).toContainEqual({ tick: 2 * 120, data: [NOTE_ON_CH10, GM_NOTES.clap, 89] });
    expect(ons).toContainEqual({ tick: 17 * 120, data: [NOTE_ON_CH10, GM_NOTES.tom, 114] });
    // Every off is half a step (60 ticks) after its on.
    for (const on of ons) {
      expect(offs).toContainEqual({ tick: on.tick + 60, data: [NOTE_OFF_CH10, on.data[1], 0] });
    }
    // Ticks are non-decreasing (delta times were valid).
    for (let i = 1; i < events.length; i++) {
      expect(events[i].tick).toBeGreaterThanOrEqual(events[i - 1].tick);
    }
    // End of track closes the 2-bar loop.
    expect(events.at(-1)).toEqual({ tick: 32 * TICKS_PER_STEP, data: [0xff, 0x2f, 0x00] });
  });

  it('an empty pattern still yields a valid file with tempo + EOT', () => {
    const { events, division } = parseSmf(encodePatternToSmf(emptyPattern(100, 16)));
    expect(division).toBe(TICKS_PER_QUARTER);
    expect(events).toHaveLength(2);
    expect(events[0].data.slice(0, 3)).toEqual([0xff, 0x51, 0x03]);
    expect(events[1].data).toEqual([0xff, 0x2f, 0x00]);
  });
});

describe('smfFilename', () => {
  it('names files by tempo, keeping half-bpm precision only when present', () => {
    expect(smfFilename(emptyPattern(96, 16))).toBe('beat-96bpm.mid');
    expect(smfFilename(emptyPattern(127.5, 16))).toBe('beat-127.5bpm.mid');
  });
});
