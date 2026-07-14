import type { DrumClass } from '../lib/types';
import { DRUM_CLASSES, DRUM_LABELS } from '../lib/types';

interface Props {
  counts: Record<DrumClass, number>;
  activeTarget: DrumClass | null;
  recording: boolean;
  onSelectTarget: (drum: DrumClass | null) => void;
  onClearProfile: () => void;
}

const TARGET_EXAMPLES = 8;

export function TeachPanel({
  counts,
  activeTarget,
  recording,
  onSelectTarget,
  onClearProfile,
}: Props) {
  const total = DRUM_CLASSES.reduce((a, c) => a + counts[c], 0);
  return (
    <div className="teach">
      <p className="teach-intro">
        Teach the AI <em>your</em> sounds: pick a drum, then make that sound ~{TARGET_EXAMPLES}{' '}
        times into the mic. Examples are stored only in this browser. The more you teach, the
        more the transcription trusts your personal profile.
      </p>
      <div className="teach-pads">
        {DRUM_CLASSES.map((drum) => {
          const active = activeTarget === drum;
          const done = counts[drum] >= TARGET_EXAMPLES;
          return (
            <button
              key={drum}
              className={`teach-pad ${active ? 'active' : ''} ${done ? 'done' : ''}`}
              onClick={() => onSelectTarget(active ? null : drum)}
            >
              <span className="teach-pad-name">{DRUM_LABELS[drum]}</span>
              <span className="teach-pad-count">
                {counts[drum]} / {TARGET_EXAMPLES}
              </span>
              {active && recording && <span className="teach-pad-live">listening…</span>}
            </button>
          );
        })}
      </div>
      <div className="teach-footer">
        <span className="teach-total">
          {total === 0
            ? 'No personal profile yet — using the global model.'
            : `${total} example${total === 1 ? '' : 's'} in your profile.`}
        </span>
        {total > 0 && (
          <button className="btn subtle" onClick={onClearProfile}>
            reset profile
          </button>
        )}
      </div>
    </div>
  );
}
