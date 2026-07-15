import { useCallback, useEffect, useRef, useState } from 'react';
import './App.css';
import { SequencerGrid } from './components/SequencerGrid';
import { SettingsPanel } from './components/SettingsPanel';
import { TeachPanel, type TeachFeedback } from './components/TeachPanel';
import { HitClassifier } from './lib/classifier';
import { DrumKit } from './lib/drumSynth';
import type { UserExample } from './lib/knn';
import { startMetronome, type MetronomeHandle } from './lib/metronome';
import { MicEngine, type SegmentEvent } from './lib/micEngine';
import { quantizeHits } from './lib/quantize';
import { Sequencer } from './lib/sequencer';
import { patternFromHash, patternToShareUrl } from './lib/share';
import {
  loadSettings,
  saveSettings,
  toWorkletConfig,
  type AppSettings,
} from './lib/settings';
import type { ClassifiedHit, DrumClass, Pattern } from './lib/types';
import { DRUM_CLASSES, emptyPattern } from './lib/types';

const MAX_RECORD_S = 20;
const SILENCE_STOP_S = 2.4;

// A shared beat arrives in the URL fragment — decoded locally, never sent anywhere.
const sharedPattern = patternFromHash(window.location.hash);

type Tab = 'play' | 'teach';

export default function App() {
  const [modelReady, setModelReady] = useState(false);
  const [modelError, setModelError] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [pattern, setPattern] = useState<Pattern>(sharedPattern ?? emptyPattern());
  const [hasPattern, setHasPattern] = useState(sharedPattern !== null);
  const [shareCopied, setShareCopied] = useState(false);
  const [playhead, setPlayhead] = useState(-1);
  const [level, setLevel] = useState(0);
  const [settings, setSettings] = useState<AppSettings>(() => loadSettings());
  const [showSettings, setShowSettings] = useState(false);
  const [metroMode, setMetroMode] = useState(false);
  const [metroBpm, setMetroBpm] = useState(95);
  const [flash, setFlash] = useState<Partial<Record<DrumClass, number>>>({});
  const [hitLed, setHitLed] = useState(0);
  const [tab, setTab] = useState<Tab>('play');
  const [teachTarget, setTeachTarget] = useState<DrumClass | null>(null);
  const [testTarget, setTestTarget] = useState<DrumClass | null>(null);
  const [examples, setExamples] = useState<readonly UserExample[]>([]);
  const [feedback, setFeedback] = useState<TeachFeedback | null>(null);
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
  const testTargetRef = useRef<DrumClass | null>(null);
  const recordingRef = useRef(false);
  const patternRef = useRef(pattern);
  const settingsRef = useRef(settings);

  tabRef.current = tab;
  teachTargetRef.current = teachTarget;
  testTargetRef.current = testTarget;
  recordingRef.current = recording;
  patternRef.current = pattern;
  settingsRef.current = settings;

  // Persist + apply settings wherever they land (classifier, kit, live worklet).
  useEffect(() => {
    saveSettings(settings);
    const clf = classifierRef.current;
    clf.confidenceFloor = settings.confidenceFloor;
    clf.profileWeight = settings.profileWeight;
    kitRef.current?.setVolume(settings.kitVolume);
    micRef.current?.configure(toWorkletConfig(settings));
  }, [settings]);

  const updateSettings = useCallback((patch: Partial<AppSettings>) => {
    setSettings((s) => ({ ...s, ...patch }));
  }, []);

  const refreshProfile = useCallback(() => {
    setProfileCounts(classifierRef.current.profile.countsByClass());
    setExamples([...classifierRef.current.profile.list()]);
  }, []);

  // Load the classifier once (pure WASM, no user gesture needed).
  useEffect(() => {
    classifierRef.current
      .load()
      .then(() => {
        refreshProfile();
        setModelReady(true);
      })
      .catch((err) => {
        console.error('model load failed', err);
        setModelError(
          'Classifier model not found — the drum machine still works, but beatbox transcription is disabled.',
        );
      });
  }, [refreshProfile]);

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
      const testing = testTargetRef.current !== null;
      const target = testing ? testTargetRef.current : teachTargetRef.current;
      if (!target) return;
      const patch = classifier.preparePatch(seg.pcm, seg.sampleRate);
      const { probs, embedding } = await classifier.infer(patch);
      // Live feedback: what the *current* blended classifier calls this sound
      // (decided before storing, so a taught example doesn't vote for itself).
      const call = classifier.decide(probs, embedding);
      if (!testing) {
        await classifier.profile.add(target, embedding, classifier.modelVersion);
        refreshProfile();
      }
      setFeedback({
        target,
        predicted: call?.drum ?? null,
        confidence: call?.confidence ?? 0,
        stored: !testing,
      });
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
  }, [refreshProfile]);

  const ensureAudio = useCallback(async () => {
    if (!ctxRef.current) {
      const ctx = new AudioContext({ latencyHint: 'interactive' });
      ctxRef.current = ctx;
      const kit = new DrumKit(ctx);
      kit.setVolume(settingsRef.current.kitVolume);
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
    await micRef.current!.start(toWorkletConfig(settingsRef.current));
    setMicWarning(micRef.current!.processingWarning);
    recordStartRef.current = ctx.currentTime;
    lastActivityRef.current = ctx.currentTime;
    setRecording(true);
  }, [ensureAudio, metroMode, metroBpm, stopPlayback]);

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

  const armTeachMic = useCallback(
    async (on: boolean) => {
      if (on) {
        await ensureAudio();
        if (!micRef.current!.running) {
          await micRef.current!.start(toWorkletConfig(settingsRef.current));
          setMicWarning(micRef.current!.processingWarning);
        }
      } else if (!recordingRef.current) {
        micRef.current?.stop();
      }
    },
    [ensureAudio],
  );

  const handleTeachTarget = useCallback(
    async (drum: DrumClass | null) => {
      setTeachTarget(drum);
      setTestTarget(null);
      setFeedback(null);
      await armTeachMic(drum !== null);
    },
    [armTeachMic],
  );

  const handleTestTarget = useCallback(
    async (drum: DrumClass | null) => {
      setTestTarget(drum);
      setTeachTarget(null);
      setFeedback(null);
      await armTeachMic(drum !== null);
    },
    [armTeachMic],
  );

  const undoLastExample = useCallback(() => {
    const list = classifierRef.current.profile.list();
    if (list.length === 0) return;
    void classifierRef.current.profile.remove(list[list.length - 1].id).then(refreshProfile);
  }, [refreshProfile]);

  const switchTab = (t: Tab) => {
    if (recording) stopRecording();
    if (teachTarget) void handleTeachTarget(null);
    if (testTarget) void handleTestTarget(null);
    setTab(t);
  };

  const sharePattern = useCallback(async () => {
    const url = patternToShareUrl(patternRef.current, `${location.origin}${location.pathname}`);
    // Put the link in the URL bar too, so it's shareable even if the clipboard is blocked.
    history.replaceState(null, '', url);
    try {
      await navigator.clipboard.writeText(url);
      setShareCopied(true);
      window.setTimeout(() => setShareCopied(false), 1600);
    } catch {
      // clipboard denied — the URL bar still holds the link
    }
  }, []);

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
                value={settings.sensitivity}
                onChange={(e) => updateSettings({ sensitivity: Number(e.target.value) })}
              />
            </label>
            <div className="meter" aria-hidden>
              <div
                className={`meter-bar ${hitLed !== 0 ? 'hit' : ''}`}
                style={{ width: `${Math.min(100, level * 900)}%` }}
              />
            </div>
            <button
              className={`btn subtle gear ${showSettings ? 'active' : ''}`}
              aria-label="settings"
              title="Settings"
              onClick={() => setShowSettings((s) => !s)}
            >
              ⚙
            </button>
          </div>

          {showSettings && <SettingsPanel settings={settings} onChange={updateSettings} />}

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
            <button
              className="btn subtle"
              onClick={() => void sharePattern()}
              disabled={!hasPattern}
              title="Copy a link that plays this beat"
            >
              {shareCopied ? 'copied ✓' : 'share'}
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
          examples={examples}
          activeTarget={teachTarget}
          testTarget={testTarget}
          feedback={feedback}
          onSelectTarget={(d) => void handleTeachTarget(d)}
          onSelectTest={(d) => void handleTestTarget(d)}
          onDeleteExample={(id) => {
            void classifierRef.current.profile.remove(id).then(refreshProfile);
          }}
          onUndoLast={undoLastExample}
          onClearProfile={() => {
            void classifierRef.current.profile.clear().then(refreshProfile);
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
