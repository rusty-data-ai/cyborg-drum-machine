import { describe, expect, it } from 'vitest';
import {
  MIDI_PREFS_KEY,
  MidiOut,
  parseMidiPrefs,
  saveMidiPrefs,
  type MidiAccessLike,
  type MidiOutputLike,
} from './midiOut';
import { GM_NOTES } from './midiFile';

function fakeOutput(id: string, name = id): MidiOutputLike & { sends: { data: number[]; ts?: number }[] } {
  return {
    id,
    name,
    sends: [],
    send(data: number[] | Uint8Array, timestamp?: number) {
      this.sends.push({ data: Array.from(data), ts: timestamp });
    },
  };
}

function fakeAccess(outputs: MidiOutputLike[]): MidiAccessLike & { outputs: Map<string, MidiOutputLike> } {
  return { outputs: new Map(outputs.map((o) => [o.id, o])), onstatechange: null };
}

const fixedCtx = {
  currentTime: 10,
  getOutputTimestamp: () => ({ contextTime: 10, performanceTime: 50_000 }),
};

describe('parseMidiPrefs', () => {
  it('defaults on null / malformed / wrong types', () => {
    expect(parseMidiPrefs(null)).toEqual({ enabled: false, deviceId: null });
    expect(parseMidiPrefs('nonsense{')).toEqual({ enabled: false, deviceId: null });
    expect(parseMidiPrefs('{"enabled":"yes","deviceId":7}')).toEqual({
      enabled: false,
      deviceId: null,
    });
  });

  it('round-trips through storage', () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    } as Storage;
    saveMidiPrefs({ enabled: true, deviceId: 'abc' }, storage);
    expect(parseMidiPrefs(store.get(MIDI_PREFS_KEY) ?? null)).toEqual({
      enabled: true,
      deviceId: 'abc',
    });
  });
});

describe('MidiOut', () => {
  it('enumerates outputs after enable and selects by id', async () => {
    const out = fakeOutput('a', 'Synth A');
    const midi = new MidiOut(() => fixedCtx, async () => fakeAccess([out, fakeOutput('b', 'Synth B')]));
    expect(midi.enabled).toBe(false);
    expect(midi.outputs()).toEqual([]);
    await midi.enable();
    expect(midi.enabled).toBe(true);
    expect(midi.outputs()).toEqual([
      { id: 'a', name: 'Synth A' },
      { id: 'b', name: 'Synth B' },
    ]);
    midi.select('a');
    expect(midi.selectedId).toBe('a');
  });

  it('noteAt sends channel-10 on/off with timestamps mapped from audio time', async () => {
    const out = fakeOutput('a');
    const midi = new MidiOut(() => fixedCtx, async () => fakeAccess([out]));
    await midi.enable();
    midi.select('a');
    // 10.12 s audio time = 120 ms after the mapping anchor → 50_120 ms perf.
    midi.noteAt('snare', 0.85, 10.12, 62.5);
    expect(out.sends).toHaveLength(2);
    expect(out.sends[0].data).toEqual([0x99, GM_NOTES.snare, 108]);
    expect(out.sends[0].ts).toBeCloseTo(50_120);
    expect(out.sends[1].data).toEqual([0x89, GM_NOTES.snare, 0]);
    expect(out.sends[1].ts).toBeCloseTo(50_182.5);
  });

  it('noteAt is a no-op with no device selected', async () => {
    const out = fakeOutput('a');
    const midi = new MidiOut(() => fixedCtx, async () => fakeAccess([out]));
    await midi.enable();
    midi.noteAt('kick', 1, 10.0);
    expect(out.sends).toHaveLength(0);
  });

  it('allNotesOff sends CC 123 plus explicit note-offs', async () => {
    const out = fakeOutput('a');
    const midi = new MidiOut(() => fixedCtx, async () => fakeAccess([out]));
    await midi.enable();
    midi.select('a');
    midi.allNotesOff();
    expect(out.sends[0].data).toEqual([0xb9, 123, 0]);
    const offs = out.sends.slice(1).map((s) => s.data);
    expect(offs).toHaveLength(6);
    for (const note of Object.values(GM_NOTES)) expect(offs).toContainEqual([0x89, note, 0]);
  });

  it('unplugging the active device deselects it and notifies', async () => {
    const out = fakeOutput('a');
    const access = fakeAccess([out]);
    const midi = new MidiOut(() => fixedCtx, async () => access);
    await midi.enable();
    midi.select('a');
    let notified = 0;
    midi.onDevicesChanged = () => notified++;
    access.outputs.delete('a');
    access.onstatechange?.({});
    expect(midi.selectedId).toBeNull();
    expect(notified).toBe(1);
    // Subsequent sends are safe no-ops.
    midi.noteAt('kick', 1, 10.0);
    expect(out.sends).toHaveLength(0);
  });

  it('switching devices silences the previous one', async () => {
    const a = fakeOutput('a');
    const b = fakeOutput('b');
    const midi = new MidiOut(() => fixedCtx, async () => fakeAccess([a, b]));
    await midi.enable();
    midi.select('a');
    midi.select('b');
    expect(a.sends[0].data).toEqual([0xb9, 123, 0]);
    expect(midi.selectedId).toBe('b');
  });
});
