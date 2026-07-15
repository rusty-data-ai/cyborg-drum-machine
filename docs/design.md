# Design: AI Beatbox → Drum Machine

A web app: beatbox into the mic, the pipeline transcribes your pattern
(onset detection → per-hit classification → tempo inference → quantization) and plays it
back as a looping step-sequencer groove on an on-screen drum machine. Rationale for every
major decision is in `docs/research.md`.

## UX flow

```
┌───────────────────────────────────────────────────────────┐
│  ● REC        [free tempo ▾ | metronome 90bpm]   sens ──○ │
│                                                           │
│   KICK   ░░▓░ ░░░░ ░▓░░ ░░░░   ┐                          │
│   SNARE  ░░░░ ▓░░░ ░░░░ ▓░░░   │ 16-step grid, 1–4 bars   │
│   CH     ▓░▓░ ▓░▓░ ▓░▓░ ▓░▓░   │ tap cells to edit        │
│   OH     ░░░░ ░░▓░ ░░░░ ░░▓░   ┘                          │
│                                                           │
│   ▶ PLAY   BPM 96 ──○──   [clear] [teach it your sounds]  │
└───────────────────────────────────────────────────────────┘
```

1. Hit **record**, beatbox 1–4 bars, hit stop (or auto-stop on 2 s silence).
2. While recording: pads flash on each detected onset (immediate feedback), classified
   hits light the corresponding pad ~250 ms later.
3. On stop: tempo estimated, hits quantized to a 16th grid, pattern starts looping on a
   TR-808 kit. The user can toggle/edit any cell — the model being ~90% right is fine when
   fixing a miss is one tap.
4. **Calibration ("teach it your sounds")**: guided flow records ~8 examples per drum;
   embeddings + labels go to IndexedDB; a KNN over them personalizes classification.
   Research says this is worth +6–17 accuracy points — surfaced prominently, not buried.

Two recording modes:
- **Free tempo** (default, more magical): tempo estimated from the onsets.
- **Metronome**: count-in + click at chosen BPM; quantization is exact.

## Architecture

```
mic ──getUserMedia (EC/NS/AGC off, mono)
  └─► AudioWorklet "onset-processor" (audio thread, plain JS)
        • 512-pt FFT each 256-sample hop, log-compressed spectral flux
        • adaptive threshold (mean + k·std), local-max peak pick, 60 ms refractory
        • RMS noise gate; sensitivity control from UI
        • posts: 'onset' (immediate) + 'segment' (350 ms PCM, transferred buffer)
  └─► main thread
        • resample segment → 22.05 kHz, 7712 samples (350 ms)  (lib/resample.ts)
        • ONNX Runtime Web (WASM, SIMD, 1 thread): model(waveform) → logits(5) + emb(128)
        • personalization: cosine KNN over user examples, blended with softmax
        • 'other' class or low confidence → hit rejected
        • hits accumulate → on stop: tempo estimate + quantize (lib/quantize.ts)
        • Pattern → Sequencer (lookahead scheduler) → DrumKit (samples w/ synth fallback)
```

### Why these choices

- **Loop-record UX, not live triggering**: classification needs ~25–200 ms of post-onset
  audio to be accurate; a looping groove hides all of it. (Live mode with provisional
  sounds is a possible v2.)
- **Raw waveform into the ONNX model**: the mel frontend (conv-based STFT, 64 mels) is baked
  into the exported graph, so training-time and browser features are bit-identical.
- **Two-output model** (class logits + embedding) makes personalization a pure-JS KNN with
  no retraining in the browser.
- **Everything user-generated stays client-side**: mic audio and calibration embeddings never
  leave the browser. Deployment is static hosting.

## ML pipeline (`ml/`)

- **Task**: 5-way classification of 350 ms patches ([−40 ms, +310 ms] around onset):
  `kick, snare, hihat_closed, hihat_open, other`. (350 ms: open-hat decay tails carry the
  open/closed distinction; the literature uses ~384 ms.)
