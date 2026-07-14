# Research: prior art & technical foundations

Survey conducted 2026-07-14. Full agent reports condensed; links inline.

## The problem is well studied

"Vocal percussion transcription" (VPT): detect vocal drum hits (onset detection) and
classify them (kick / snare / closed hat / open hat). Key literature:

- **Stowell & Plumbley 2010**, *Delayed decision-making in real-time beatbox percussion
  classification* ([PDF](https://qmro.qmul.ac.uk/xmlui/handle/123456789/2581)). Foundational.
  Classification accuracy at the onset frame is the *worst* of any delay — the distinguishing
  information arrives after the attack. Single-frame accuracy peaks ~23 ms post-onset (75%);
  stacked frames peak ~58 ms (77.6%). Snare↔kick is the dominant confusion (both start with
  bilabial plosives; they differ in the decay). Listeners tolerate 12–35 ms of trigger delay
  for pop/dance drum sounds.
- **Ramires et al. 2018–2019** — LVT system ([arXiv:1811.02406](https://arxiv.org/abs/1811.02406))
  and the **AVP dataset** ([arXiv:2009.11737](https://arxiv.org/abs/2009.11737)): per-user
  calibration (record a few examples of your own kick/snare/hat, then KNN) was already the
  central idea in 2018.
- **Delgado et al. 2021**, *Learning Models for Query by Vocal Percussion*
  ([arXiv:2110.09223](https://arxiv.org/abs/2110.09223)): per-user 4-class on AVP:
  CNN 82.2%, Random Forest 78.3%.
- **Delgado et al. 2022**, *Deep Embeddings for Robust User-Based Amateur Vocal Percussion
  Classification* ([arXiv:2204.04646](https://arxiv.org/abs/2204.04646),
  [code Apache-2.0](https://github.com/alejandrodl/vocal-percussion-transcription)).
  **The recipe we follow.** Pretrain a small 4-block CNN (8/16/32/64 filters) on 64×48
  log-mel patches over 40 users; use the penultimate layer as an embedding; per-user KNN on a
  handful of calibration examples. Supervising the pretraining with **syllable-level labels**
  (onset phoneme + coda, available in AVP-LVT) beats instrument-level supervision:
  **89.9%** participant-wise vs 84.0%. Plain MFCC+envelope features + user KNN get 84%;
  user-agnostic models drop to ~73%.

### Design implications adopted

1. **Per-user calibration is not an "extension" — it is the accuracy story** (~90% vs ~73%).
   We ship a global model that works out of the box, and a 1-minute "teach it your sounds"
   flow that lifts accuracy via KNN on embeddings.
2. **Never classify at the onset frame.** Our classification window is [−40 ms, +210 ms]
   around the onset.
3. **Loop-based UX sidesteps the latency problem.** Record → transcribe → quantize → play back
   on the grid. Live triggering (with provisional hits) can come later.
4. **3–4 classes is the reliability sweet spot** (also what Dubler 2 reviews report).
   We use AVP's four: kick, snare, closed hat, open hat, plus an **"other"** class trained on
   beatboxset1's breath/misc events so coughs and breaths get rejected.

## Commercial state of the art

- **Vochlea Dubler 2** ($249, desktop): voice→MIDI, up to 8 pads, per-pad training with up to
  12 repetitions, per-pad sensitivity. Reviews: reliable at 3–4 pads. Calibration "under a
  minute". ([product](https://vochlea.com/products/dubler2),
  [SOS review](https://www.soundonsound.com/reviews/vochlea-dubler-2))
- Sonarworks VoiceAI, voicetoinstrument.com: offline render, validates record-then-transcribe.
- **Magenta GrooVAE/Drumify**: taps→expressive groove; possible future "humanize" layer.

## Open source landscape

- [alejandrodl/vocal-percussion-transcription](https://github.com/alejandrodl/vocal-percussion-transcription)
  (Apache-2.0) — research code + trained models for the embeddings paper.
- [Szunias/beatbox-daw](https://github.com/Szunias/beatbox-daw) (MIT, active 2026) — nearest
  open project, but needs a local Python engine; a fully in-browser app is differentiated.
- Avoid: madmom pretrained models (CC BY-NC), essentia.js (AGPL), aubio (GPL),
  unlicensed research repos.

## Browser tech decisions (2026)

- **Capture**: `getUserMedia` with `echoCancellation/noiseSuppression/autoGainControl: false`
  (Chrome defaults them ON — AGC pumps gain between hits, NS eats hi-hats). Verify with
  `track.getSettings()`. Don't fight the hardware sample rate; resample in JS.
- **Onset detection**: hand-written log-compressed spectral flux in an `AudioWorkletProcessor`
  (~150 lines, MIT-clean; libraries are GPL/AGPL). Sparse events via `port.postMessage` with
  transferred `Float32Array` segments — no SharedArrayBuffer, no COOP/COEP requirement.
  Timestamp with `currentFrame` in the worklet, never main-thread receive time.
  Expected acoustic-event→main-thread latency: ~15–30 ms.
- **Inference**: **ONNX Runtime Web, WASM EP, SIMD, `numThreads=1`** (MIT). WebGPU is slower
  than WASM for <1M-param models (dispatch overhead). Expected ~1–5 ms per hit.
  Vite gotcha: copy `onnxruntime-web`'s `.wasm` to the bundle and set `ort.env.wasm.wasmPaths`.
- **Features**: **bake the mel-spectrogram into the ONNX graph**
  ([adobe-research/convmelspec](https://github.com/adobe-research/convmelspec), Apache-2.0,
  conv-based STFT in "store" mode) and feed raw 16 kHz waveform patches. Eliminates the
  train/inference feature-mismatch bug class entirely.
- **Personalization**: model exports two outputs (logits + embedding); browser KNN is a
  hand-rolled cosine top-k over Float32Arrays; store raw embeddings + labels + model-version
  in IndexedDB (re-embeddable if the model changes). Blend `α·knn + (1−α)·softmax`.
- **Tempo/quantization**: roll our own on onset times (circular-statistics / IOI approach);
  offer a metronome mode where quantization is trivial.
