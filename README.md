# Cyborg Drum Machine

Beatbox into your mic → the app transcribes your pattern (which drum, which beat) and
plays it back as a looping groove on an on-screen drum machine. Fully in-browser ML:
nothing you record ever leaves the page.

```
mic → AudioWorklet onset detector → 250 ms patch → ONNX classifier (+ your personal
KNN profile) → tempo estimation → 16th-note quantization → TR-808 step sequencer
```

## Quick start

```bash
# Web app (works without the model — transcription needs it, see below)
cd web
npm install
npm run dev          # http://localhost:5173

# ML pipeline (Linux, needs ~600 MB datasets + a GPU is nice but optional)
python3 -m venv .venv
.venv/bin/pip install -r ml/requirements.txt
bash ml/download_data.sh
.venv/bin/python ml/train.py            # trains, reports held-out-user accuracy
.venv/bin/python ml/eval_knn.py         # simulates per-user calibration accuracy
.venv/bin/python ml/export.py           # → web/public/models/beatbox.onnx
```

## Using the app

- **● REC** — beatbox kick / snare / hi-hats for a bar or two; recording auto-stops when
  you go quiet, then the transcribed loop starts playing. Tap grid cells to fix/edit.
- **metronome** — records against a click (count-in of 4); quantization is then exact.
  Free mode estimates your tempo instead.
- **Teach it your sounds** — record ~8 examples per drum. This builds a personal profile
  (KNN on model embeddings, stored in IndexedDB) that substantially improves accuracy for
  *your* way of beatboxing — per the literature this is worth ~6–17 accuracy points.
- **sensitivity** — onset detector threshold, turn up if quiet hits get missed.

## Repository layout

| Path | What |
|---|---|
| `web/` | Vite + React + TS app. `src/lib/` has the audio/ML runtime; `public/onset-processor.js` is the AudioWorklet onset detector. |
| `ml/` | PyTorch training pipeline. In-graph mel frontend (conv-STFT) so the browser feeds raw waveforms — no feature-mismatch class of bugs. |
| `docs/` | `research.md` (prior-art survey), `data.md` (datasets + licenses), `design.md` (architecture + rationale). |
| `data/` | Downloaded datasets (gitignored; `ml/download_data.sh` restores). |

## Tests

```bash
cd web && npm test
```

Covers tempo estimation/quantization, the resampler, and the onset-detector worklet
driven with synthetic percussive audio in a stubbed worklet scope.

## Model

5-class (kick, snare, closed hat, open hat, other/reject), ~380k params / 1.5 MB ONNX,
trained on AVP + AVP-LVT (CC BY 4.0) and beatboxset1 (CC BY-SA 3.0, training only), with
an auxiliary syllable head (IPA phoneme annotations) per Delgado et al. 2022. Input:
raw 22.05 kHz waveform, 350 ms window around the onset; the mel frontend is baked into
the graph. Two outputs: class logits and a 128-d embedding for the in-browser KNN.

Measured (v2 model, held-out users never seen in training):

| Metric | Value |
|---|---|
| Uncalibrated accuracy, amateur (AVP) test users | 57% |
| **Calibrated** (8 taught examples/class, KNN blend) | **73% mean, 91% best user** |
| Browser inference (Chromium, WASM, single thread) | ~2.3 ms/hit |
| Python↔browser output parity | < 1e-3 |

Uncalibrated cross-user accuracy is known-hard (literature: ~73% on 4-class without the
reject class); the "Teach it your sounds" flow is where the accuracy comes from — exactly
as in the published work this follows.

## Deployment

Static hosting is enough: `cd web && npm run build`, serve `web/dist/` over HTTPS
(getUserMedia requires it). No server-side compute, no special headers required.

## Licenses of shipped assets

- TR-808 samples: CC0 ([tidalcycles/sounds-tr808-fischer](https://github.com/tidalcycles/sounds-tr808-fischer))
- Model weights: trained on CC BY 4.0 data — credit *Ramires et al., AVP dataset* and
  *Delgado et al., AVP-LVT* in any public deployment.
