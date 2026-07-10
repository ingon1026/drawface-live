"""Derive half-eye and smile sprites by geometric transforms of EXISTING sprites.

No new artwork is generated (CLAUDE.md rule) — half-eye is a vertical squash of
the open eye, smile is a corner-lift remap of the closed mouth. Both are
mechanical warps of the user's own drawing.

Usage: .venv/bin/python scripts/derive_sprites.py assets/sprites/pig
"""
from __future__ import annotations

import sys
from pathlib import Path

import cv2
import numpy as np

SQUASH = 0.45       # half-eye: keep this fraction of the eye height (lid comes down)
SMILE_AMP_FRAC = 0.10  # smile: corner lift as a fraction of mouth-content width


def bbox_of(alpha: np.ndarray) -> tuple[int, int, int, int]:
    ys, xs = np.where(alpha > 0)
    return xs.min(), ys.min(), xs.max() + 1, ys.max() + 1


def derive_half_eye(open_path: Path, out_path: Path) -> None:
    img = cv2.imread(str(open_path), cv2.IMREAD_UNCHANGED)
    x0, y0, x1, y1 = bbox_of(img[:, :, 3])
    content = img[y0:y1, x0:x1]
    new_h = max(2, int(round((y1 - y0) * SQUASH)))
    squashed = cv2.resize(content, (x1 - x0, new_h), interpolation=cv2.INTER_AREA)
    out = np.zeros_like(img)
    out[y1 - new_h:y1, x0:x1] = squashed  # anchor at the bottom: lid closes from the top
    cv2.imwrite(str(out_path), out)


def derive_smile(closed_path: Path, out_path: Path) -> None:
    img = cv2.imread(str(closed_path), cv2.IMREAD_UNCHANGED)
    x0, y0, x1, y1 = bbox_of(img[:, :, 3])
    cx, half_w = (x0 + x1) / 2, max(1.0, (x1 - x0) / 2)
    amp = (x1 - x0) * SMILE_AMP_FRAC

    # Column-wise integer lift: 0 at the center, `amp` px at the corners.
    # (Pure numpy — cv2 5.x remap scatters NaN into float sprites.)
    out = np.zeros_like(img)
    for x in range(x0, x1):
        t = min(1.0, abs(x - cx) / half_w)
        shift = int(round(amp * t * t))
        out[:, x] = np.roll(img[:, x], -shift, axis=0)
        if shift:
            out[-shift:, x] = 0
    cv2.imwrite(str(out_path), out)


def main() -> int:
    d = Path(sys.argv[1] if len(sys.argv) > 1 else "assets/sprites/pig")
    for side in ("L", "R"):
        derive_half_eye(d / f"eye_{side}_open.png", d / f"eye_{side}_half.png")
        print(f"wrote eye_{side}_half.png")
    derive_smile(d / "mouth_closed.png", d / "mouth_smile.png")
    print("wrote mouth_smile.png")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
