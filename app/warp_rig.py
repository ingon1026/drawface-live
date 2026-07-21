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
BLINK_MAX = 0.62   # pure-warp lid-squash ceiling; the seal layer finishes the close
SEAL_RAMP = (0.70, 1.0)   # blink range over which the eyelid seal fades in
JAW_RAMP = (0.30, 0.60)   # jaw range over which lips separate and the interior fills
MOUTH_FILL = (53, 53, 138)  # BGR of #8a3535 — matches the sprite pipeline's default


def _smoothstep(v: float, a: float, b: float) -> float:
    t = min(1.0, max(0.0, (v - a) / (b - a)))
    return t * t * (3.0 - 2.0 * t)


class WarpRig:
    """Warp a single character image with MediaPipe-landmark control points."""

    def __init__(self, image_bgr: np.ndarray, landmarks_px: np.ndarray,
                 border_steps: int = 9, brow_follow: bool = True) -> None:
        # brow_follow: brows dip with a blink. Disable for synthesized (box-based)
        # landmarks — their "brow" spots may sit on arbitrary strokes (head outline).
        self._brow_follow = brow_follow
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
        self._sample_layer_colors()

    def _sample_layer_colors(self) -> None:
        """Hybrid-layer colors come from the drawing itself (no invented art):
        lid fill = median just above each eye, stroke inks = darkest pixels of
        the feature region."""
        img, lm = self._img, self._lm
        h, w = img.shape[:2]

        def patch(x1: float, y1: float, x2: float, y2: float) -> np.ndarray:
            x1, x2 = sorted((int(np.clip(x1, 0, w - 1)), int(np.clip(x2, 0, w - 1))))
            y1, y2 = sorted((int(np.clip(y1, 0, h - 1)), int(np.clip(y2, 0, h - 1))))
            return img[y1:y2 + 1, x1:x2 + 1].reshape(-1, 3)

        def ink(px: np.ndarray) -> tuple[int, int, int]:
            gray = px.mean(axis=1)
            darkest = px[gray.argsort()[:max(1, len(px) // 20)]]
            return tuple(int(c) for c in np.median(darkest, axis=0))

        self._eye_colors = {}
        for side, (top, bot) in (("L", (L_EYE_TOP, L_EYE_BOT)), ("R", (R_EYE_TOP, R_EYE_BOT))):
            ring = lm[top + bot]
            x1, y1 = ring.min(axis=0)
            x2, y2 = ring.max(axis=0)
            ry = max(3.0, (y2 - y1) / 2)
            # Skin bands above AND below the eye; drop the darkest 45% so a brow,
            # ear or outline stroke crossing the band can't tint the lid color.
            px = np.vstack([patch(x1, y1 - 1.6 * ry, x2, y1 - 0.4 * ry),
                            patch(x1, y2 + 0.3 * ry, x2, y2 + 1.2 * ry)])
            keep = px[px.mean(axis=1) >= np.percentile(px.mean(axis=1), 45)]
            lid = tuple(int(c) for c in np.median(keep if len(keep) else px, axis=0))
            self._eye_colors[side] = {"lid": lid, "ink": ink(patch(x1, y1, x2, y2))}
        ring = lm[LIP_TOP + LIP_BOT + MOUTH_CORNERS]
        x1, y1 = ring.min(axis=0)
        x2, y2 = ring.max(axis=0)
        self._mouth_ink = ink(patch(x1, y1 - 2, x2, y2 + 2))

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
            if self._brow_follow:
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
            w_open = _smoothstep(v, *JAW_RAMP)  # 0 = closed bow, 1 = lips fully split
            for i in CHIN:
                add(i, 0.0, (9.0 + 5.0 * w_open) * s * v)
            # Inner-lip rings interleave along x; on a closed line-mouth they sit
            # on ONE stroke, so ring-wise displacement tears it into a sawtooth.
            # Small jaw: displace by depth inside the lip band (drawn lips separate
            # 3→8, a line-mouth moves as one stroke). Past JAW_RAMP the rings split
            # for real — the interior fill covers the stretched stroke pixels.
            top_y = float(self._lm[LIP_TOP][:, 1].mean())
            bot_y = float(self._lm[LIP_BOT][:, 1].mean())
            gap = bot_y - top_y
            for i in LIP_TOP + LIP_BOT:
                if gap > 3.0 * s:
                    frac = float(np.clip((self._lm[i][1] - top_y) / gap, 0.0, 1.0))
                else:
                    frac = 1.0
                base = (3.0 + 5.0 * frac) * s * v
                split = (2.0 if i in LIP_TOP else 14.0) * s * v
                add(i, 0.0, base * (1.0 - w_open) + split * w_open)
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
        out = piecewise_affine(self._img, self.verts, new_verts, self.tris)
        # Hybrid layers: pure warp can't fully close an eye or show a mouth
        # interior, so those are painted as polygons that FOLLOW the warped mesh
        # (never boxes) with colors sampled from the drawing.
        for side, amt, top, bot in (("L", blink_l, L_EYE_TOP, L_EYE_BOT),
                                    ("R", blink_r, R_EYE_TOP, R_EYE_BOT)):
            self._draw_eye_seal(out, new_verts, top, bot,
                                _smoothstep(min(amt, 1.0), *SEAL_RAMP), self._eye_colors[side])
        self._draw_mouth_interior(out, new_verts, _smoothstep(min(jaw, 1.0), *JAW_RAMP))
        return out

    def _ring_poly(self, verts: np.ndarray, top: list[int], bot: list[int]) -> np.ndarray:
        """Polygon between two warped rings: top left→right, bottom right→left."""
        t = verts[[self._vid[i] for i in top]]
        b = verts[[self._vid[i] for i in bot]]
        return np.vstack([t[np.argsort(t[:, 0])], b[np.argsort(b[:, 0])[::-1]]])

    def _blend_poly(self, out: np.ndarray, poly: np.ndarray, alpha: float,
                    fill: tuple, line: tuple | None, line_pts: np.ndarray | None,
                    line_width: int) -> None:
        if alpha <= 0.02:
            return
        x, y, w, h = cv2.boundingRect(poly.astype(np.int32))
        m = line_width + 2
        x, y = max(0, x - m), max(0, y - m)
        x2 = min(out.shape[1], x + w + 2 * m)
        y2 = min(out.shape[0], y + h + 2 * m)
        roi = out[y:y2, x:x2]
        layer = roi.copy()
        cv2.fillPoly(layer, [(poly - [x, y]).astype(np.int32)], fill, lineType=cv2.LINE_AA)
        if line is not None and line_pts is not None:
            cv2.polylines(layer, [(line_pts - [x, y]).astype(np.int32)], False, line,
                          line_width, lineType=cv2.LINE_AA)
        cv2.addWeighted(layer, alpha, roi, 1.0 - alpha, 0.0, dst=roi)

    def _draw_eye_seal(self, out: np.ndarray, verts: np.ndarray,
                       top: list[int], bot: list[int], alpha: float, colors: dict) -> None:
        """Finish the close: fill the residual opening between the warped lids
        with the lid color and stroke the closure line in the eye's ink."""
        if alpha <= 0.02:
            return
        poly = self._ring_poly(verts, top, bot)
        t = verts[[self._vid[i] for i in top]]
        line_pts = t[np.argsort(t[:, 0])]
        width = max(2, int((poly[:, 0].max() - poly[:, 0].min()) * 0.06))
        self._blend_poly(out, poly, alpha, colors["lid"], colors["ink"], line_pts, width)

    def _draw_mouth_interior(self, out: np.ndarray, verts: np.ndarray, alpha: float) -> None:
        """Fill the opening between the split lips (covers the stretched stroke
        pixels of a line-mouth) and outline it with the mouth's ink."""
        if alpha <= 0.02:
            return
        poly = self._ring_poly(verts, LIP_TOP + [MOUTH_CORNERS[0]], LIP_BOT + [MOUTH_CORNERS[1]])
        if poly[:, 1].max() - poly[:, 1].min() < 3.0 * self._scale:
            return
        width = max(2, int(3.0 * self._scale))
        self._blend_poly(out, poly, alpha, MOUTH_FILL, self._mouth_ink,
                         np.vstack([poly, poly[:1]]), width)


def landmarks_from_boxes(eye_l_box: tuple[float, float, float, float],
                         eye_r_box: tuple[float, float, float, float],
                         mouth_box: tuple[float, float, float, float],
                         size_wh: tuple[int, int]) -> np.ndarray:
    """Synthesize the FEATURE landmark layout from onboarding geometry.

    4-click characters (scribbles, stick figures) have no MediaPipe-detectable
    face; their eye/mouth boxes are all we know. The layout only has to be
    plausible: rings sit on the boxes, brows/nose/cheeks at face-proportional
    spots, and the oval anchors a static frame around everything. Boxes are
    (x1, y1, x2, y2) in pixels; eye_l is the viewer-left eye.
    """
    w, h = size_wh
    lm = np.zeros((478, 2), np.float32)

    def ring(ids: list[int], cx: float, cy: float, rx: float, ry: float, upper: bool) -> None:
        n = len(ids)
        for k, i in enumerate(ids):
            t = (k + 1) / (n + 1) * np.pi
            y = cy - ry * np.sin(t) if upper else cy + ry * np.sin(t)
            lm[i] = (cx - rx * np.cos(t), y)

    def box_geom(b: tuple[float, float, float, float]) -> tuple[float, float, float, float]:
        x1, y1, x2, y2 = b
        return ((x1 + x2) / 2, (y1 + y2) / 2, max(4.0, (x2 - x1) / 2), max(3.0, (y2 - y1) / 2))

    lcx, lcy, lrx, lry = box_geom(eye_l_box)
    rcx, rcy, rrx, rry = box_geom(eye_r_box)
    ring(L_EYE_TOP, lcx, lcy, lrx, lry, upper=True)
    ring(L_EYE_BOT, lcx, lcy, lrx, lry, upper=False)
    ring(R_EYE_TOP, rcx, rcy, rrx, rry, upper=True)
    ring(R_EYE_BOT, rcx, rcy, rrx, rry, upper=False)
    lm[EYE_SPAN[0]] = (lcx - lrx * 1.15, lcy)
    lm[EYE_SPAN[1]] = (rcx + rrx * 1.15, rcy)
    for k, i in enumerate(L_BROW):
        lm[i] = (lcx - lrx + 2 * lrx * k / (len(L_BROW) - 1), lcy - lry * 1.8)
    for k, i in enumerate(R_BROW):
        lm[i] = (rcx - rrx + 2 * rrx * k / (len(R_BROW) - 1), rcy - rry * 1.8)

    mcx, mcy, mrx, mry = box_geom(mouth_box)
    for k, i in enumerate(LIP_TOP):
        lm[i] = (mcx + mrx * 0.7 * (2 * k / (len(LIP_TOP) - 1) - 1), mcy - mry * 0.3)
    for k, i in enumerate(LIP_BOT):
        lm[i] = (mcx + mrx * 0.7 * (2 * k / (len(LIP_BOT) - 1) - 1), mcy + mry * 0.3)
    lm[MOUTH_CORNERS[0]] = (mcx - mrx, mcy)
    lm[MOUTH_CORNERS[1]] = (mcx + mrx, mcy)

    eyes_cy = (lcy + rcy) / 2
    face_cx = (lcx + rcx + mcx) / 3
    top_y = min(lcy - lry, rcy - rry)
    chin_y = mcy + mry + max(8.0, (mcy - eyes_cy) * 0.55)
    half_w = max(rcx + rrx - face_cx, face_cx - (lcx - lrx), mrx * 1.4) * 1.45
    cy_mid = (top_y + chin_y) / 2
    half_h = (chin_y - top_y) / 2 * 1.30 + mry
    for k, i in enumerate(FACE_OVAL):
        a = 2 * np.pi * k / len(FACE_OVAL)
        lm[i] = (face_cx + half_w * np.sin(a), cy_mid - half_h * np.cos(a))
    for k, i in enumerate(CHIN):  # after the oval: shared indices belong to the chin
        t = (k - (len(CHIN) - 1) / 2) / 2.0
        lm[i] = (mcx + t * mrx * 1.2, chin_y - abs(t) * mry * 0.5)
    ncx, ncy = (lcx + rcx) / 2, (eyes_cy + mcy) / 2
    for k, i in enumerate(NOSE):
        lm[i] = (ncx + (k % 3 - 1) * 4.0, ncy + (k // 3) * 5.0 - 2.5)
    for (px, py), i in zip((
        ((lcx - lrx + mcx - mrx) / 2, (eyes_cy + mcy) / 2),
        ((rcx + rrx + mcx + mrx) / 2, (eyes_cy + mcy) / 2),
        ((lcx + mcx) / 2, (eyes_cy + 2 * mcy) / 3),
        ((rcx + mcx) / 2, (eyes_cy + 2 * mcy) / 3),
        (mcx - mrx * 1.3, mcy + mry * 0.4),
        (mcx + mrx * 1.3, mcy + mry * 0.4),
    ), CHEEKS):
        lm[i] = (px, py)

    # Clamp into the canvas and nudge exact collisions apart — duplicate points
    # would fall out of the Delaunay triangulation and lose their pins.
    seen: set[tuple[float, float]] = set()
    for i in FEATURE + list(EYE_SPAN):
        x = min(max(float(lm[i, 0]), 2.0), w - 3.0)
        y = min(max(float(lm[i, 1]), 2.0), h - 3.0)
        key = (round(x, 1), round(y, 1))
        while key in seen:
            x = min(max(x + 0.9, 2.0), w - 3.0)
            y = min(max(y + 0.7, 2.0), h - 3.0)
            key = (round(x, 1), round(y, 1))
        seen.add(key)
        lm[i] = (x, y)
    return lm


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
