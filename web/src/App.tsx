import { useCallback, useEffect, useRef, useState } from 'react';
import './App.css';
import { SequencerGrid } from './components/SequencerGrid';
import { TeachPanel } from './components/TeachPanel';
import { HitClassifier } from './lib/classifier';
import { DrumKit } from './lib/drumSynth';
import { startMetronome, type MetronomeHandle } from './lib/metronome';
import { MicEngine, type SegmentEvent } from './lib/micEngine';
import { quantizeHits } from './lib/quantize';
import { Sequencer } from './lib/sequencer';
import type { ClassifiedHit, DrumClass, Pattern } from './lib/types';
import { DRUM_CLASSES, emptyPattern } from './lib/types';

const MAX_RECORD_S = 20;
const SILENCE_STOP_S = 2.4;

type Tab = 'play' | 'teach';

export default function App() {
  const [modelReady, setModelReady] = useState(false);
  const [modelError, setModelError] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [pattern, setPattern] = useState<Pattern>(emptyPattern());
  const [hasPattern, setHasPattern] = useState(false);
  const [playhead, setPlayhead] = useState(-1);
  const [level, setLevel] = useState(0);
  const [sensitivity, setSensitivity] = useState(0.5);
  const [metroMode, setMetroMode] = useState(false);
  const [metroBpm, setMetroBpm] = useState(95);
  const [flash, setFlash] = useState<Partial<Record<DrumClass, number>>>({});
  const [hitLed, setHitLed] = useState(0);
  const [tab, setTab] = useState<Tab>('play');
  const [teachTarget, setTeachTarget] = useState<DrumClass | null>(null);
  const [profileCounts, setProfileCounts] = useState<Record<DrumClass, number>>(
    Object.fromEntries(DRUM_CLASSES.map((c) => [c, 0])) as Record<DrumClass, number>,
  );
  const [micWarning, setMicWarning] = useState(false);
  const [countingIn, setCountingIn] = useState(false);

  const ctxRef = useRef<AudioContext | null>(null);
  const kitRef = useRef<DrumKit | null>(null);
  const seqRef = useRef<Sequencer | null>(null);
  const micRef = useRef<MicEngine | null>(null);
  const classifierRef = useRef<HitClassifier>(new HitClassifier());
  const hitsRef = useRef<ClassifiedHit[]>([]);
  const metroRef = useRef<MetronomeHandle | null>(null);
  const recordEpochRef = useRef<number | null>(null);
  const recordStartRef = useRef(0);
  const lastActivityRef = useRef(0);
  const tabRef = useRef<Tab>('play');
  const teachTargetRef = useRef<DrumClass | null>(null);
  const recordingRef = useRef(false);
  const patternRef = useRef(pattern);

  tabRef.current = tab;
  teachTargetRef.current = teachTarget;
  recordingRef.current = recording;
  patternRef.current = pattern;

  // Load the classifier once (pure WASM, no user gesture needed).
  useEffect(() => {
    classifierRef.current
      .load()
      .then(() => {
        setProfileCounts(classifierRef.current.profile.countsByClass());
        setModelReady(true);
      })
      .catch((err) => {
        console.error('model load failed', err);
        setModelError(
          'Classifier model not found — the drum machine still works, but beatbox transcription is disabled.',
        );
      });
  }, []);

  // Re-render shortly after a flash so highlights can turn off.
  useEffect(() => {
    if (Object.keys(flash).length === 0 && hitLed === 0) return;
    const t = window.setTimeout(() => {
      setFlash({});
      setHitLed(0);
    }, 240);
    return () => clearTimeout(t);
  }, [flash, hitLed]);

  const handleSegment = useCallback(async (seg: SegmentEvent) => {
    const classifier = classifierRef.current;
    if (!classifier.ready) return;
    const ctx = ctxRef.current;
    if (!ctx) return;
    lastActivityRef.current = ctx.currentTime;

    if (tabRef.current === 'teach') {
      const target = teachTargetRef.current;
      if (!target) return;
      const patch = classifier.preparePatch(seg.pcm, seg.sampleRate);
      const { embedding } = await classifier.infer(patch);
      await classifier.profile.add(target, embedding, classifier.modelVersion);
      setProfileCounts(classifier.profile.countsByClass());
      setFlash((f) => ({ ...f, [target]: performance.now() }));
      return;
    }

    if (!recordingRef.current) return;
    // Ignore hits during the metronome count-in.
    if (recordEpochRef.current !== null && seg.time < recordEpochRef.current - 0.05) return;
    const hit = await classifier.classify(
      { time: seg.time, strength: seg.rmsPeak },
      seg.pcm,
      seg.sampleRate,
    );
    if (hit) {
      hitsRef.current.push(hit);
      setFlash((f) => ({ ...f, [hit.drum]: performance.now() }));
    }
  }, []);

  const ensureAudio = useCallback(async () => {
    if (!ctxRef.current) {
      const ctx = new AudioContext({ latencyHint: 'interactive' });
      ctxRef.current = ctx;
      const kit = new DrumKit(ctx);
      kitRef.current = kit;
      void kit.loadSamples();
      const seq = new Sequencer(ctx, kit, patternRef.current);
      seq.onStep = (step) => setPlayhead(step);
      seqRef.current = seq;
      const mic = new MicEngine(ctx);
      mic.events = {
        onOnset: () => {
          if (ctxRef.current) lastActivityRef.current = ctxRef.current.currentTime;
          setHitLed(performance.now());
        },
        onSegment: (seg) => void handleSegment(seg),
        onLevel: (rms) => setLevel(rms),
      };
      micRef.current = mic;
    }
    await ctxRef.current.resume();
  }, [handleSegment]);

  const stopPlayback = useCallback(() => {
    seqRef.current?.stop();
    setPlaying(false);
    setPlayhead(-1);
  }, []);

  const startPlayback = useCallback((pat: Pattern) => {
    const seq = seqRef.current;
    if (!seq) return;
    seq.setPattern(pat);
    seq.start();
    setPlaying(true);
  }, []);

  const stopRecording = useCallback(() => {
    micRef.current?.stop();
    metroRef.current?.stop();
    metroRef.current = null;
    setRecording(false);
    setCountingIn(false);
    const hits = hitsRef.current;
    if (tabRef.current === 'play' && hits.length > 0) {
      const pat = quantizeHits(
        hits,
        recordEpochRef.current !== null
          ? { knownBpm: metroBpm, origin: recordEpochRef.current }
          : {},
      );
      setPattern(pat);
      setHasPattern(true);
      startPlayback(pat);
    }
    recordEpochRef.current = null;
  }, [metroBpm, startPlayback]);

  const startRecording = useCallback(async () => {
    await ensureAudio();
    const ctx = ctxRef.current!;
    stopPlayback();
    hitsRef.current = [];
    recordEpochRef.current = null;
    if (metroMode) {
      const handle = startMetronome(ctx, metroBpm);
      metroRef.current = handle;
      recordEpochRef.current = handle.downbeat;
      setCountingIn(true);
      window.setTimeout(
        () => setCountingIn(false),
        Math.max(0, (handle.downbeat - ctx.currentTime) * 1000),
      );
    }
    await micRef.current!.start(sensitivity);
    setMicWarning(micRef.current!.processingWarning);
    recordStartRef.current = ctx.currentTime;
    lastActivityRef.current = ctx.currentTime;
    setRecording(true);
  }, [ensureAudio, metroMode, metroBpm, sensitivity, stopPlayback]);

  // Auto-stop on silence / max length.
  useEffect(() => {
    if (!recording || tab !== 'play') return;
    const iv = window.setInterval(() => {
      const ctx = ctxRef.current;
      if (!ctx) return;
      const now = ctx.currentTime;
      const dur = now - recordStartRef.current;
      const silent = now - lastActivityRef.current;
      if (dur > MAX_RECORD_S || (hitsRef.current.length > 0 && silent > SILENCE_STOP_S)) {
        stopRecording();
      }
    }, 200);
    return () => clearInterval(iv);
  }, [recording, tab, stopRecording]);

  const toggleCell = (drum: DrumClass, step: number) => {
    setPattern((p) => {
      const next: Pattern = { ...p, grid: { ...p.grid, [drum]: [...p.grid[drum]] } };
      next.grid[drum][step] = next.grid[drum][step] > 0 ? 0 : 0.85;
      seqRef.current?.setPattern(next);
      return next;
    });
    setHasPattern(true);
  };

  const setBpm = (bpm: number) => {
    setPattern((p) => {
      const next = { ...p, bpm };
      seqRef.current?.setPattern(next);
      return next;
    });
  };

  const auditionPad = async (drum: DrumClass) => {
    await ensureAudio();
    kitRef.current?.trigger(drum, ctxRef.current!.currentTime);
  };

  const handlePlayToggle = async () => {
    await ensureAudio();
    if (playing) stopPlayback();
    else startPlayback(pattern);
  };

  const handleTeachTarget = useCallback(
    async (drum: DrumClass | null) => {
      setTeachTarget(drum);
      if (drum) {
        await ensureAudio();
        if (!micRef.current!.running) {
          await micRef.current!.start(sensitivity);
          setMicWarning(micRef.current!.processingWarning);
        }
      } else if (!recordingRef.current) {
        micRef.current?.stop();
      }
    },
    [ensureAudio, sensitivity],
  );

  const switchTab = (t: Tab) => {
    if (recording) stopRecording();
    if (teachTarget) void handleTeachTarget(null);
    setTab(t);
  };

  const clearPattern = () => {
    stopPlayback();
    setPattern((p) => emptyPattern(p.bpm, p.steps));
    setHasPattern(false);
  };

  return (
    <div className="app">
      <header>
        <h1>
          <span className="logo-accent">CYBORG</span> DRUM MACHINE
        </h1>
        <nav>
          <button
            className={tab === 'play' ? 'tab active' : 'tab'}
            onClick={() => switchTab('play')}
          >
            Play
          </button>
          <button
            className={tab === 'teach' ? 'tab active' : 'tab'}
            onClick={() => switchTab('teach')}
          >
            Teach it your sounds
          </button>
        </nav>
      </header>

      {modelError && <div className="banner warn">{modelError}</div>}
      {micWarning && (
        <div className="banner warn">
          Your browser kept voice processing on — detection may be less accurate.
        </div>
      )}

      {tab === 'play' && (
        <>
          <div className="transport">
            <button
              className={`btn record ${recording ? 'armed' : ''}`}
              onClick={() => (recording ? stopRecording() : void startRecording())}
              disabled={!modelReady && !modelError}
              title="Record a beatboxed loop"
            >
              {recording ? (countingIn ? '· · · ·' : '■ STOP') : '● REC'}
            </button>
            <button className="btn" onClick={() => void handlePlayToggle()} disabled={!hasPattern}>
              {playing ? '❚❚ PAUSE' : '▶ PLAY'}
            </button>
            <label className="ctl">
              <input
                type="checkbox"
                checked={metroMode}
                onChange={(e) => setMetroMode(e.target.checked)}
                disabled={recording}
              />
              metronome
            </label>
            {metroMode && (
              <label className="ctl">
                <input
                  type="number"
                  min={60}
                  max={180}
                  value={metroBpm}
                  onChange={(e) => setMetroBpm(Number(e.target.value))}
                  disabled={recording}
                />
                bpm
              </label>
            )}
            <label className="ctl slider">
              sensitivity
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={sensitivity}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  setSensitivity(v);
                  micRef.current?.setSensitivity(v);
                }}
              />
            </label>
            <div className="meter" aria-hidden>
              <div
                className={`meter-bar ${hitLed !== 0 ? 'hit' : ''}`}
                style={{ width: `${Math.min(100, level * 900)}%` }}
              />
            </div>
          </div>

          {recording && (
            <div className="hint">
              {countingIn
                ? 'count-in…'
                : hitsRef.current.length === 0
                  ? 'Beatbox now — kick, snare, hats. Recording stops itself when you pause.'
                  : `${hitsRef.current.length} hits captured…`}
            </div>
          )}

          <SequencerGrid
            pattern={pattern}
            playhead={playhead}
            flash={flash}
            onToggle={toggleCell}
            onPadHit={(d) => void auditionPad(d)}
          />

          <div className="pattern-controls">
            <label className="ctl slider">
              tempo {pattern.bpm.toFixed(1).replace(/\.0$/, '')} bpm
              <input
                type="range"
                min={60}
                max={180}
                step={0.5}
                value={pattern.bpm}
                onChange={(e) => setBpm(Number(e.target.value))}
              />
            </label>
            <button className="btn subtle" onClick={clearPattern}>
              clear
            </button>
            {classifierRef.current.profile.size > 0 && (
              <span className="profile-note">
                personal profile active · {classifierRef.current.profile.size} examples
              </span>
            )}
          </div>
        </>
      )}

      {tab === 'teach' && (
        <TeachPanel
          counts={profileCounts}
          activeTarget={teachTarget}
          recording={teachTarget !== null}
          onSelectTarget={(d) => void handleTeachTarget(d)}
          onClearProfile={() => {
            void classifierRef.current.profile.clear().then(() => {
              setProfileCounts(classifierRef.current.profile.countsByClass());
            });
          }}
        />
      )}

      <footer>
        all audio stays in your browser · TR-808 samples CC0 · trained on AVP/LVT (CC-BY) &
        beatboxset1
      </footer>
    </div>
  );
}
