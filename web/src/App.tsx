import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import './App.css';
import { AccountPanel } from './components/AccountPanel';
import { CyborgDrummer, type DrummerHandle } from './components/CyborgDrummer';
import { MidiControls } from './components/MidiControls';
import { ReviewStrip, type ReviewChoice } from './components/ReviewStrip';
import { SequencerGrid } from './components/SequencerGrid';
import { SettingsPanel } from './components/SettingsPanel';
import { TeachPanel, type TeachFeedback } from './components/TeachPanel';
import { HitClassifier } from './lib/classifier';
import { DrumKit } from './lib/drumSynth';
import { audioToPerfTime, clockMapping } from './lib/audioTime';
import type { UserExample } from './lib/knn';
import { encodePatternToSmf, smfFilename } from './lib/midiFile';
import { loadMidiPrefs, MidiOut, saveMidiPrefs, type MidiDeviceInfo } from './lib/midiOut';
import { startMetronome, type MetronomeHandle } from './lib/metronome';
import { MicEngine, type SegmentEvent } from './lib/micEngine';
import { evalProgress, evaluateProfile } from './lib/profileEval';
import {
  encodeProfileFile,
  parseProfileFile,
  planMerge,
  profileFilename,
} from './lib/profileFile';
import { quantizeHits, type HitPlacement } from './lib/quantize';
import { Sequencer } from './lib/sequencer';
import { patternFromHash, patternToShareUrl } from './lib/share';
import {
  loadSettings,
  saveSettings,
  toWorkletConfig,
  type AppSettings,
} from './lib/settings';
import { SyncApi, type SyncUser } from './lib/syncApi';
import { syncApiBase } from './lib/syncConfig';
import { loadTombstones, SyncEngine, type SyncStatus } from './lib/syncEngine';
import type { ClassifiedHit, DrumClass, Pattern } from './lib/types';
import { DRUM_CLASSES, DRUM_LABELS, emptyPattern } from './lib/types';

const MAX_RECORD_S = 20;
const SILENCE_STOP_S = 2.4;

// A shared beat arrives in the URL fragment — decoded locally, never sent anywhere.
const sharedPattern = patternFromHash(window.location.hash);

type Tab = 'play' | 'teach';

