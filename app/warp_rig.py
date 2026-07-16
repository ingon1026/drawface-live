"""ARAP warp rig: continuous, style-preserving face deformation of one drawing.

Research track from the 2026-07-16 PoC (sprite "붙인 티" 해소): instead of erasing
and pasting feature patches, the drawing itself is warped on a triangle mesh, so
every output pixel comes from the source image and the art style survives by
construction.

Solver: third_party/animated_drawings/arap.py (Meta AnimatedDrawings, MIT,
vendored — see THIRD_PARTY.md). Cheek vertices are left unpinned so ARAP
propagates lip/corner motion into them instead of hand-tuned offsets.

Proven limits (PoC): pure warp covers ~62% eyelid closure and a modest jaw
opening; full closure and open-mouth interiors remain layer-swap territory.
Measured at 512²: solve ~1.5 ms + CPU piecewise render ~15 ms per frame.
"""
from __future__ import annotations

import cv2
import numpy as np
from scipy.spatial import Delaunay

from third_party.animated_drawings.arap import ARAP

# MediaPipe 478-landmark topology (viewer-left = image-left).
L_EYE_TOP = [159, 158, 157, 173, 246, 161, 160]
L_EYE_BOT = [145, 153, 154, 155, 7, 163, 144]
R_EYE_TOP = [386, 385, 384, 398, 466, 388, 387]
R_EYE_BOT = [374, 380, 381, 382, 249, 390, 373]
L_BROW = [70, 63, 105, 66, 107]
R_BROW = [300, 293, 334, 296, 336]
LIP_TOP = [13, 82, 312, 81, 311, 80, 310]
LIP_BOT = [14, 87, 317, 178, 402, 88, 318]
MOUTH_CORNERS = [61, 291]
CHIN = [152, 148, 377, 176, 400]
FACE_OVAL = [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288,
             397, 365, 379, 378, 152, 148, 176, 149, 150, 136, 172, 58,
             132, 93, 234, 127, 162, 21, 54, 103, 67, 109]
NOSE = [1, 4, 5, 195, 197, 6]
CHEEKS = [50, 280, 101, 330, 205, 425]  # unpinned: ARAP fills in their motion
EYE_SPAN = (33, 263)  # outer eye corners, scale reference

FEATURE = sorted(set(L_EYE_TOP + L_EYE_BOT + R_EYE_TOP + R_EYE_BOT + L_BROW + R_BROW
                     + LIP_TOP + LIP_BOT + MOUTH_CORNERS + CHIN + FACE_OVAL + NOSE + CHEEKS))

# Displacement amplitudes were tuned on a 512² character whose eye span measured
# ~135.6 px; they scale with the actual span so other resolutions/faces match.
UNIT_REF = 135.6
BLINK_MAX = 0.62  # pure-warp lid-closure ceiling; beyond this a layer swap takes over


