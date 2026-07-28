import { useState } from 'react';
import type { HitPlacement } from '../lib/quantize';
import type { ClassifiedHit, DrumClass } from '../lib/types';
import { DRUM_CLASSES, DRUM_LABELS } from '../lib/types';

/**
 * Post-transcription review: one chip per classified hit, in time order.
 * Chips represent *what the model heard* (correction semantics), distinct
 * from editing the beat in the grid. Tapping a chip opens a chooser with the
 * six drums + "not a drum"; corrections feed the KNN profile upstream.
 * View-state only — never serialized into the share URL.
 */

export type ReviewChoice = DrumClass | 'not_drum';

interface Props {
  hits: readonly ClassifiedHit[];
  placements: readonly HitPlacement[];
  corrections: Readonly<Record<number, ReviewChoice>>;
  /** Transient confirmation line, e.g. "learned: that was a Tom". */
  note: string | null;
  onChoose: (hitIndex: number, choice: ReviewChoice) => void;
}

export function ReviewStrip({ hits, placements, corrections, note, onChoose }: Props) {
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  if (placements.length === 0) return null;

  return (
    <div className="review-strip">
      <div className="review-header">
        what the AI heard — tap a hit to correct it (corrections teach your profile)
      </div>
      <div className="review-chips">
        {placements.map((p) => {
          const hit = hits[p.hitIndex];
          if (!hit) return null;
          const correction = corrections[p.hitIndex];
          const current: DrumClass | null =
            correction === undefined ? p.drum : correction === 'not_drum' ? null : correction;
          const open = openIndex === p.hitIndex;
          return (
            <span key={p.hitIndex} className="review-chip-wrap">
              <button
                className={`review-chip ${correction !== undefined ? 'corrected' : ''} ${open ? 'open' : ''}`}
                aria-expanded={open}
                aria-label={`hit ${p.hitIndex + 1}: heard as ${current ? DRUM_LABELS[current] : 'not a drum'}`}
                onClick={() => setOpenIndex(open ? null : p.hitIndex)}
              >
                <span className="review-chip-drum">
                  {current ? DRUM_LABELS[current] : '✕ not a drum'}
                </span>
                <span className="review-chip-conf">{Math.round(hit.confidence * 100)}%</span>
              </button>
              {open && (
                <span className="review-chooser" role="menu">
                  {DRUM_CLASSES.map((d) => (
                    <button
                      key={d}
                      role="menuitem"
                      className={`btn subtle ${d === current ? 'current' : ''}`}
                      onClick={() => {
                        setOpenIndex(null);
                        onChoose(p.hitIndex, d);
                      }}
                    >
                      {DRUM_LABELS[d]}
                    </button>
                  ))}
                  <button
                    role="menuitem"
                    className="btn subtle"
                    onClick={() => {
                      setOpenIndex(null);
                      onChoose(p.hitIndex, 'not_drum');
                    }}
                  >
                    not a drum
                  </button>
                </span>
              )}
            </span>
          );
        })}
      </div>
      {note && <div className="review-note">{note}</div>}
    </div>
  );
}
