"""Model: in-graph mel frontend (conv-STFT, ONNX-friendly) + small CNN with
instrument head, auxiliary syllable head, and an embedding output for KNN
personalization. Class order lives in dataset.CLASSES.
"""

from __future__ import annotations

import math

import torch
import torch.nn as nn
import torch.nn.functional as F

MODEL_VERSION = "2"
N_FFT = 512
HOP = 128
N_MELS = 64
EMBED_DIM = 128
SAMPLE_RATE = 16_000


def hz_to_mel(f: float) -> float:
    return 2595.0 * math.log10(1.0 + f / 700.0)


def mel_to_hz(m: float) -> float:
    return 700.0 * (10.0 ** (m / 2595.0) - 1.0)


def mel_filterbank(n_mels: int, n_fft: int, sr: int, fmin: float = 30.0, fmax: float | None = None) -> torch.Tensor:
    """Triangular (HTK-style) mel filterbank, shape [n_fft//2+1, n_mels]."""
    fmax = fmax or sr / 2
    n_bins = n_fft // 2 + 1
    mel_pts = torch.linspace(hz_to_mel(fmin), hz_to_mel(fmax), n_mels + 2)
    hz_pts = torch.tensor([mel_to_hz(m.item()) for m in mel_pts])
    bin_freqs = torch.linspace(0, sr / 2, n_bins)
    fb = torch.zeros(n_bins, n_mels)
    for m in range(n_mels):
        lo, ctr, hi = hz_pts[m], hz_pts[m + 1], hz_pts[m + 2]
        up = (bin_freqs - lo) / (ctr - lo + 1e-9)
        down = (hi - bin_freqs) / (hi - ctr + 1e-9)
        fb[:, m] = torch.clamp(torch.minimum(up, down), min=0)
    return fb


class MelFrontend(nn.Module):
    """Waveform [B, T] -> log-mel [B, 1, n_mels, frames] using only Conv/MatMul ops
    (exports cleanly to ONNX WASM). STFT is a Conv1d with fixed cos/sin kernels."""

    def __init__(self) -> None:
        super().__init__()
        window = torch.hann_window(N_FFT)
        k = torch.arange(N_FFT).float()
        bins = torch.arange(N_FFT // 2 + 1).float()
        angle = 2 * math.pi * bins[:, None] * k[None, :] / N_FFT
        cos_kernel = (torch.cos(angle) * window)[:, None, :]  # [bins, 1, N_FFT]
        sin_kernel = (-torch.sin(angle) * window)[:, None, :]
        self.register_buffer("stft_kernel", torch.cat([cos_kernel, sin_kernel], dim=0))
        self.register_buffer("melmat", mel_filterbank(N_MELS, N_FFT, SAMPLE_RATE))

    def forward(self, wave: torch.Tensor) -> torch.Tensor:
        x = wave.unsqueeze(1)  # [B, 1, T]
        spec = F.conv1d(x, self.stft_kernel, stride=HOP)  # [B, 2*bins, frames]
        n_bins = N_FFT // 2 + 1
        re, im = spec[:, :n_bins], spec[:, n_bins:]
        power = re * re + im * im  # [B, bins, frames]
        mel = torch.matmul(self.melmat.t(), power)  # [B, n_mels, frames]
        return torch.log1p(100.0 * mel).unsqueeze(1)  # [B, 1, n_mels, frames]


class SpecAugment(nn.Module):
    """Cheap time/freq masking, training only (not exported)."""

    def __init__(self, freq_width: int = 8, time_width: int = 4, n_masks: int = 1) -> None:
        super().__init__()
        self.fw, self.tw, self.n = freq_width, time_width, n_masks

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        if not self.training:
            return x
        b, _, f, t = x.shape
        for _ in range(self.n):
            f0 = torch.randint(0, f, (b,), device=x.device)
            fl = torch.randint(1, self.fw + 1, (b,), device=x.device)
            t0 = torch.randint(0, t, (b,), device=x.device)
            tl = torch.randint(1, self.tw + 1, (b,), device=x.device)
            for i in range(b):
                x[i, :, f0[i] : f0[i] + fl[i], :] = 0
                x[i, :, :, t0[i] : t0[i] + tl[i]] = 0
        return x


def conv_block(cin: int, cout: int) -> nn.Sequential:
    return nn.Sequential(
        nn.Conv2d(cin, cout, 3, padding=1),
        nn.BatchNorm2d(cout),
        nn.ReLU(inplace=True),
        nn.MaxPool2d(2),
    )


class BeatboxNet(nn.Module):
    def __init__(self, n_classes: int, n_syllables: int) -> None:
        super().__init__()
        self.frontend = MelFrontend()
        self.specaug = SpecAugment()
        self.body = nn.Sequential(
            conv_block(1, 16),
            conv_block(16, 32),
            conv_block(32, 64),
            conv_block(64, 128),
        )
        self.embed = nn.Linear(128, EMBED_DIM)
        self.dropout = nn.Dropout(0.25)
        self.head_class = nn.Linear(EMBED_DIM, n_classes)
        self.head_syllable = nn.Linear(EMBED_DIM, n_syllables)

    def forward(self, wave: torch.Tensor):
        x = self.frontend(wave)
        x = self.specaug(x)
        x = self.body(x)
        x = x.mean(dim=(2, 3))  # GAP -> [B, 128]
        emb = self.embed(x)
        h = self.dropout(F.relu(emb))
        return self.head_class(h), self.head_syllable(h), emb


class ExportModel(nn.Module):
    """Inference wrapper: waveform -> (logits, embedding). SpecAugment inactive in eval."""

    def __init__(self, net: BeatboxNet) -> None:
        super().__init__()
        self.net = net

    def forward(self, wave: torch.Tensor):
        logits, _, emb = self.net(wave)
        return logits, emb
