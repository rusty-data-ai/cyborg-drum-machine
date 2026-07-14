"""Train the vocal percussion classifier.

Usage: .venv/bin/python ml/train.py [--epochs 60] [--quick]

Held-out split is by participant/recording (cross-user generalization is the metric
that matters — see docs/design.md).
"""

from __future__ import annotations

import argparse
import json
from collections import Counter
from pathlib import Path

import numpy as np
import torch
import torch.nn.functional as F
from torch.utils.data import DataLoader

from dataset import (
    CLASSES,
    PatchDataset,
    build_manifest,
    build_syllable_vocab,
    split_events,
)
from model import MODEL_VERSION, BeatboxNet

ROOT = Path(__file__).resolve().parent.parent
CKPT_DIR = ROOT / "ml" / "checkpoints"

VAL_GROUPS = {"avp_Participant_5", "avp_Participant_14", "avp_Participant_22", "bbx_callout_mcld"}
TEST_GROUPS = {
    "avp_Participant_3",
    "avp_Participant_10",
    "avp_Participant_17",
    "avp_Participant_26",
    "bbx_putfile_vonny",
    "bbx_snare_hex",
}


def evaluate(model, loader, device) -> tuple[float, np.ndarray]:
    model.eval()
    n_cls = len(CLASSES)
    conf = np.zeros((n_cls, n_cls), dtype=np.int64)
    with torch.no_grad():
        for wave, y, _ in loader:
            logits, _, _ = model(wave.to(device))
            pred = logits.argmax(1).cpu().numpy()
            for t, p in zip(y.numpy(), pred):
                conf[t, p] += 1
    acc = float(np.trace(conf)) / max(1, conf.sum())
    return acc, conf


def format_confusion(conf: np.ndarray) -> str:
    header = "true\\pred " + " ".join(f"{c[:7]:>8}" for c in CLASSES)
    lines = [header]
    for i, c in enumerate(CLASSES):
        recall = conf[i, i] / max(1, conf[i].sum())
        lines.append(f"{c[:9]:>9} " + " ".join(f"{v:>8}" for v in conf[i]) + f"  recall={recall:.3f}")
    return "\n".join(lines)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--epochs", type=int, default=60)
    ap.add_argument("--batch", type=int, default=256)
    ap.add_argument("--lr", type=float, default=3e-3)
    ap.add_argument("--aux-weight", type=float, default=0.3)
    ap.add_argument("--quick", action="store_true", help="tiny run to smoke-test the pipeline")
    args = ap.parse_args()

    device = "cuda" if torch.cuda.is_available() else "cpu"
    torch.manual_seed(0)

    events = build_manifest(ROOT / "data")
    print(f"manifest: {len(events)} events")
    print("class counts:", Counter(e.label for e in events))
    vocab = build_syllable_vocab(events)
    print(f"syllable vocab: {len(vocab)}")

    train_ev, val_ev, test_ev = split_events(events, VAL_GROUPS, TEST_GROUPS)
    if args.quick:
        train_ev = train_ev[::20]
    print(f"train/val/test events: {len(train_ev)}/{len(val_ev)}/{len(test_ev)}")

    train_ds = PatchDataset(train_ev, vocab, augment=True)
    val_ds = PatchDataset(val_ev, vocab)
    test_ds = PatchDataset(test_ev, vocab)
    train_dl = DataLoader(
        train_ds, batch_size=args.batch, shuffle=True, num_workers=8, drop_last=True,
        persistent_workers=True,
    )
    val_dl = DataLoader(val_ds, batch_size=512, num_workers=4)
    test_dl = DataLoader(test_ds, batch_size=512, num_workers=4)

    # Inverse-frequency class weights (sqrt-damped).
    counts = Counter(e.label for e in train_ev)
    w = torch.tensor(
        [1.0 / np.sqrt(counts[c]) for c in CLASSES], dtype=torch.float32, device=device
    )
    # Damp the rejection class: false-rejecting a real drum hit costs the user
    # more than letting a breath through (round 2 leaked 78 kicks into 'other').
    w[CLASSES.index("other")] *= 0.6
    w = w / w.mean()

    model = BeatboxNet(len(CLASSES), len(vocab)).to(device)
    n_params = sum(p.numel() for p in model.parameters() if p.requires_grad)
    print(f"params: {n_params/1e3:.1f}k")
    opt = torch.optim.AdamW(model.parameters(), lr=args.lr, weight_decay=1e-4)
    epochs = 2 if args.quick else args.epochs
    sched = torch.optim.lr_scheduler.OneCycleLR(
        opt, max_lr=args.lr, total_steps=epochs * max(1, len(train_dl))
    )

    CKPT_DIR.mkdir(parents=True, exist_ok=True)
    best_val = 0.0
    for epoch in range(epochs):
        model.train()
        tot_loss, n_batches = 0.0, 0
        for wave, y, syl in train_dl:
            wave, y, syl = wave.to(device), y.to(device), syl.to(device)
            logits, syl_logits, _ = model(wave)
            loss = F.cross_entropy(logits, y, weight=w, label_smoothing=0.05)
            loss = loss + args.aux_weight * F.cross_entropy(syl_logits, syl, ignore_index=-100)
            opt.zero_grad()
            loss.backward()
            opt.step()
            sched.step()
            tot_loss += loss.item()
            n_batches += 1
        val_acc, _ = evaluate(model, val_dl, device)
        marker = ""
        if val_acc > best_val:
            best_val = val_acc
            torch.save(
                {
                    "model": model.state_dict(),
                    "vocab": vocab,
                    "classes": CLASSES,
                    "version": MODEL_VERSION,
                    "val_acc": val_acc,
                },
                CKPT_DIR / "best.pt",
            )
            marker = "  *saved*"
        print(
            f"epoch {epoch+1:3d}/{epochs}  loss {tot_loss/max(1,n_batches):.4f}  "
            f"val_acc {val_acc:.4f}{marker}",
            flush=True,
        )

    # Final test evaluation with the best checkpoint.
    ckpt = torch.load(CKPT_DIR / "best.pt", weights_only=False)
    model.load_state_dict(ckpt["model"])
    test_acc, conf = evaluate(model, test_dl, device)
    print(f"\nheld-out-user test accuracy: {test_acc:.4f}  (best val {ckpt['val_acc']:.4f})")
    print(format_confusion(conf))
    (CKPT_DIR / "test_report.json").write_text(
        json.dumps(
            {
                "test_acc": test_acc,
                "val_acc": ckpt["val_acc"],
                "confusion": conf.tolist(),
                "classes": CLASSES,
                "n_params": n_params,
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