- **Input**: 22.05 kHz mono, 7712 samples (sibilance above 8 kHz separates the hats).
  In-graph frontend: conv-STFT (n_fft 512, hop 128, Hann) → 64-mel filterbank → log1p.
- **Backbone**: 4 conv blocks (16/32/64/128, 3×3, BN, ReLU, 2×2 maxpool) → GAP →
  128-d embedding → two heads: 5-class instrument softmax + auxiliary syllable softmax
  (onset-phoneme × coda from AVP-LVT annotations, where available) weighted 0.3.
  ~380k params incl. frontend buffers → 1.5 MB ONNX, ~2.3 ms in WASM.
- **Augmentation** (on waveform): gain ±6 dB, random speed 0.93–1.08 (kept narrow — wider
  stretch blurs the open/closed-hat decay boundary), onset jitter ±10 ms, additive noise
  (SNR 20–45 dB), first-order spectral tilt (mic diversity), SpecAugment (1 mask).
- **Split**: hold out entire participants (AVP P3/P10/P17/P26 + 2 beatboxset1 recordings)
  — measures cross-user generalization, the number that matters. Val: P5/P14/P22 + 1 bbx.
- **Measured (model v2)**: 57% uncalibrated on held-out AVP users; 73% mean / 91% best
  with 8 calibration examples per class (ml/eval_knn.py). beatboxset1 experts score much
  lower uncalibrated (their kicks land in 'other') — calibration is the answer there too.
- **Export**: ONNX opset 17, legacy exporter, fixed shape [1, 7712], outputs
  `logits [1,5]`, `embedding [1,128]` → `web/public/models/beatbox.onnx` + a JSON metadata
  file (class order, model version — the KNN store is invalidated on version change);
  parity vs PyTorch asserted at export and again in-browser (e2e/parity.spec.ts).

## Personalization design (extension 5, built-in)

- Calibration examples → embeddings via the same ONNX session → IndexedDB
  (`{embedding, label, modelVersion, createdAt}`).
- Inference: `score = α·knnProbs + (1−α)·globalSoftmax`, α = min(profileWeight,
  nUserExamples/24), profileWeight default 0.85 (user-tunable). KNN: cosine similarity,
  k=5, distance-weighted vote, L2-normalized embeddings. Blend logic is pure
  (`web/src/lib/blend.ts`) and unit-tested.
- Users review/delete individual examples (chips), undo last, reset profile; a
  "test me" mode classifies live without storing; teach captures show what the current
  classifier would have called the sound (decided *before* storing, so an example never
  votes for itself).
- **KNN-only pads (clap, tom)**: pad classes are a superset of model classes. Classes the
  global model never saw get zero global mass and are excluded from KNN voting until the
  user teaches ≥4 examples — an untaught pad can never win. This makes new vocabulary a
  pure teach-flow feature, no retraining.

## Tuning settings (gear panel, persisted in localStorage)

Onset sensitivity, min inter-onset gap (worklet), noise gate (worklet), classifier
confidence floor, profile trust (α cap), kit volume. Defaults equal the original
constants; `web/src/lib/settings.ts` clamps and survives junk in storage.

## Deployment

Static site (Vite build): any static host works; Cloudflare Pages is the chosen one —
see `docs/deployment.md` for the provider comparison, caching/model-versioning strategy,
and runbook. Requirements: HTTPS (getUserMedia), correct MIME for `.wasm` and `.onnx`,
long-cache headers for model + samples. No server, no COOP/COEP needed (single-threaded
WASM, no SharedArrayBuffer). Beat sharing is zero-backend: the pattern is a versioned
binary in the URL fragment (`web/src/lib/share.ts`).

## Risks / open questions

- Onset detector tuning on real mics (laptop mics + room noise) — sensitivity slider plus
  the noise gate should cover most; needs live testing.
- Free-tempo estimation on sloppy input — metronome mode is the fallback; grid-fit score
  could auto-suggest switching.
- Open/closed hat confusion remains the weakest uncalibrated pair even at 22.05 kHz /
  350 ms (amateur imitations genuinely overlap); the teach flow is the practical fix.
