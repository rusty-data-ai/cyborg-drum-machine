# Data sources

All datasets live under `data/` (gitignored). Re-download with `ml/download_data.sh`.

## Training data

### AVP — Amateur Vocal Percussion (primary)

- `data/avp/AVP_Dataset/{Personal,Fixed}/Participant_N/`
- [Zenodo record 3245959](https://zenodo.org/records/3245959), **CC BY 4.0**
  (credit Ramires et al., [arXiv:2009.11737](https://arxiv.org/abs/2009.11737))
- 28 participants × 2 subsets × 5 files (kick / snare / hh-closed / hh-open repetitions +
  improvisation), 44.1 kHz mono WAV. ~9.8k annotated events.
- Annotations: per-file CSV `onset_seconds,label` with labels `kd, sd, hhc, hho`.
  **Gotcha:** some CSVs have malformed rows (missing newlines gluing a label to the next
  onset, stray spaces, a stray `pm` label) — parse with a regex, not a naive CSV reader.

### AVP-LVT — phoneme-annotated AVP subset

- `data/avp-lvt/AVP-LVT_Dataset/AVP_Dataset/Personal/`
- [Zenodo record 5578744](https://zenodo.org/records/5578744), **CC BY 4.0**
- Same audio as AVP Personal, but CSVs carry `onset,label,onset_phoneme,coda_phoneme`
  (IPA). 4,873 events. Used for the auxiliary syllable-supervision head.
- The LVT audio subset requires a Google Drive build step; skipped (adds only 841 events).

### beatboxset1 — expert beatboxers + "other" class

- `data/beatboxset1/`
- [archive.org/details/beatboxset1](https://archive.org/details/beatboxset1), **CC BY-SA 3.0**
  (Stowell, QMUL). Training use only; its audio is not shipped in the app.
- 14 recordings from humanbeatbox.com users; two annotator sets (`Annotations_DR`, `Annotations_HT`),
  CSV `onset,label`. Label map used: `k→kick, hc→hihat_closed, ho→hihat_open, s/sk/sb→snare,
  br/m/v/x→other` (breaths, humming, speech, misc — trains the rejection class).
  Dropped: `t` (undocumented in the dataset's legend) and `?` (annotator unsure).

## App playback samples

### TR-808 kit (shipped in the web app)

- `data/samples/tr808/` → copied into `web/public/drums/`
- [tidalcycles/sounds-tr808-fischer](https://github.com/tidalcycles/sounds-tr808-fischer),
  **CC0-1.0** (no attribution required). 151 WAVs: `bd8` kick, `sd8` snare, `ch8` closed hat,
  `oh8` open hat, plus claps/toms/cymbals for future pads.
- The app also has a zero-asset synthesized fallback kit (`web/src/lib/drumSynth.ts`).

## Considered and not used

- **maxardito/beatbox** (HuggingFace, MIT): BaDumTss one-shots — redundant with AVP.
- **Vocal Imitation Set** (7.6 GB) / **VocalSketch** (4.6 GB): imitations of arbitrary sounds,
  mostly non-percussive; poor signal-to-size for this task.
- Freesound packs: need API key / login for bulk download.
- madmom pretrained models: CC BY-NC — license poison for a deployable app.
