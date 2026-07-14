"""Simulate the app's personalization: for each held-out user, take N calibration
examples per class from their repetition files (embedding + KNN), classify their
improvisation hits with the blended score, and report accuracy.

This is the number that reflects the real app experience (calibrated user),
vs train.py's user-agnostic accuracy (uncalibrated user).

Usage: .venv/bin/python ml/eval_knn.py [--n-examples 8]
"""

from __future__ import annotations

import argparse
from collections import Counter, defaultdict
from pathlib import Path

import numpy as np
import torch

from dataset import CLASSES, PatchDataset, build_manifest
from model import BeatboxNet
from train import TEST_GROUPS

ROOT = Path(__file__).resolve().parent.parent
DRUMS = CLASSES[:4]


def embed_events(model, ds: PatchDataset, device) -> tuple[np.ndarray, np.ndarray]:
    """Return (embeddings, class_probs) for every event in ds."""
    embs, probs = [], []
    model.eval()
    with torch.no_grad():
        for i in range(0, len(ds), 512):
            batch = torch.stack([ds[j][0] for j in range(i, min(i + 512, len(ds)))])
            logits, _, emb = model(batch.to(device))
            embs.append(emb.cpu().numpy())
            probs.append(torch.softmax(logits, dim=1).cpu().numpy())
    return np.concatenate(embs), np.concatenate(probs)


def knn_probs(query: np.ndarray, bank: np.ndarray, labels: list[int], k: int = 5) -> np.ndarray:
    qn = query / (np.linalg.norm(query) + 1e-9)
    bn = bank / (np.linalg.norm(bank, axis=1, keepdims=True) + 1e-9)
    sims = bn @ qn
    top = np.argsort(-sims)[:k]
    votes = np.zeros(len(DRUMS))
    for idx in top:
        votes[labels[idx]] += max(0.0, sims[idx]) ** 4
    s = votes.sum()
    return votes / s if s > 0 else votes


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--n-examples", type=int, default=8)
    ap.add_argument("--k", type=int, default=5)
    args = ap.parse_args()

    device = "cuda" if torch.cuda.is_available() else "cpu"
    ckpt = torch.load(ROOT / "ml/checkpoints/best.pt", map_location=device, weights_only=False)
    model = BeatboxNet(len(ckpt["classes"]), len(ckpt["vocab"])).to(device)
    model.load_state_dict(ckpt["model"])

    events = build_manifest(ROOT / "data")
    rng = np.random.default_rng(0)

    accs_blend, accs_global, accs_knn = [], [], []
    for group in sorted(TEST_GROUPS):
        if not group.startswith("avp_"):
            continue  # calibration simulation needs the AVP per-file structure
        ev = [e for e in events if e.group == group and e.label in DRUMS]
        calib = [e for e in ev if "Improvisation" not in e.path]
        test = [e for e in ev if "Improvisation" in e.path]
        if not test:
            continue
        # Sample N calibration examples per class.
        chosen = []
        for cls in DRUMS:
            pool = [e for e in calib if e.label == cls]
            if len(pool) == 0:
                continue
            idx = rng.choice(len(pool), size=min(args.n_examples, len(pool)), replace=False)
            chosen += [pool[i] for i in idx]

        calib_ds = PatchDataset(chosen, ckpt["vocab"])
        test_ds = PatchDataset(test, ckpt["vocab"])
        calib_emb, _ = embed_events(model, calib_ds, device)
        calib_labels = [DRUMS.index(e.label) for e in chosen]
        test_emb, test_probs = embed_events(model, test_ds, device)

        alpha = min(0.8, len(chosen) / 24)
        correct_b = correct_g = correct_k = 0
        for i, e in enumerate(test):
            true = DRUMS.index(e.label)
            gp = test_probs[i][:4]
            gp = gp / (gp.sum() + 1e-9)
            kp = knn_probs(test_emb[i], calib_emb, calib_labels, args.k)
            bp = alpha * kp + (1 - alpha) * gp
            correct_g += int(np.argmax(gp) == true)
            correct_k += int(np.argmax(kp) == true)
            correct_b += int(np.argmax(bp) == true)
        n = len(test)
        accs_global.append(correct_g / n)
        accs_knn.append(correct_k / n)
        accs_blend.append(correct_b / n)
        print(
            f"{group:>22}  n={n:4d}  global {correct_g/n:.3f}  knn {correct_k/n:.3f}  "
            f"blend {correct_b/n:.3f}"
        )

    print(
        f"\nmean over {len(accs_blend)} held-out users "
        f"({args.n_examples} calib examples/class):\n"
        f"  global-only : {np.mean(accs_global):.3f}\n"
        f"  knn-only    : {np.mean(accs_knn):.3f}\n"
        f"  blended     : {np.mean(accs_blend):.3f}"
    )


if __name__ == "__main__":
    main()
