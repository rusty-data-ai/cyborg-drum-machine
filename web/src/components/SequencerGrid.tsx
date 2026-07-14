import type { DrumClass, Pattern } from '../lib/types';
import { DRUM_CLASSES, DRUM_LABELS } from '../lib/types';

interface Props {
  pattern: Pattern;
  playhead: number; // -1 when stopped
  flash: Partial<Record<DrumClass, number>>; // timestamp of last live hit per row
  onToggle: (drum: DrumClass, step: number) => void;
  onPadHit: (drum: DrumClass) => void;
}

export function SequencerGrid({ pattern, playhead, flash, onToggle, onPadHit }: Props) {
  const now = performance.now();
  return (
    <div className="grid" style={{ ['--steps' as string]: pattern.steps }}>
      {DRUM_CLASSES.map((drum) => {
        const flashing = flash[drum] !== undefined && now - (flash[drum] as number) < 220;
        return (
          <div className="grid-row" key={drum}>
            <button
              className={`pad-label ${flashing ? 'flashing' : ''}`}
              onClick={() => onPadHit(drum)}
              title="Tap to audition"
            >
              {DRUM_LABELS[drum]}
            </button>
            <div className="grid-cells">
              {pattern.grid[drum].map((vel, s) => (
                <button
                  key={s}
                  className={[
                    'cell',
                    vel > 0 ? 'on' : '',
                    s === playhead ? 'playhead' : '',
                    s % 4 === 0 ? 'beat' : '',
                  ].join(' ')}
                  style={vel > 0 ? { ['--vel' as string]: vel } : undefined}
                  onClick={() => onToggle(drum, s)}
                />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
