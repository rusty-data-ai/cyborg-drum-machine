"""Dataset building for vocal percussion classification.

Parses AVP / AVP-LVT / beatboxset1 annotations into an event manifest, then serves
250 ms waveform patches ([-40 ms, +210 ms] around each onset) at 16 kHz with
waveform-domain augmentation. Class order must match web/src/lib/types.ts plus 'other'.
"""

from __future__ import annotations

import random
import re
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import soundfile as sf
import torch
from torch.utils.data import Dataset

SAMPLE_RATE = 16_000
PATCH_PRE_S = 0.04
PATCH_POST_S = 0.21
PATCH_LEN = int(SAMPLE_RATE * (PATCH_PRE_S + PATCH_POST_S))  # 4000

CLASSES = ["kick", "snare", "hihat_closed", "hihat_open", "other"]
CLASS_TO_IDX = {c: i for i, c in enumerate(CLASSES)}

AVP_LABEL_MAP = {"kd": "kick", "sd": "snare", "hhc": "hihat_closed", "hho": "hihat_open"}
BBX_LABEL_MAP = {
    "k": "kick",
    "hc": "hihat_closed",
    "ho": "hihat_open",
    "s": "snare",
    "sk": "snare",
    "sb": "snare",
    # breaths, humming, unclear, tongue clicks etc. -> rejection class
    "br": "other",
    "m": "other",
    "x": "other",
    "t": "other",
    "hum": "other",
}

# Some AVP CSVs have glued rows ("0.63,kd0.95,sd") and stray whitespace; regex-parse.
_AVP_ROW = re.compile(r"(\d+\.?\d*)\s*,\s*([a-z]+)")
_LVT_ROW = re.compile(r"(\d+\.?\d*)\s*,\s*([a-z]+)\s*,\s*([^,\s]+)\s*,\s*([^,\s]+)")


@dataclass
class Event:
    path: str  # wav path
    onset: float  # seconds
    label: str  # one of CLASSES
    syllable: str | None  # "onsetphoneme+coda" or None
    group: str  # participant / recording id, for user-level splits
    source: str  # avp | bbx


def parse_avp_csv(csv_path: Path) -> list[tuple[float, str, str | None]]:
    """Return (onset, class, syllable|None) rows; robust to malformed lines."""
    text = csv_path.read_text(errors="replace")
    out: list[tuple[float, str, str | None]] = []
    for line in text.splitlines():
        m4 = _LVT_ROW.match(line.strip())
        if m4:
            t, lab, ph_on, ph_coda = m4.groups()
            cls = AVP_LABEL_MAP.get(lab)
            if cls:
                out.append((float(t), cls, f"{ph_on}+{ph_coda}"))
                continue
        for m in _AVP_ROW.finditer(line):
            t, lab = m.groups()
            cls = AVP_LABEL_MAP.get(lab)
            if cls:
                out.append((float(t), cls, None))
    return out


def parse_bbx_csv(csv_path: Path) -> list[tuple[float, str, None]]:
    out: list[tuple[float, str, None]] = []
    for line in csv_path.read_text(errors="replace").splitlines():
        parts = re.split(r"[,\t]+", line.strip())
        if len(parts) < 2:
            continue
        try:
            t = float(parts[0])
        except ValueError:
            continue
        cls = BBX_LABEL_MAP.get(parts[1].strip().lower())
        if cls:
            out.append((t, cls, None))
    return out


def build_manifest(data_root: Path) -> list[Event]:
    events: list[Event] = []

    # AVP-LVT Personal subset (has phonemes) takes precedence for Personal files.
    lvt_root = data_root / "avp-lvt/AVP-LVT_Dataset/AVP_Dataset/Personal"
    avp_root = data_root / "avp/AVP_Dataset"
    seen_personal = set()
    if lvt_root.is_dir():
        for csv_path in sorted(lvt_root.glob("Participant_*/**/*.csv")):
            wav = csv_path.with_suffix(".wav")
            if not wav.exists():
                continue
            participant = csv_path.parent.name  # Participant_N
            seen_personal.add(wav.name)
            for t, cls, syl in parse_avp_csv(csv_path):
                events.append(Event(str(wav), t, cls, syl, f"avp_{participant}", "avp"))

    for subset in ["Personal", "Fixed"]:
        root = avp_root / subset
        if not root.is_dir():
            continue
        for csv_path in sorted(root.glob("Participant_*/**/*.csv")):
            wav = csv_path.with_suffix(".wav")
            if not wav.exists() or (subset == "Personal" and wav.name in seen_personal):
                continue
            participant = csv_path.parent.name
            for t, cls, syl in parse_avp_csv(csv_path):
                events.append(Event(str(wav), t, cls, syl, f"avp_{participant}", "avp"))

    bbx_root = data_root / "beatboxset1"
    if bbx_root.is_dir():
        for csv_path in sorted((bbx_root / "Annotations_DR").glob("*.csv")):
            wav = bbx_root / (csv_path.stem + ".wav")
            if not wav.exists():
                continue
            for t, cls, syl in parse_bbx_csv(csv_path):
                events.append(Event(str(wav), t, cls, syl, f"bbx_{csv_path.stem}", "bbx"))

    return events


