import type { MidiDeviceInfo } from '../lib/midiOut';

interface Props {
  /** Web MIDI available in this browser (controls hidden entirely when not). */
  supported: boolean;
  enabled: boolean;
  devices: MidiDeviceInfo[];
  selectedId: string | null;
  /** Subtle status note, e.g. "MIDI device disconnected". */
  note: string | null;
  hasPattern: boolean;
  onToggle: (on: boolean) => void;
  onSelect: (id: string | null) => void;
  onExport: () => void;
}

/**
 * MIDI corner of the pattern-controls row: live Web MIDI out (toggle + device
 * picker, only where the API exists) and the universal .mid export.
 */
export function MidiControls({
  supported,
  enabled,
  devices,
  selectedId,
  note,
  hasPattern,
  onToggle,
  onSelect,
  onExport,
}: Props) {
  return (
    <span className="midi-controls">
      <button
        className="btn subtle"
        onClick={onExport}
        disabled={!hasPattern}
        title="Download this beat as a Standard MIDI File"
      >
        export .mid
      </button>
      {supported && (
        <label className="ctl" title="Send the beat to a MIDI device while it plays">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => onToggle(e.target.checked)}
          />
          midi out
        </label>
      )}
      {supported && enabled && (
        <select
          className="midi-device"
          aria-label="midi output device"
          value={selectedId ?? ''}
          onChange={(e) => onSelect(e.target.value || null)}
        >
          {devices.length === 0 && <option value="">no MIDI outputs found</option>}
          {devices.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </select>
      )}
      {note && <span className="midi-note">{note}</span>}
    </span>
  );
}
