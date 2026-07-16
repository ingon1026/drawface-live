"""Offline ARAP warp-rig demo: one character image → expression stills + grid.

    PYTHONPATH=. .venv/bin/python scripts/warp_demo.py \
        --image assets/source/character.png --out outputs/warp_demo

Requires a drawing whose face MediaPipe can detect (same gate as the web
onboarding auto-detect). Prints per-frame solve+render timing.
"""
from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

import cv2
import numpy as np

from app.config import load_config
from app.face_tracker import FaceTracker
from app.warp_rig import WarpRig

ROOT = Path(__file__).resolve().parents[1]

STATES = [
    ("original", {}),
    ("blink", {"blink_l": 1.0, "blink_r": 1.0}),
    ("wink_left", {"blink_l": 1.0}),
    ("smile", {"smile": 1.0}),
    ("jaw_open", {"jaw": 1.0}),
    ("smile_jaw", {"smile": 1.0, "jaw": 0.6}),
]


def main() -> int:
    ap = argparse.ArgumentParser(description="render ARAP warp expressions for one drawing")
    ap.add_argument("--image", required=True, help="character image (face must be detectable)")
    ap.add_argument("--out", default=str(ROOT / "outputs" / "warp_demo"))
    ap.add_argument("--config", default=str(ROOT / "configs" / "app.yaml"))
    args = ap.parse_args()

    img = cv2.imread(args.image)
    if img is None:
        ap.error(f"cannot read image: {args.image}")
    h, w = img.shape[:2]

    cfg = load_config(args.config)
    tracker = FaceTracker(cfg["tracker"]["model"])
    obs = tracker.process(img, 0)
    tracker.close()
    if obs is None or obs.landmarks is None:
        print(f"face not detected in {args.image} — the warp rig needs a "
              "MediaPipe-detectable drawing (4-click onboarding characters are "
              "not supported yet)", file=sys.stderr)
        return 1

    rig = WarpRig(img, obs.landmarks * np.array([w, h], np.float32))

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    cells = []
    for name, expr in STATES:
        t0 = time.perf_counter()
        frame = rig.render(**expr)
        ms = (time.perf_counter() - t0) * 1000
        cv2.imwrite(str(out_dir / f"{name}.png"), frame)
        labeled = frame.copy()
        cv2.putText(labeled, name, (8, 24), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 0, 0), 2)
        cells.append(labeled)
        print(f"{name:10s} {ms:6.1f} ms")

    cv2.imwrite(str(out_dir / "grid.png"), np.hstack(cells))
    print(f"mesh: verts={len(rig.verts)} tris={len(rig.tris)} → {out_dir}/grid.png")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
