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


# Auto viseme derivation: the character's own closed-mouth stroke becomes the
# lips; the opened interior is filled procedurally with the manifest's
# mouthStyle colors (same convention the user's default character already uses).
# drop/wx are fractions of the closed-mouth content width.
VISEMES = {
    "A": dict(drop=0.62, wx=0.85, teeth=0.00, tongue=0.35),
    "E": dict(drop=0.30, wx=1.10, teeth=0.22, tongue=0.00),
    "I": dict(drop=0.15, wx=1.05, teeth=0.30, tongue=0.00),
    "O": dict(drop=0.45, wx=0.70, teeth=0.00, tongue=0.30),
    "U": dict(drop=0.26, wx=0.55, teeth=0.00, tongue=0.00),
}


def _hex_bgr(h: str) -> tuple[int, int, int]:
    h = h.lstrip("#")
    return int(h[4:6], 16), int(h[2:4], 16), int(h[0:2], 16)


def _place(canvas: np.ndarray, content: np.ndarray, cx: float, top: int) -> None:
    ch, cw = content.shape[:2]
    x = int(round(cx - cw / 2))
    y0c, x0c = max(0, top), max(0, x)
    region = canvas[y0c:top + ch, x0c:x + cw]
    src = content[y0c - top:, x0c - x:][:region.shape[0], :region.shape[1]]
    a = src[:, :, 3:4].astype(np.float32) / 255.0
    region[:] = (src.astype(np.float32) * a + region.astype(np.float32) * (1 - a)).astype(np.uint8)


def derive_mouth_set(closed_path: Path, manifest_path: Path, out_dir: Path) -> None:
    import json

    style = json.loads(manifest_path.read_text(encoding="utf-8")).get("mouthStyle", {})
    fill = tuple(int(v * 0.72) for v in _hex_bgr(style.get("fill", "#8a3535")))  # darker interior reads as depth
    tongue_c = _hex_bgr(style.get("tongue", "#d97b7b"))
    teeth_c = _hex_bgr(style.get("teeth", "#ffffff"))

    img = cv2.imread(str(closed_path), cv2.IMREAD_UNCHANGED)
    h, w = img.shape[:2]
    x0, y0, x1, y1 = bbox_of(img[:, :, 3])
    stroke = img[y0:y1, x0:x1]
    mw = x1 - x0
    cx = (x0 + x1) / 2
    out_dir.mkdir(parents=True, exist_ok=True)

    for name, p in VISEMES.items():
        lip = cv2.resize(stroke, (max(2, int(mw * p["wx"])), y1 - y0), interpolation=cv2.INTER_AREA)
        drop = int(mw * p["drop"])
        canvas = np.zeros((h, w, 4), np.uint8)

        # interior: per column, fill between the two lip strokes
        top_l = np.zeros((h, w, 4), np.uint8)
        bot_l = np.zeros((h, w, 4), np.uint8)
        _place(top_l, lip, cx, y0)
        _place(bot_l, lip, cx, y0 + drop)
        ta, ba = top_l[:, :, 3] > 60, bot_l[:, :, 3] > 60
        for x in range(w):
            tc, bc = np.where(ta[:, x])[0], np.where(ba[:, x])[0]
            if len(tc) and len(bc) and bc[0] > tc[-1]:
                canvas[tc[-1]:bc[0] + 1, x] = (*fill, 255)

        inner = canvas[:, :, 3] > 0
        if p["teeth"] and inner.any():
            ys = np.where(inner.any(axis=1))[0]
            band = slice(ys[0], ys[0] + max(2, int(drop * p["teeth"])))
            canvas[band][inner[band]] = (*teeth_c, 255)
        if p["tongue"] and inner.any():
            ys = np.where(inner.any(axis=1))[0]
            tongue = np.zeros_like(canvas)
            cv2.ellipse(tongue, (int(cx), ys[-1]), (int(mw * 0.28), max(2, int(drop * p["tongue"]))),
                        0, 180, 360, (*tongue_c, 255), -1)
            m = (tongue[:, :, 3] > 0) & inner
            canvas[m] = tongue[m]

        _place(canvas, lip, cx, y0)          # top lip stroke over the interior
        _place(canvas, lip, cx, y0 + drop)   # bottom lip stroke

        # hand-drawn look: wrap the whole mouth in an ink outline, using the
        # character's real ink color and stroke thickness sampled from mouth_closed
        ink_px = img[img[:, :, 3] > 200][:, :3]
        ink = tuple(int(v) for v in np.median(ink_px, axis=0)) if len(ink_px) else (43, 43, 43)
        thickness = max(2, int(round((img[:, :, 3] > 60).sum(axis=0)[x0:x1].mean() * 0.9)))
        mask = (canvas[:, :, 3] > 60).astype(np.uint8)
        contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        outline = np.zeros_like(canvas)
        cv2.drawContours(outline, contours, -1, (*ink, 255), thickness, lineType=cv2.LINE_AA)
        oa = outline[:, :, 3:4].astype(np.float32) / 255.0
        canvas = (outline.astype(np.float32) * oa + canvas.astype(np.float32) * (1 - oa)).astype(np.uint8)
        cv2.imwrite(str(out_dir / f"mouth_{name}.png"), canvas)
    # closed mouth is reused as-is
    cv2.imwrite(str(out_dir / "mouth_closed.png"), img)


def main() -> int:
    d = Path(sys.argv[1] if len(sys.argv) > 1 else "assets/sprites/pig")
    if "--auto-mouths" in sys.argv:
        out = Path(sys.argv[sys.argv.index("--auto-mouths") + 1])
        if (out / "mouth_A.png").exists() and "--force" not in sys.argv:
            print(f"refusing to overwrite existing viseme set in {out} (use --force)")
            return 1
        derive_mouth_set(d / "mouth_closed.png", d / "manifest.json", out)
        print(f"wrote auto viseme set to {out}")
        return 0
    for side in ("L", "R"):
        derive_half_eye(d / f"eye_{side}_open.png", d / f"eye_{side}_half.png")
        print(f"wrote eye_{side}_half.png")
    derive_smile(d / "mouth_closed.png", d / "mouth_smile.png")
    print("wrote mouth_smile.png")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