def build_syllable_vocab(events: list[Event], min_count: int = 12) -> dict[str, int]:
    counts: dict[str, int] = {}
    for e in events:
        if e.syllable:
            counts[e.syllable] = counts.get(e.syllable, 0) + 1
    vocab = {"<unk>": 0}
    for syl, c in sorted(counts.items(), key=lambda kv: -kv[1]):
        if c >= min_count:
            vocab[syl] = len(vocab)
    return vocab


def split_events(
    events: list[Event], val_groups: set[str], test_groups: set[str]
) -> tuple[list[Event], list[Event], list[Event]]:
    train, val, test = [], [], []
    for e in events:
        if e.group in test_groups:
            test.append(e)
        elif e.group in val_groups:
            val.append(e)
        else:
            train.append(e)
    return train, val, test


class _WavCache:
    """Whole-file cache of 16 kHz mono waveforms (dataset is ~500 MB at 16 kHz — fits RAM)."""

    def __init__(self) -> None:
        self._cache: dict[str, np.ndarray] = {}

    def get(self, path: str) -> np.ndarray:
        if path not in self._cache:
            audio, sr = sf.read(path, dtype="float32", always_2d=False)
            if audio.ndim > 1:
                audio = audio.mean(axis=1)
            if sr != SAMPLE_RATE:
                # Polyphase-ish linear resample; fine for training data prep.
                n_out = int(len(audio) * SAMPLE_RATE / sr)
                x_old = np.linspace(0.0, 1.0, len(audio), endpoint=False)
                x_new = np.linspace(0.0, 1.0, n_out, endpoint=False)
                audio = np.interp(x_new, x_old, audio).astype(np.float32)
            self._cache[path] = audio
        return self._cache[path]


class PatchDataset(Dataset):
    def __init__(
        self,
        events: list[Event],
        syllable_vocab: dict[str, int],
        augment: bool = False,
        seed: int = 0,
    ) -> None:
        self.events = events
        self.vocab = syllable_vocab
        self.augment = augment
        self.cache = _WavCache()
        self.rng = random.Random(seed)

    def __len__(self) -> int:
        return len(self.events)

    def _extract(self, audio: np.ndarray, onset_s: float, jitter_s: float = 0.0) -> np.ndarray:
        start = int((onset_s - PATCH_PRE_S + jitter_s) * SAMPLE_RATE)
        patch = np.zeros(PATCH_LEN, dtype=np.float32)
        lo = max(0, start)
        hi = min(len(audio), start + PATCH_LEN)
        if hi > lo:
            patch[lo - start : hi - start] = audio[lo:hi]
        return patch

    def _augment_wave(self, audio: np.ndarray, onset_s: float) -> np.ndarray:
        rng = self.rng
        jitter = rng.uniform(-0.01, 0.01)
        # Random speed (correlated pitch+tempo, kaldi-style): resample the local region.
        speed = rng.uniform(0.85, 1.18)
        # Extract a larger region, resample, then cut the patch.
        span = PATCH_LEN * 2
        start = int((onset_s - PATCH_PRE_S) * SAMPLE_RATE) - PATCH_LEN // 2
        region = np.zeros(span, dtype=np.float32)
        lo, hi = max(0, start), min(len(audio), start + span)
        if hi > lo:
            region[lo - start : hi - start] = audio[lo:hi]
        n_out = int(span / speed)
        x_old = np.linspace(0.0, 1.0, span, endpoint=False)
        x_new = np.linspace(0.0, 1.0, n_out, endpoint=False)
        region = np.interp(x_new, x_old, region).astype(np.float32)
        # Onset sits at PATCH_LEN//2 in the original region; rescale position.
        onset_idx = int((PATCH_LEN // 2) / speed)
        start2 = onset_idx - int((PATCH_PRE_S - jitter) * SAMPLE_RATE)
        patch = np.zeros(PATCH_LEN, dtype=np.float32)
        lo2, hi2 = max(0, start2), min(len(region), start2 + PATCH_LEN)
        if hi2 > lo2:
            patch[lo2 - start2 : hi2 - start2] = region[lo2:hi2]

        # Gain
        patch *= 10 ** (rng.uniform(-6, 6) / 20)
        # First-order spectral tilt (mic diversity): y[n] = x[n] - a*x[n-1]
        a = rng.uniform(-0.3, 0.3)
        patch[1:] = patch[1:] - a * patch[:-1]
        # Additive white noise at random SNR
        sig = float(np.sqrt(np.mean(patch**2)) + 1e-8)
        snr_db = rng.uniform(20, 45)
        noise_rms = sig / (10 ** (snr_db / 20))
        patch += np.random.default_rng(rng.getrandbits(32)).normal(0, noise_rms, PATCH_LEN).astype(
            np.float32
        )
        return patch

    def __getitem__(self, idx: int):
        e = self.events[idx]
        audio = self.cache.get(e.path)
        if self.augment:
            patch = self._augment_wave(audio, e.onset)
        else:
            patch = self._extract(audio, e.onset)
        # Peak-normalize with a random-ish headroom during training; fixed at eval.
        peak = float(np.max(np.abs(patch)) + 1e-6)
        target = self.rng.uniform(0.5, 0.95) if self.augment else 0.8
        patch = patch * (target / max(peak, target))  # never amplify quiet noise to full scale
        syl = self.vocab.get(e.syllable, 0) if e.syllable else -100
        return (
            torch.from_numpy(patch.copy()),
            CLASS_TO_IDX[e.label],
            syl,
        )
