# Cyborg Drum Machine

Beatbox into your mic and get your pattern back as a looping groove on a TR-808-style
step sequencer. All of the machine learning runs **in the browser** — nothing you record
ever leaves the page.

**Live demo:** not yet deployed — static hosting is all it needs (`web/dist/` over
HTTPS); the deployment plan is in [`docs/deployment.md`](docs/deployment.md).

```
mic → AudioWorklet onset detector → 250 ms patch → ONNX classifier (+ your personal
KNN profile) → tempo estimation → 16th-note quantisation → TR-808 step sequencer
```

## What this demonstrates

- **End-to-end ML engineering** — PyTorch training pipeline → ONNX export →
  ONNX Runtime Web inference, with Python↔browser output parity verified to < 1e-3.
- **On-device / privacy-first ML** — inference, personalisation (KNN on model
  embeddings, stored in IndexedDB) and beat sharing (URL fragment) all work with
  no server at all.
- **Real-time audio DSP** — custom AudioWorklet onset detector, resampling, tempo
  estimation and quantisation, all unit-tested.
- **Full-stack TypeScript** — Vite + React app, plus a code-complete Cloudflare
  Worker + D1 backend for opt-in accounts/profile sync (not yet deployed).
- **Honest evaluation** — accuracy reported on held-out users never seen in training,
  benchmarked against the published literature it follows (Delgado et al. 2022).

## Quick start

```bash
# Web app (works without the model — transcription needs it, see below)
cd web
npm install
npm run dev          # http://localhost:5173

# ML pipeline (Linux, needs ~600 MB datasets; a GPU is nice but optional)
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
- **Metronome** — records against a click (count-in of 4); quantisation is then exact.
  Free mode estimates your tempo instead.
- **Teach it your sounds** — record ~8 examples per drum to build a personal profile
  (KNN on model embeddings, stored locally in IndexedDB). Per the literature this is
  worth ~6–17 accuracy points for *your* way of beatboxing. Clap and Tom pads are
  KNN-only: teach them 4+ examples each and they join transcription too.
- **Export / import profile** — your taught examples travel as a JSON file; no server.
- **Share** — copies a link that carries the whole beat in the URL fragment.
- **Sensitivity & tuning** — onset threshold, noise gate, classifier confidence floor,
  profile trust, kit volume (all persisted locally).

## Repository layout

| Path | What |
|---|---|
| `web/` | Vite + React + TS app. `src/lib/` has the audio/ML runtime; `public/onset-processor.js` is the AudioWorklet onset detector. |
| `ml/` | PyTorch training pipeline. In-graph mel frontend (conv-STFT) so the browser feeds raw waveforms — no feature-mismatch class of bugs. |
| `worker/` | Cloudflare Worker + D1: opt-in accounts (Google/GitHub OAuth) + profile sync. Code-complete but not deployed; the sync UI stays hidden until it is. |
| `docs/` | Prior-art survey, dataset licensing, architecture rationale, deployment plan. |

## Model

5-class (kick, snare, closed hat, open hat, other/reject), ~380k params / 1.5 MB ONNX,
trained on AVP + AVP-LVT (CC BY 4.0) and beatboxset1 (CC BY-SA 3.0, training only),
with an auxiliary syllable head per Delgado et al. 2022. Input: raw 22.05 kHz waveform,
350 ms window around the onset; the mel frontend is baked into the graph.

Measured (v2 model, held-out users never seen in training):

| Metric | Value |
|---|---|
| Uncalibrated accuracy, amateur (AVP) test users | 57% |
| **Calibrated** (8 taught examples/class, KNN blend) | **73% mean, 91% best user** |
| Browser inference (Chromium, WASM, single thread) | ~2.3 ms/hit |
| Python↔browser output parity | < 1e-3 |

Uncalibrated cross-user accuracy is known-hard (literature: ~73% on 4-class without
the reject class); the "Teach it your sounds" flow is where the accuracy comes from —
exactly as in the published work this follows.

## Tests

```bash
cd web && npm test        # unit; npx playwright test for e2e
cd worker && npm test     # accounts/sync API — runs in workerd + local D1
```

Web tests cover tempo estimation/quantisation, the resampler, the onset-detector
worklet (synthetic percussive audio in a stubbed worklet scope), the profile-file
codec, and the sync engine. Worker tests exercise auth/session/sync/delete flows
against a fake OAuth provider. CI runs in `.github/workflows/ci.yml`.

## Licences of shipped assets

- TR-808 samples: CC0 ([tidalcycles/sounds-tr808-fischer](https://github.com/tidalcycles/sounds-tr808-fischer))
- Model weights: trained on CC BY 4.0 data — credit *Ramires et al., AVP dataset* and
  *Delgado et al., AVP-LVT* in any public deployment.
