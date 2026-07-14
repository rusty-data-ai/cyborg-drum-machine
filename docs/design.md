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
        • posts: 'onset' (immediate) + 'segment' (250 ms PCM, transferred buffer)
  └─► main thread
        • resample segment → 16 kHz, 4000 samples  (lib/resample.ts)
        • ONNX Runtime Web (WASM, SIMD, 1 thread): model(waveform) → logits(5) + emb(64)
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

- **Task**: 5-way classification of 250 ms patches ([−40 ms, +210 ms] around onset):
  `kick, snare, hihat_closed, hihat_open, other`.
- **Input**: 16 kHz mono, 4000 samples. In-graph frontend: conv-STFT (n_fft 512, hop 128,
  Hann) → 64-mel filterbank → log1p. Patch → 64 × 28.
- **Backbone**: 4 conv blocks (8/16/32/64, 3×3, BN, ReLU, 2×2 maxpool) → GAP →
  64-d embedding → two heads: 5-class instrument softmax + auxiliary syllable softmax
  (onset-phoneme × coda from AVP-LVT annotations, where available) weighted ~0.3.
  ≈100k params — a few ms in WASM.
- **Augmentation** (on waveform): gain ±6 dB, pitch ±1.5 semitones, time-stretch 0.8–1.2,
  onset jitter ±10 ms, additive noise (SNR 15–40 dB), random biquad EQ tilt (mic diversity).
- **Split**: hold out entire participants (AVP P25–P28 + 2 beatboxset1 recordings) —
  measures cross-user generalization, the number that matters.
- **Metrics**: held-out-user accuracy + confusion matrix; report per-class recall.
  Literature baseline to beat: ~73% user-agnostic; with-KNN ceiling ~90%.
- **Export**: ONNX opset 17, legacy exporter, fixed shape [1, 4000], outputs
  `logits [1,5]`, `embedding [1,64]` → `web/public/models/beatbox.onnx` + a JSON metadata
  file (class order, model version — the KNN store is invalidated on version change).

## Personalization design (extension 5, built-in)

- Calibration examples → embeddings via the same ONNX session → IndexedDB
  (`{embedding, label, modelVersion, createdAt}`).
- Inference: `score = α·knnProbs + (1−α)·globalSoftmax`, α = min(0.8, nUserExamples/24).
  KNN: cosine similarity, k=5, distance-weighted vote, L2-normalized embeddings.
- Users can review/delete examples; per-class counts shown; "reset profile" button.

## Deployment

Static site (Vite build): any static host (Netlify/Vercel/GitHub Pages). Requirements:
HTTPS (getUserMedia), correct MIME for `.wasm` and `.onnx`, long-cache headers for model +
samples. No server, no COOP/COEP needed (single-threaded WASM, no SharedArrayBuffer).

## Risks / open questions

- Onset detector tuning on real mics (laptop mics + room noise) — sensitivity slider plus
  the noise gate should cover most; needs live testing.
- Free-tempo estimation on sloppy input — metronome mode is the fallback; grid-fit score
  could auto-suggest switching.
- 16 kHz loses sibilance above 8 kHz that separates open/closed hats — if the confusion
  matrix shows it, retrain at 22.05 kHz (frontend is in-graph, so only the resampler and a
  constant change in the app).