class WarpRig:
    """Warp a single character image with MediaPipe-landmark control points."""

    def __init__(self, image_bgr: np.ndarray, landmarks_px: np.ndarray,
                 border_steps: int = 9) -> None:
        self._img = image_bgr
        h, w = image_bgr.shape[:2]
        self._lm = landmarks_px[:, :2].astype(np.float32)
        self._scale = float(np.linalg.norm(self._lm[EYE_SPAN[0]] - self._lm[EYE_SPAN[1]])) / UNIT_REF

        border: list[tuple[float, float]] = []
        for t in np.linspace(0, 1, border_steps):
            border += [(t * (w - 1), 0.0), (t * (w - 1), h - 1.0),
                       (0.0, t * (h - 1)), (w - 1.0, t * (h - 1))]
        border_pts = np.array(sorted(set(border)), np.float32)

        self._vid = {lm_idx: i for i, lm_idx in enumerate(FEATURE)}
        self.verts = np.vstack([self._lm[FEATURE], border_pts]).astype(np.float32)
        self.tris = Delaunay(self.verts).simplices.astype(np.int32)

        free = {self._vid[i] for i in CHEEKS}
        self._pin_ids = [v for v in range(len(self.verts)) if v not in free]
        self._pin_row = {vid: row for row, vid in enumerate(self._pin_ids)}
        # ARAP anchors each pin via a containing triangle; a pin that IS a mesh
        # vertex can fall through that test on floating-point edges (dropping the
        # constraint entirely). Nudge every pin a hair toward an incident
        # triangle's centroid so containment is unambiguous.
        centroid: dict[int, np.ndarray] = {}
        for t in self.tris:
            c = self.verts[t].mean(axis=0)
            for v in t:
                centroid.setdefault(int(v), c)
        self._pins0 = self.verts[self._pin_ids].copy()
        for row, vid in enumerate(self._pin_ids):
            self._pins0[row] += (centroid[vid] - self._pins0[row]) * 1e-4
        self._arap = ARAP(self._pins0, list(self.tris), self.verts)

    def deform(self, blink_l: float = 0.0, blink_r: float = 0.0,
               smile: float = 0.0, jaw: float = 0.0) -> np.ndarray:
        """Channel values 0..1 → new vertex positions (additive composition)."""
        s = self._scale
        delta: dict[int, np.ndarray] = {}

        def add(lm_idx: int, dx: float, dy: float) -> None:
            v = self._vid[lm_idx]
            delta[v] = delta.get(v, np.zeros(2, np.float32)) + np.array([dx, dy], np.float32)

        for amt, top, bot, brow in ((blink_l, L_EYE_TOP, L_EYE_BOT, L_BROW),
                                    (blink_r, R_EYE_TOP, R_EYE_BOT, R_BROW)):
            if amt <= 0.0:
                continue
            a = BLINK_MAX * min(amt, 1.0)
            ring = self._lm[top + bot]
            cx = float(ring[:, 0].mean())
            half_w = max(1.0, float(ring[:, 0].max() - ring[:, 0].min()) / 2)
            target_y = float(self._lm[bot][:, 1].mean()) - 1.0 * s

            def taper(x: float) -> float:
                t = min(1.0, abs(x - cx) / half_w)
                return max(0.1, 1.0 - t * t)  # lids hinge at the corners

            for i in top:
                p = self._lm[i]
                add(i, 0.0, a * taper(p[0]) * (target_y - float(p[1])))
            for i in bot:
                add(i, 0.0, -a * taper(float(self._lm[i][0])) * 1.5 * s)
            for i in brow:
                add(i, 0.0, 4.0 * s * min(amt, 1.0))

        if smile > 0.0:
            v = min(smile, 1.0)
            for i, sign in zip(MOUTH_CORNERS, (-1.0, 1.0)):
                add(i, sign * 7.0 * s * v, -9.0 * s * v)
            for i in LIP_TOP:
                add(i, 0.0, -2.0 * s * v)
            for i in LIP_BOT:
                add(i, 0.0, -3.0 * s * v)

        if jaw > 0.0:
            v = min(jaw, 1.0)
            for i in CHIN:
                add(i, 0.0, 9.0 * s * v)
            # Inner-lip rings interleave along x; on a closed line-mouth they sit
            # on ONE stroke, so ring-wise displacement tears it into a sawtooth.
            # Displace by each point's depth inside the lip band instead: drawn
            # lips separate smoothly (3→8), a line-mouth moves as one stroke.
            top_y = float(self._lm[LIP_TOP][:, 1].mean())
            bot_y = float(self._lm[LIP_BOT][:, 1].mean())
            gap = bot_y - top_y
            for i in LIP_TOP + LIP_BOT:
                if gap > 3.0 * s:
                    frac = float(np.clip((self._lm[i][1] - top_y) / gap, 0.0, 1.0))
                else:
                    frac = 1.0
                add(i, 0.0, (3.0 + 5.0 * frac) * s * v)
            for i in MOUTH_CORNERS:
                add(i, 0.0, 4.0 * s * v)

        if not delta:
            return self.verts.copy()
        pins = self._pins0.copy()
        for vid, d in delta.items():
            pins[self._pin_row[vid]] += d
        return self._arap.solve(pins).astype(np.float32)

    def render(self, blink_l: float = 0.0, blink_r: float = 0.0,
               smile: float = 0.0, jaw: float = 0.0) -> np.ndarray:
        new_verts = self.deform(blink_l=blink_l, blink_r=blink_r, smile=smile, jaw=jaw)
        return piecewise_affine(self._img, self.verts, new_verts, self.tris)


def piecewise_affine(src: np.ndarray, v0: np.ndarray, v1: np.ndarray,
                     triangles: np.ndarray) -> np.ndarray:
    out = src.copy()
    for t in triangles:
        s, d = v0[t], v1[t]
        if np.abs(s - d).max() < 0.25:
            continue
        x, y, w, h = cv2.boundingRect(d.astype(np.int32))
        if w < 1 or h < 1:
            continue
        m = cv2.getAffineTransform(s[:3].astype(np.float32), (d[:3] - [x, y]).astype(np.float32))
        patch = cv2.warpAffine(src, m, (w, h), flags=cv2.INTER_LINEAR,
                               borderMode=cv2.BORDER_REPLICATE)
        mask = np.zeros((h, w), np.uint8)
        cv2.fillConvexPoly(mask, (d - [x, y]).astype(np.int32), 255)
        mask = cv2.dilate(mask, np.ones((3, 3), np.uint8))  # close subpixel seams
        roi = out[y:y + h, x:x + w]
        sel = mask.astype(bool)
        roi[sel] = patch[sel]
    return out
