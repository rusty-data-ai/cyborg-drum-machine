import { useRef, type ReactNode } from 'react';
import type { UserExample } from '../lib/knn';
import { MIN_KNN_EXAMPLES } from '../lib/blend';
import {
  MIN_EVAL_CLASSES,
  MIN_EVAL_EXAMPLES,
  type ProfileEvaluation,
} from '../lib/profileEval';
import type { DrumClass } from '../lib/types';
import { DRUM_CLASSES, DRUM_LABELS, isModelDrumClass } from '../lib/types';

/** What the blended classifier said about the most recent teach/test sound. */
export interface TeachFeedback {
  /** Pad that was being taught/tested. */
  target: DrumClass;
  /** null = the classifier would have rejected the sound. */
  predicted: DrumClass | null;
  confidence: number;
  /** false in test mode (nothing captured). */
  stored: boolean;
}

interface Props {
  counts: Record<DrumClass, number>;
  examples: readonly UserExample[];
  /** Leave-one-out improvement stat; null until it is meaningful. */
  evaluation: ProfileEvaluation | null;
  /** Progress toward unlocking the stat (evaluable examples / classes). */
  evalProgress: { n: number; classes: number };
  activeTarget: DrumClass | null;
  testTarget: DrumClass | null;
  feedback: TeachFeedback | null;
  onSelectTarget: (drum: DrumClass | null) => void;
  onSelectTest: (drum: DrumClass | null) => void;
  onDeleteExample: (id: number) => void;
  onUndoLast: () => void;
  onClearProfile: () => void;
  /** Download the profile as a beatbox-profile-YYYYMMDD.json backup. */
  onExportProfile: () => void;
  /** Merge a previously exported profile file (accounts plan Phase 0). */
  onImportProfile: (file: File) => void;
  /** Result of the last export/import ("imported 12 examples", errors, …). */
  transferNote: string | null;
  /** Extra content (account/sync UI) rendered at the bottom of the panel. */
  accountSlot?: ReactNode;
}

const TARGET_EXAMPLES = 8;

function pct(v: number): string {
  return `${Math.round(v * 100)}%`;
}

