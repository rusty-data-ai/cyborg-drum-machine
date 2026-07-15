import type { AppSettings } from '../lib/settings';
import { DEFAULT_SETTINGS, SETTINGS_RANGES } from '../lib/settings';

interface Props {
  settings: AppSettings;
  onChange: (patch: Partial<AppSettings>) => void;
}

interface Row {
  key: keyof AppSettings;
  label: string;
  step: number;
  format: (v: number) => string;
}

const ROWS: Row[] = [
  { key: 'sensitivity', label: 'onset sensitivity', step: 0.05, format: (v) => v.toFixed(2) },
  { key: 'minGapMs', label: 'min gap between hits', step: 5, format: (v) => `${v} ms` },
  { key: 'noiseGateDb', label: 'ignore quiet sounds below', step: 1, format: (v) => `${v} dB` },
  { key: 'confidenceFloor', label: 'confidence floor', step: 0.05, format: (v) => v.toFixed(2) },
  { key: 'profileWeight', label: 'trust my profile', step: 0.05, format: (v) => v.toFixed(2) },
  { key: 'kitVolume', label: 'kit volume', step: 0.05, format: (v) => v.toFixed(2) },
];

export function SettingsPanel({ settings, onChange }: Props) {
  return (
    <div className="settings-panel">
      {ROWS.map(({ key, label, step, format }) => {
        const [min, max] = SETTINGS_RANGES[key];
        return (
          <label className="settings-row" key={key}>
            <span className="settings-label">{label}</span>
            <input
              type="range"
              aria-label={label}
              min={min}
              max={max}
              step={step}
              value={settings[key]}
              onChange={(e) => onChange({ [key]: Number(e.target.value) })}
            />
            <span className="settings-value">{format(settings[key])}</span>
          </label>
        );
      })}
      <button className="btn subtle" onClick={() => onChange({ ...DEFAULT_SETTINGS })}>
        reset defaults
      </button>
    </div>
  );
}
