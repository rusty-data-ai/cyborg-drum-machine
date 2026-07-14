"""Export the trained model to ONNX for onnxruntime-web, verify parity, and
emit metadata + JS test fixtures.

Usage: .venv/bin/python ml/export.py
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import torch

from dataset import CLASSES, PATCH_LEN, SAMPLE_RATE
from model import EMBED_DIM, BeatboxNet, ExportModel, MODEL_VERSION

ROOT = Path(__file__).resolve().parent.parent
CKPT = ROOT / "ml" / "checkpoints" / "best.pt"
OUT_DIR = ROOT / "web" / "public" / "models"


def main() -> None:
    ckpt = torch.load(CKPT, map_location="cpu", weights_only=False)
    net = BeatboxNet(len(ckpt["classes"]), len(ckpt["vocab"]))
    net.load_state_dict(ckpt["model"])
    net.eval()
    model = ExportModel(net).eval()

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    onnx_path = OUT_DIR / "beatbox.onnx"
    dummy = torch.zeros(1, PATCH_LEN)
    torch.onnx.export(
        model,
        (dummy,),
        str(onnx_path),
        input_names=["waveform"],
        output_names=["logits", "embedding"],
        opset_version=17,
        dynamo=False,
    )

    # Parity check torch vs onnxruntime on random + real-ish signals.
    import onnxruntime as ort

    sess = ort.InferenceSession(str(onnx_path), providers=["CPUExecutionProvider"])
    rng = np.random.default_rng(0)
    max_err = 0.0
    fixtures = []
    for i in range(4):
        wave = (rng.standard_normal(PATCH_LEN) * 0.1).astype(np.float32)
        if i % 2 == 1:  # add a percussive-ish transient
            t = np.arange(PATCH_LEN) / SAMPLE_RATE
            wave += (np.exp(-t * 30) * np.sin(2 * np.pi * 80 * t)).astype(np.float32)
        with torch.no_grad():
            t_logits, t_emb = model(torch.from_numpy(wave).unsqueeze(0))
        o_logits, o_emb = sess.run(None, {"waveform": wave[None, :]})
        max_err = max(
            max_err,
            float(np.abs(t_logits.numpy() - o_logits).max()),
            float(np.abs(t_emb.numpy() - o_emb).max()),
        )
        if i < 2:
            fixtures.append(
                {
                    "waveform": wave.tolist(),
                    "logits": o_logits[0].tolist(),
                    "embedding": o_emb[0].tolist(),
                }
            )
    print(f"torch-vs-onnx max abs err: {max_err:.2e}")
    assert max_err < 1e-3, "ONNX export does not match PyTorch"

    meta = {
        "version": MODEL_VERSION,
        "classes": CLASSES,
        "sampleRate": SAMPLE_RATE,
        "patchLen": PATCH_LEN,
        "patchPreS": 0.04,
        "embeddingDim": EMBED_DIM,
        "valAcc": ckpt.get("val_acc"),
    }
    (OUT_DIR / "beatbox.json").write_text(json.dumps(meta, indent=2))
    (OUT_DIR / "fixtures.json").write_text(json.dumps(fixtures))
    size_kb = onnx_path.stat().st_size / 1024
    print(f"exported {onnx_path} ({size_kb:.0f} KB), metadata + fixtures written")


if __name__ == "__main__":
    main()