function timeLabel(createdAt: number): string {
  return new Date(createdAt).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

export function TeachPanel({
  counts,
  examples,
  evaluation,
  evalProgress,
  activeTarget,
  testTarget,
  feedback,
  onSelectTarget,
  onSelectTest,
  onDeleteExample,
  onUndoLast,
  onClearProfile,
  onExportProfile,
  onImportProfile,
  transferNote,
  accountSlot,
}: Props) {
  const importInputRef = useRef<HTMLInputElement>(null);
  const total = DRUM_CLASSES.reduce((a, c) => a + counts[c], 0);
  return (
    <div className="teach">
      <p className="teach-intro">
        Teach the AI <em>your</em> sounds: pick a drum, then make that sound ~{TARGET_EXAMPLES}{' '}
        times into the mic. Examples are stored only in this browser. The more you teach, the
        more the transcription trusts your personal profile. Clap and Tom are extra pads the
        base model doesn't know — teach them {MIN_KNN_EXAMPLES}+ examples and transcription
        picks them up too.
      </p>
      {evaluation ? (
        <div className="teach-status unlocked">
          <div className="teach-stat">
            global model alone: <strong>{pct(evaluation.globalAcc)}</strong>
            {' → '}with your profile:{' '}
            <strong className="teach-stat-good">{pct(evaluation.blendedAcc)}</strong>
            <span className="teach-stat-n">
              {' '}
              (measured on your {evaluation.nEvaluable} taught examples)
            </span>
          </div>
          <div className="teach-stat-sub">
            Leave-one-out test: each taught example is scored by the rest of your profile, with
            and without it. Clap/Tom can only ever be right <em>with</em> your profile — the base
            model doesn't know them.
          </div>
        </div>
      ) : (
        <div className="teach-status locked">
          <div className="teach-stat-sub">
            {evalProgress.n < MIN_EVAL_EXAMPLES
              ? `teach ${MIN_EVAL_EXAMPLES - evalProgress.n} more example${
                  MIN_EVAL_EXAMPLES - evalProgress.n === 1 ? '' : 's'
                }`
              : `spread examples across ${MIN_EVAL_CLASSES}+ pads`}{' '}
            to unlock your accuracy score ({evalProgress.n}/{MIN_EVAL_EXAMPLES} across{' '}
            {evalProgress.classes} pad{evalProgress.classes === 1 ? '' : 's'} so far)
          </div>
        </div>
      )}
      <div className="teach-pads">
        {DRUM_CLASSES.map((drum) => {
          const active = activeTarget === drum;
          const testing = testTarget === drum;
          const done = counts[drum] >= TARGET_EXAMPLES;
          const knnOnly = !isModelDrumClass(drum);
          const padExamples = examples.filter((e) => e.label === drum);
          return (
            <div
              key={drum}
              className={`teach-pad ${active ? 'active' : ''} ${testing ? 'testing' : ''} ${done ? 'done' : ''}`}
            >
              <button
                className="teach-pad-main"
                onClick={() => onSelectTarget(active ? null : drum)}
              >
                <span className="teach-pad-name">{DRUM_LABELS[drum]}</span>
                <span className="teach-pad-count">
                  {counts[drum]} / {TARGET_EXAMPLES}
                </span>
                {active && <span className="teach-pad-live">listening…</span>}
                {testing && <span className="teach-pad-live">make the sound…</span>}
              </button>
              <button
                className="btn subtle teach-test"
                onClick={() => onSelectTest(testing ? null : drum)}
              >
                {testing ? 'stop test' : 'test me'}
              </button>
              {knnOnly && counts[drum] < MIN_KNN_EXAMPLES && (
                <span className="teach-pad-note">
                  needs {MIN_KNN_EXAMPLES}+ examples before transcription uses it
                </span>
              )}
              {padExamples.length > 0 && (
                <div className="example-chips">
                  {padExamples.map((ex) => (
                    <span
                      key={ex.id}
                      className="example-chip"
                      title={new Date(ex.createdAt).toLocaleString()}
                    >
                      {timeLabel(ex.createdAt)}
                      <button
                        className="chip-x"
                        aria-label={`delete ${DRUM_LABELS[drum]} example`}
                        onClick={() => onDeleteExample(ex.id)}
                      >
                        ×
                      </button>
                    </span>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
      {feedback && (
        <div
          className={`teach-feedback ${feedback.predicted === feedback.target ? 'match' : 'mismatch'}`}
        >
          {feedback.predicted
            ? `heard as ${DRUM_LABELS[feedback.predicted]} · ${Math.round(feedback.confidence * 100)}%`
            : 'heard — but the classifier would reject that sound'}
          {feedback.stored && ' · example stored'}
        </div>
      )}
      <div className="teach-footer">
        <span className="teach-total">
          {total === 0
            ? 'No personal profile yet — using the global model.'
            : `${total} example${total === 1 ? '' : 's'} in your profile.`}
        </span>
        {total > 0 && (
          <span className="teach-actions">
            <button className="btn subtle" onClick={onUndoLast}>
              undo last
            </button>
            <button className="btn subtle" onClick={onClearProfile}>
              reset profile
            </button>
          </span>
        )}
      </div>
      <div className="teach-transfer">
        <span className="teach-transfer-label">
          Backup — your profile as a file, restorable on any device:
        </span>
        <button
          className="btn subtle"
          onClick={onExportProfile}
          disabled={total === 0}
          title="Download your taught examples + settings as a JSON file"
        >
          export profile
        </button>
        <button
          className="btn subtle"
          onClick={() => importInputRef.current?.click()}
          title="Merge a previously exported profile file into this browser"
        >
          import profile
        </button>
        <input
          ref={importInputRef}
          type="file"
          accept=".json,application/json"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) onImportProfile(file);
            e.target.value = ''; // allow re-importing the same file
          }}
        />
        {transferNote && <span className="teach-transfer-note">{transferNote}</span>}
      </div>
      {accountSlot}
    </div>
  );
}