// Accounts/sync (plan Phase 1) is present only when a worker URL is configured
// at build time; otherwise the app is the zero-backend product, unchanged.
const SYNC_BASE = syncApiBase();
const SYNC_ENABLED_KEY = 'beatbox-sync-enabled';
const migratedKey = (userId: string) => `beatbox-sync-migrated:${userId}`;

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
  const [midiOn, setMidiOn] = useState(false);
  const [midiDevices, setMidiDevices] = useState<MidiDeviceInfo[]>([]);
  const [midiDeviceId, setMidiDeviceId] = useState<string | null>(null);
  const [midiNote, setMidiNote] = useState<string | null>(null);
  const [showDrummer, setShowDrummer] = useState(true);
  const [transferNote, setTransferNote] = useState<string | null>(null);
  const [account, setAccount] = useState<SyncUser | null>(null);
  const [syncOn, setSyncOn] = useState(
    () => typeof localStorage !== 'undefined' && localStorage.getItem(SYNC_ENABLED_KEY) === '1',
  );
  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null);
  const [migrationNeeded, setMigrationNeeded] = useState(false);
  const [review, setReview] = useState<{
    hits: ClassifiedHit[];
    placements: HitPlacement[];
  } | null>(null);
  const [corrections, setCorrections] = useState<Record<number, ReviewChoice>>({});
  const [reviewNote, setReviewNote] = useState<string | null>(null);

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
  const midiRef = useRef<MidiOut | null>(null);
  const midiOnRef = useRef(false);
  const drummerRef = useRef<DrummerHandle | null>(null);

  tabRef.current = tab;
  teachTargetRef.current = teachTarget;
  testTargetRef.current = testTarget;
  recordingRef.current = recording;
  patternRef.current = pattern;
  settingsRef.current = settings;
  midiOnRef.current = midiOn;

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

  // Leave-one-out improvement stat — recomputes on every add/delete/undo/reset
  // (refreshProfile is the single funnel that updates `examples`).
  const evaluation = useMemo(
    () => evaluateProfile(examples, settings.profileWeight),
    [examples, settings.profileWeight],
  );
  const progress = useMemo(() => evalProgress(examples), [examples]);

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

  // ---- MIDI output ----

  const syncMidiDevices = useCallback((preferId?: string | null) => {
    const midi = midiRef.current;
    if (!midi) return;
    const devices = midi.outputs();
    setMidiDevices(devices);
    // Keep the selection when still present; otherwise fall back to the first device.
    const want = preferId !== undefined ? preferId : midi.selectedId;
    const pick = devices.find((d) => d.id === want)?.id ?? devices[0]?.id ?? null;
    const lost = midi.selectedId !== null && !devices.some((d) => d.id === midi.selectedId);
    midi.select(pick);
    setMidiDeviceId(pick);
    setMidiNote(
      devices.length === 0
        ? 'no MIDI outputs — plug in a device or start a synth'
        : lost
          ? 'MIDI device disconnected — switched output'
          : null,
    );
  }, []);

  const enableMidi = useCallback(
    async (preferId: string | null) => {
      const midi = midiRef.current ?? new MidiOut(() => ctxRef.current);
      midiRef.current = midi;
      midi.onDevicesChanged = () => syncMidiDevices();
      try {
        await midi.enable(); // permission prompt happens here, on user enable only
        setMidiOn(true);
        syncMidiDevices(preferId);
      } catch {
        setMidiOn(false);
        setMidiNote('MIDI access was denied');
      }
    },
    [syncMidiDevices],
  );

  const handleMidiToggle = useCallback(
    (on: boolean) => {
      if (on) {
        void enableMidi(loadMidiPrefs().deviceId);
        saveMidiPrefs({ enabled: true, deviceId: loadMidiPrefs().deviceId });
      } else {
        midiRef.current?.allNotesOff();
        midiRef.current?.select(null);
        setMidiOn(false);
        setMidiNote(null);
        saveMidiPrefs({ enabled: false, deviceId: midiDeviceId });
      }
    },
    [enableMidi, midiDeviceId],
  );

  const handleMidiSelect = useCallback((id: string | null) => {
    midiRef.current?.select(id);
    setMidiDeviceId(id);
    saveMidiPrefs({ enabled: true, deviceId: id });
  }, []);

  // Restore persisted MIDI state (user enabled it previously — no cold prompt otherwise).
  useEffect(() => {
    const prefs = loadMidiPrefs();
    if (prefs.enabled && MidiOut.supported) void enableMidi(prefs.deviceId);
  }, [enableMidi]);

  useEffect(() => {
    if (midiOn) saveMidiPrefs({ enabled: true, deviceId: midiDeviceId });
  }, [midiOn, midiDeviceId]);

  const exportMid = useCallback(() => {
    const bytes = encodePatternToSmf(patternRef.current);
    const blob = new Blob([bytes.buffer as ArrayBuffer], { type: 'audio/midi' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = smfFilename(patternRef.current);
    a.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 5000);
  }, []);

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
        await classifier.profile.add(target, embedding, classifier.modelVersion, probs);
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
      // Schedule-time fan-out: exact AudioContext times, ahead of the beat.
      seq.onTrigger = (drum, vel, time) => {
        const stepMs = (60 / patternRef.current.bpm / 4) * 1000;
        if (drummerRef.current) {
          drummerRef.current.strike(drum, vel, audioToPerfTime(time, clockMapping(ctx)), stepMs);
        }
        if (midiOnRef.current && midiRef.current) {
          midiRef.current.noteAt(drum, vel, time, stepMs / 2);
        }
      };
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
    midiRef.current?.allNotesOff();
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
      const { pattern: pat, placements } = quantizeHits(
        hits,
        recordEpochRef.current !== null
          ? { knownBpm: metroBpm, origin: recordEpochRef.current }
          : {},
      );
      setPattern(pat);
      setHasPattern(true);
      setReview({ hits: [...hits], placements });
      setCorrections({});
      setReviewNote(null);
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

  // ---- Accounts + sync (accounts plan Phase 1, opt-in) ----

  const syncApi = useMemo(() => (SYNC_BASE ? new SyncApi(SYNC_BASE) : null), []);
  const syncEngine = useMemo(() => {
    if (!syncApi) return null;
    return new SyncEngine({
      api: syncApi,
      modelVersion: () => classifierRef.current.modelVersion,
      listLocal: () => classifierRef.current.profile.list(),
      importLocal: async (examples, modelVersion) => {
        await classifierRef.current.profile.importExamples(examples, modelVersion);
        refreshProfile();
      },
      removeLocalByUuids: async (uuids) => {
        await classifierRef.current.profile.removeByUuids(uuids);
        refreshProfile();
      },
      onStatus: setSyncStatus,
    });
  }, [syncApi, refreshProfile]);
  const pulledRef = useRef(false);

  // Who am I? (Session cookie survives the OAuth redirect and reloads.)
  useEffect(() => {
    if (!syncApi) return;
    void syncApi.me().then(setAccount);
  }, [syncApi]);

  // First sign-in on a device with local data: prompt merge/replace (plan §5).
  // Otherwise: pull once per page load when sync is on (plan §3 cadence).
  useEffect(() => {
    if (!syncEngine || !account || !modelReady) return;
    if (localStorage.getItem(migratedKey(account.id)) !== '1') {
      if (classifierRef.current.profile.size > 0) {
        setMigrationNeeded(true);
        return;
      }
      localStorage.setItem(migratedKey(account.id), '1');
    }
    setMigrationNeeded(false);
    if (syncOn && !pulledRef.current) {
      pulledRef.current = true;
      void syncEngine.pullOnce();
    }
  }, [syncEngine, account, modelReady, syncOn]);

  // Push on change, debounced ~10 s. Idempotent server-side (union by uuid).
  const syncActive = account !== null && syncOn && !migrationNeeded;
  useEffect(() => {
    if (!syncEngine || !syncActive || !modelReady) return;
    if (examples.length === 0 && loadTombstones().length === 0) return;
    syncEngine.schedulePush();
  }, [examples, syncEngine, syncActive, modelReady]);

  const handleToggleSync = useCallback(
    (on: boolean) => {
      localStorage.setItem(SYNC_ENABLED_KEY, on ? '1' : '0');
      setSyncOn(on);
      if (on && syncEngine && account && !migrationNeeded) {
        pulledRef.current = true;
        void syncEngine.pullOnce();
      }
    },
    [syncEngine, account, migrationNeeded],
  );

  const handleMigrate = useCallback(
    async (mode: 'merge' | 'replace') => {
      if (!syncEngine || !account) return;
      if (mode === 'replace') {
        if (!confirm("Replace this device's taught examples with your account's profile?")) {
          return;
        }
        // Deliberately no tombstones: this discards local copies, it doesn't
        // delete anything from the account.
        await classifierRef.current.profile.clear();
        refreshProfile();
      }
      localStorage.setItem(migratedKey(account.id), '1');
      setMigrationNeeded(false);
      localStorage.setItem(SYNC_ENABLED_KEY, '1');
      setSyncOn(true);
      pulledRef.current = true;
      if (mode === 'merge') await syncEngine.pushNow();
      await syncEngine.pullOnce();
    },
    [syncEngine, account, refreshProfile],
  );

  const handleSignOut = useCallback(async () => {
    if (!syncApi) return;
    await syncApi.signOut();
    // Local data stays — it's the user's device and the app keeps working (§5).
    setAccount(null);
    setSyncStatus(null);
  }, [syncApi]);

  const handleDeleteAccount = useCallback(async () => {
    if (!syncApi || !account) return;
    if (
      !confirm(
        'Delete your account and everything stored on the server (examples, settings, beats)? ' +
          'Examples taught on this device stay on this device.',
      )
    ) {
      return;
    }
    const ok = await syncApi.deleteAccount();
    if (ok) {
      localStorage.removeItem(migratedKey(account.id));
      localStorage.setItem(SYNC_ENABLED_KEY, '0');
      setSyncOn(false);
      setAccount(null);
      setSyncStatus(null);
    } else {
      setSyncStatus({ state: 'error', detail: 'account deletion failed' });
    }
  }, [syncApi, account]);

  // ---- Profile backup (accounts plan Phase 0): export/import as a file ----

  const exportProfile = useCallback(() => {
    const clf = classifierRef.current;
    const json = encodeProfileFile(clf.modelVersion, clf.profile.list(), settingsRef.current);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = profileFilename();
    a.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 5000);
    setTransferNote(`exported ${clf.profile.size} example${clf.profile.size === 1 ? '' : 's'}`);
  }, []);

  const importProfile = useCallback(
    async (file: File) => {
      const clf = classifierRef.current;
      const parsed = parseProfileFile(await file.text());
      if ('error' in parsed) {
        setTransferNote(`import failed: ${parsed.error}`);
        return;
      }
      if (!clf.ready) {
        setTransferNote('import failed: classifier model not loaded');
        return;
      }
      if (parsed.file.modelVersion !== clf.modelVersion) {
        setTransferNote(
          `import failed: that file is from model ${parsed.file.modelVersion}; this app runs ` +
            `${clf.modelVersion} — examples don't transfer across model versions`,
        );
        return;
      }
      const plan = planMerge(clf.profile.list(), parsed.file.examples);
      await clf.profile.importExamples(plan.toAdd, clf.modelVersion);
      refreshProfile();
      if (parsed.file.settings) setSettings(parsed.file.settings);
      setTransferNote(
        `imported ${plan.toAdd.length} example${plan.toAdd.length === 1 ? '' : 's'}` +
          (plan.duplicates > 0 ? ` · skipped ${plan.duplicates} duplicate${plan.duplicates === 1 ? '' : 's'}` : '') +
          (parsed.file.settings ? ' · settings applied' : ''),
      );
    },
    [refreshProfile],
  );

  const undoLastExample = useCallback(() => {
    const list = classifierRef.current.profile.list();
    if (list.length === 0) return;
    const last = list[list.length - 1];
    if (last.uuid) syncEngine?.recordTombstones([last.uuid]);
    void classifierRef.current.profile.remove(last.id).then(refreshProfile);
  }, [refreshProfile, syncEngine]);

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
    setReview(null);
    setReviewNote(null);
  };

  // Review-strip correction: fix the grid cell and (for real drums) teach the
  // profile from the hit's stored embedding + global softmax.
  const applyCorrection = (hitIndex: number, choice: ReviewChoice) => {
    if (!review) return;
    const placement = review.placements.find((p) => p.hitIndex === hitIndex);
    const hit = review.hits[hitIndex];
    if (!placement || !hit) return;

    const currentOf = (idx: number): DrumClass | null => {
      const c = corrections[idx];
      if (c === undefined) {
        return review.placements.find((p) => p.hitIndex === idx)?.drum ?? null;
      }
      return c === 'not_drum' ? null : c;
    };
    const current = currentOf(hitIndex);
    const chosen: DrumClass | null = choice === 'not_drum' ? null : choice;

    if (chosen === current) {
      // Confirmations are acknowledged but never stored (no self-training).
      setReviewNote(
        chosen ? `confirmed ${DRUM_LABELS[chosen]} ✓ — confirmations aren't stored` : 'already ignored',
      );
      return;
    }

    setPattern((p) => {
      const next: Pattern = { ...p, grid: { ...p.grid } };
      const step = placement.step;
      if (current) {
        // Clear the old cell only if no other (surviving) hit occupies it.
        const occupied = review.placements.some(
          (pl) => pl.hitIndex !== hitIndex && pl.step === step && currentOf(pl.hitIndex) === current,
        );
        if (!occupied) {
          next.grid[current] = [...next.grid[current]];
          next.grid[current][step] = 0;
        }
      }
      if (chosen) {
        next.grid[chosen] = [...next.grid[chosen]];
        next.grid[chosen][step] = Math.max(next.grid[chosen][step], placement.velocity);
      }
      seqRef.current?.setPattern(next);
      return next;
    });
    setCorrections((c) => ({ ...c, [hitIndex]: choice }));

    if (chosen && hit.embedding) {
      void classifierRef.current.profile
        .add(chosen, hit.embedding, classifierRef.current.modelVersion, hit.rawProbs)
        .then(refreshProfile);
      setReviewNote(`learned: that was a ${DRUM_LABELS[chosen]}`);
    } else if (!chosen) {
      setReviewNote('removed — nothing stored (no "not a drum" bucket in your profile)');
    } else {
      setReviewNote('cell moved (this hit carried no embedding to learn from)');
    }
  };

  // Let the review confirmation line fade away on its own.
  useEffect(() => {
    if (!reviewNote) return;
    const t = window.setTimeout(() => setReviewNote(null), 3000);
    return () => clearTimeout(t);
  }, [reviewNote]);

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

          {showDrummer ? (
            <div className="drummer-panel">
              <button
                className="btn subtle drummer-hide"
                onClick={() => setShowDrummer(false)}
                title="Hide the cyborg drummer"
              >
                hide
              </button>
              <CyborgDrummer ref={drummerRef} playing={playing} bpm={pattern.bpm} />
            </div>
          ) : (
            <button className="btn subtle" onClick={() => setShowDrummer(true)}>
              show drummer
            </button>
          )}

          <SequencerGrid
            pattern={pattern}
            playhead={playhead}
            flash={flash}
            onToggle={toggleCell}
            onPadHit={(d) => void auditionPad(d)}
          />

          {review && (
            <ReviewStrip
              hits={review.hits}
              placements={review.placements}
              corrections={corrections}
              note={reviewNote}
              onChoose={applyCorrection}
            />
          )}

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
            <MidiControls
              supported={MidiOut.supported}
              enabled={midiOn}
              devices={midiDevices}
              selectedId={midiDeviceId}
              note={midiNote}
              hasPattern={hasPattern}
              onToggle={handleMidiToggle}
              onSelect={handleMidiSelect}
              onExport={exportMid}
            />
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
          evaluation={evaluation}
          evalProgress={progress}
          activeTarget={teachTarget}
          testTarget={testTarget}
          feedback={feedback}
          onSelectTarget={(d) => void handleTeachTarget(d)}
          onSelectTest={(d) => void handleTestTarget(d)}
          onDeleteExample={(id) => {
            const ex = classifierRef.current.profile.list().find((e) => e.id === id);
            if (ex?.uuid) syncEngine?.recordTombstones([ex.uuid]);
            void classifierRef.current.profile.remove(id).then(refreshProfile);
          }}
          onUndoLast={undoLastExample}
          onClearProfile={() => {
            const uuids = classifierRef.current.profile
              .list()
              .map((e) => e.uuid)
              .filter((u): u is string => !!u);
            if (uuids.length > 0) syncEngine?.recordTombstones(uuids);
            void classifierRef.current.profile.clear().then(refreshProfile);
          }}
          onExportProfile={exportProfile}
          onImportProfile={(f) => void importProfile(f)}
          transferNote={transferNote}
          accountSlot={
            syncApi ? (
              <AccountPanel
                user={account}
                syncOn={syncOn}
                status={syncStatus}
                migrationNeeded={migrationNeeded}
                localCount={examples.length}
                signInUrl={(p) => syncApi.signInUrl(p)}
                exportUrl={syncApi.exportUrl()}
                onToggleSync={handleToggleSync}
                onMigrate={(m) => void handleMigrate(m)}
                onSignOut={() => void handleSignOut()}
                onDeleteAccount={() => void handleDeleteAccount()}
              />
            ) : undefined
          }
        />
      )}

      <footer>
        all audio stays in your browser · TR-808 samples CC0 · trained on AVP/LVT (CC-BY) &
        beatboxset1
      </footer>
    </div>
  );
}
