import { audioToPerfTime, clockMapping, type AudioClockSource } from './audioTime';
import { CC_ALL_NOTES_OFF, CC_CH10, GM_NOTES, NOTE_OFF_CH10, NOTE_ON_CH10, velocityToMidi } from './midiFile';
import type { DrumClass } from './types';

/**
 * Real-time Web MIDI output. Owns MIDIAccess + device selection; converts the
 * sequencer's scheduled AudioContext times to DOMHighResTimeStamps and hands
 * them to MIDIOutput.send so the browser's MIDI stack delivers on the beat.
 *
 * The device layer is injectable (structural types + a requestAccess factory)
 * so everything is testable without real MIDI hardware.
 */

export interface MidiOutputLike {
  id: string;
  name?: string | null;
  send(data: number[] | Uint8Array, timestamp?: number): void;
}

export interface MidiAccessLike {
  outputs: ReadonlyMap<string, MidiOutputLike>;
  onstatechange: ((ev: unknown) => void) | null;
}

export interface MidiDeviceInfo {
  id: string;
  name: string;
}

// ---- persisted prefs (separate key: AppSettings is numeric-only) ----

export interface MidiPrefs {
  enabled: boolean;
  deviceId: string | null;
}

export const MIDI_PREFS_KEY = 'beatbox-midi';

export function parseMidiPrefs(raw: string | null): MidiPrefs {
  const out: MidiPrefs = { enabled: false, deviceId: null };
  if (!raw) return out;
  try {
    const data = JSON.parse(raw) as Record<string, unknown>;
    if (typeof data !== 'object' || data === null) return out;
    if (typeof data.enabled === 'boolean') out.enabled = data.enabled;
    if (typeof data.deviceId === 'string') out.deviceId = data.deviceId;
  } catch {
    // malformed → defaults
  }
  return out;
}

export function loadMidiPrefs(storage?: Storage): MidiPrefs {
  const s = storage ?? (typeof localStorage !== 'undefined' ? localStorage : null);
  return parseMidiPrefs(s?.getItem(MIDI_PREFS_KEY) ?? null);
}

export function saveMidiPrefs(prefs: MidiPrefs, storage?: Storage): void {
  const s = storage ?? (typeof localStorage !== 'undefined' ? localStorage : null);
  s?.setItem(MIDI_PREFS_KEY, JSON.stringify(prefs));
}

// ---- device layer ----

type RequestAccess = () => Promise<MidiAccessLike>;

function defaultRequestAccess(): Promise<MidiAccessLike> {
  const nav = navigator as Navigator & {
    requestMIDIAccess(opts?: { sysex: boolean }): Promise<unknown>;
  };
  // Real MIDIAccess structurally satisfies MidiAccessLike (readonly usage only).
  return nav.requestMIDIAccess({ sysex: false }) as Promise<MidiAccessLike>;
}

export class MidiOut {
  private access: MidiAccessLike | null = null;
  private out: MidiOutputLike | null = null;
  private getCtx: () => AudioClockSource | null;
  private requestAccess: RequestAccess;
  /** Fired on hot-plug/unplug (and after enable) so the UI can refresh. */
  onDevicesChanged: (() => void) | null = null;

  constructor(getCtx: () => AudioClockSource | null, requestAccess: RequestAccess = defaultRequestAccess) {
    this.getCtx = getCtx;
    this.requestAccess = requestAccess;
  }

  static get supported(): boolean {
    return typeof navigator !== 'undefined' && 'requestMIDIAccess' in navigator;
  }

  get enabled(): boolean {
    return this.access !== null;
  }

  get selectedId(): string | null {
    return this.out?.id ?? null;
  }

  /** Request MIDI access (no sysex). Called lazily on first user enable. */
  async enable(): Promise<void> {
    if (this.access) return;
    const access = await this.requestAccess();
    this.access = access;
    access.onstatechange = () => this.handleStateChange();
    this.handleStateChange();
  }

  outputs(): MidiDeviceInfo[] {
    if (!this.access) return [];
    return [...this.access.outputs.values()].map((o) => ({
      id: o.id,
      name: o.name || o.id,
    }));
  }

  /** Select an output by id (null deselects). Silences the previous device. */
  select(id: string | null): void {
    if (this.out && this.out.id !== id) this.allNotesOff();
    this.out = id === null ? null : (this.access?.outputs.get(id) ?? null);
  }

  /**
   * Send a note-on/off pair for a scheduled hit. `audioTime` is the exact
   * AudioContext time from the sequencer's lookahead schedule; conversion via
   * getOutputTimestamp keeps MIDI in sync with the audible hit.
   */
  noteAt(drum: DrumClass, velocity: number, audioTime: number, noteOffMs = 60): void {
    const ctx = this.getCtx();
    if (!this.out || !ctx) return;
    const t = audioToPerfTime(audioTime, clockMapping(ctx));
    const note = GM_NOTES[drum];
    try {
      this.out.send([NOTE_ON_CH10, note, velocityToMidi(velocity)], t);
      this.out.send([NOTE_OFF_CH10, note, 0], t + noteOffMs);
    } catch {
      // device vanished mid-send — statechange will clean up
    }
  }

  /** CC 123 + explicit note-offs so nothing hangs on stop/clear/switch. */
  allNotesOff(): void {
    if (!this.out) return;
    try {
      this.out.send([CC_CH10, CC_ALL_NOTES_OFF, 0]);
      for (const note of Object.values(GM_NOTES)) this.out.send([NOTE_OFF_CH10, note, 0]);
    } catch {
      // ignore: device already gone
    }
  }

  private handleStateChange(): void {
    // Unplugging the active device deselects it gracefully.
    if (this.out && !this.access?.outputs.has(this.out.id)) this.out = null;
    this.onDevicesChanged?.();
  }
}
