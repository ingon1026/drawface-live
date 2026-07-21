"""Deterministic sprite backend: blendshapes -> sprite states -> composite.

Sprites are 512x512 full-canvas RGBA overlays aligned to base.png
(assets/sprites/<char>/). Composite = base + eye_L_* + eye_R_* + mouth_*
(+ shifted brow/pupil overlays when the manifest enables them).
Sprite keys 'L'/'R' mean VIEWER-left/right on the canvas.
"""
from __future__ import annotations

import json
import logging
from pathlib import Path

import cv2
import numpy as np

log = logging.getLogger(__name__)

EXPECTED = [
    "base.png",
    "eye_L_open.png", "eye_L_closed.png", "eye_R_open.png", "eye_R_closed.png",
    "mouth_closed.png", "mouth_A.png", "mouth_E.png", "mouth_I.png",
    "mouth_O.png", "mouth_U.png",
]
MOUTH_KEYS = ("closed", "A", "E", "I", "O", "U")
# Derivable via scripts/derive_sprites.py; absent optional sprites degrade at load.
OPTIONAL_MOUTHS = ("smile",)


def eye_key_for_user_side(user_side: str, mirror: bool) -> str:
    """Map the USER's anatomical eye ('left'/'right') to a sprite side ('L'/'R').

    mirror=True (default): mirror-like control — the user's left eye drives the
    sprite on the viewer-left of the canvas. mirror=False: anatomical mapping.
    """
    if user_side not in ("left", "right"):
        raise ValueError(f"user_side must be 'left' or 'right', got {user_side!r}")
    same = "L" if user_side == "left" else "R"
    swap = "R" if user_side == "left" else "L"
    return same if mirror else swap


class Hysteresis:
    """Two-threshold open/closed switch to prevent blink flicker."""

    def __init__(self, close_threshold: float, open_threshold: float) -> None:
        assert close_threshold > open_threshold
        self.close_th = close_threshold
        self.open_th = open_threshold
        self.closed = False

    def update(self, value: float) -> bool:
        if not self.closed and value >= self.close_th:
            self.closed = True
        elif self.closed and value <= self.open_th:
            self.closed = False
        return self.closed


class TriStateEye:
    """open / half / closed with independent hysteresis bands (no flicker at either edge)."""

    def __init__(self, eyes_cfg: dict) -> None:
        self.full = Hysteresis(eyes_cfg["close_threshold"], eyes_cfg["open_threshold"])
        self.half = Hysteresis(eyes_cfg["half_close_threshold"], eyes_cfg["half_open_threshold"])

    def update(self, value: float) -> str:
        full_closed = self.full.update(value)
        half_closed = self.half.update(value)
        return "closed" if full_closed else ("half" if half_closed else "open")


class Ema:
    def __init__(self, alpha: float) -> None:
        self.alpha = alpha
        self.value: float | None = None

    def update(self, x: float) -> float:
        self.value = x if self.value is None else self.alpha * x + (1 - self.alpha) * self.value
        return self.value


class OneEuro:
    """Speed-adaptive lowpass (Casiez et al. 2012): unlike a fixed-alpha EMA it
    smooths hard at rest (low jitter) yet follows fast motion almost without lag
    — the cutoff rises with the signal's own speed."""

    def __init__(self, min_cutoff: float, beta: float, d_cutoff: float = 1.0) -> None:
        self.min_cutoff, self.beta, self.d_cutoff = min_cutoff, beta, d_cutoff
        self._x: float | None = None
        self._dx = 0.0
        self._t: float | None = None

    @staticmethod
    def _alpha(cutoff: float, dt: float) -> float:
        tau = 1.0 / (2.0 * np.pi * cutoff)
        return 1.0 / (1.0 + tau / dt)

    def update(self, x: float, t: float) -> float:
        """t in seconds, strictly increasing; same-or-earlier t resets the state."""
        if self._t is None or t <= self._t:
            self._x, self._dx, self._t = x, 0.0, t
            return x
        dt = t - self._t
        self._t = t
        a_d = self._alpha(self.d_cutoff, dt)
        self._dx = a_d * ((x - self._x) / dt) + (1 - a_d) * self._dx
        a = self._alpha(self.min_cutoff + self.beta * abs(self._dx), dt)
        self._x = a * x + (1 - a) * self._x
        return self._x


def gaze_to_shift(gaze_left: float, gaze_up: float, range_px: int, mirror: bool) -> tuple[int, int]:
    """Map user-perspective gaze (each in [-1, 1]) to a pupil pixel shift.

    Mirror-like control: user looks to THEIR left -> pupils move viewer-left (-x).
    Vertical travel is naturally shorter than horizontal, hence the 0.6 factor.
    """
    sign = -1 if mirror else 1
    dx = int(round(sign * gaze_left * range_px))
    dy = int(round(-gaze_up * range_px * 0.6))
    return max(-range_px, min(range_px, dx)), max(-range_px, min(range_px, dy))


def pick_mouth(blend: dict[str, float], mouth_cfg: dict) -> str:
    """Select a mouth sprite key from calibrated blendshape values."""
    jaw = blend.get("jawOpen", 0.0)
    pucker = blend.get("mouthPucker", 0.0)
    funnel = blend.get("mouthFunnel", 0.0)
    smile = (blend.get("mouthSmileLeft", 0.0) + blend.get("mouthSmileRight", 0.0)) / 2

    if jaw < mouth_cfg["jaw_closed"]:
        if smile >= mouth_cfg["smile_threshold"]:
            return "smile"  # resolves to the closed overlay at load if the sprite is absent
        return "closed"
    if pucker >= mouth_cfg["pucker_threshold"]:
        return "O" if jaw >= mouth_cfg["jaw_mid"] else "U"
    if funnel >= mouth_cfg["funnel_threshold"]:
        return "O"
    if jaw >= mouth_cfg["jaw_large"]:
        return "A"
    if jaw >= mouth_cfg["jaw_mid"]:
        return "E"
    return "I"


class SpriteCharacter:
    def __init__(self, char_dir: str | Path) -> None:
        d = Path(char_dir)
        missing = [f for f in EXPECTED if not (d / f).exists()]
        if missing:
            raise FileNotFoundError(
                f"missing sprites in {d}: {missing} — place them there; artwork is never auto-generated"
            )
        base_rgba = self._load(d / "base.png")
        # Flatten base onto white paper once; overlays stay RGBA.
        alpha = base_rgba[:, :, 3:4].astype(np.float32) / 255.0
        self.base = (base_rgba[:, :, :3].astype(np.float32) * alpha + 255.0 * (1 - alpha)).astype(np.float32)
        self.h, self.w = self.base.shape[:2]

        # Optional sprites resolve to a fallback ONCE at load (absence is reported
        # here; artwork is never fabricated) so compose() stays branch-light.
        self.eyes = {}
        for side in ("L", "R"):
            states = {state: self._overlay(d / f"eye_{side}_{state}.png") for state in ("open", "closed")}
            states["half"] = self._optional(d / f"eye_{side}_half.png", states["open"])
            self.eyes[side] = states
        self.mouths = {k: self._overlay(d / f"mouth_{k}.png") for k in MOUTH_KEYS}
        for k in OPTIONAL_MOUTHS:
            self.mouths[k] = self._optional(d / f"mouth_{k}.png", self.mouths["closed"])
        self._cache: dict[tuple[str, str, str], np.ndarray] = {}

        # Manifest-driven micro-motion overlays: brows (vertical offset) and
        # pupils (gaze shift). Disabled when range is 0 or artwork is absent.
        mf_path = d / "manifest.json"
        mf = json.loads(mf_path.read_text(encoding="utf-8")) if mf_path.exists() else {}
        self.pupil_range = int(mf.get("pupilRange", 0))
        self.brow_range = int(mf.get("browRange", 0))
        self.pupils = self._roi_overlays(d, "pupil") if self.pupil_range > 0 else {}
        self.brows = self._roi_overlays(d, "brow") if self.brow_range > 0 else {}

    def _optional(self, path: Path, fallback: tuple[np.ndarray, np.ndarray]) -> tuple[np.ndarray, np.ndarray]:
        if path.exists():
            return self._overlay(path)
        log.info("optional sprite not present, degrading gracefully: %s", path.name)
        return fallback

    def _roi_overlays(self, d: Path, prefix: str) -> dict[str, tuple]:
        """Load {prefix}_L/R.png cropped to content bbox for cheap shifted blits."""
        out = {}
        for side in ("L", "R"):
            p = d / f"{prefix}_{side}.png"
            if not p.exists():
                log.info("optional sprite not present, %s motion disabled for side %s", prefix, side)
                continue
            img = self._load(p)
            ys, xs = np.where(img[:, :, 3] > 0)
            if not len(ys):
                continue
            crop = img[ys.min():ys.max() + 1, xs.min():xs.max() + 1]
            a = crop[:, :, 3:4].astype(np.float32) / 255.0
            out[side] = (crop[:, :, :3].astype(np.float32) * a, 1.0 - a, (int(xs.min()), int(ys.min())))
        return out

    def _load(self, path: Path) -> np.ndarray:
        img = cv2.imread(str(path), cv2.IMREAD_UNCHANGED)
        if img is None:
            raise FileNotFoundError(path)
        if img.shape[2] == 3:
            img = cv2.cvtColor(img, cv2.COLOR_BGR2BGRA)
        return img

    def _overlay(self, path: Path) -> tuple[np.ndarray, np.ndarray]:
        """Precompute (premultiplied rgb, 1-alpha) float32 for fast alpha-over."""
        img = self._load(path)
        a = img[:, :, 3:4].astype(np.float32) / 255.0
        return img[:, :, :3].astype(np.float32) * a, 1.0 - a

    def compose(self, eye_l: str, eye_r: str, mouth: str) -> np.ndarray:
        """eye_l/eye_r: 'open'|'half'|'closed'; mouth: a key present in self.mouths.

        Results are memoized per state tuple (≤72 combinations); callers must not
        mutate the returned array.
        """
        key = (eye_l, eye_r, mouth)
        cached = self._cache.get(key)
        if cached is None:
            out = self.base.copy()
            for premul, inv_a in (self.eyes["L"][eye_l], self.eyes["R"][eye_r], self.mouths[mouth]):
                out *= inv_a
                out += premul
            cached = self._cache[key] = out.astype(np.uint8)  # BGR
        return cached

    def render(self, eye_l: str, eye_r: str, mouth: str,
               brow_dy: dict[str, int], pupil_shift: tuple[int, int]) -> np.ndarray:
        """Memoized state composite + per-frame brow/pupil overlays (if enabled)."""
        out = self.compose(eye_l, eye_r, mouth)
        if not self.brows and not self.pupils:
            return out
        out = out.copy()
        eye_state = {"L": eye_l, "R": eye_r}
        for side, ov in self.brows.items():
            self._blit(out, ov, 0, brow_dy.get(side, 0))
        for side, ov in self.pupils.items():
            if eye_state[side] == "open":  # closed/half lids hide the pupil
                self._blit(out, ov, *pupil_shift)
        return out

    @staticmethod
    def _blit(out: np.ndarray, ov: tuple, dx: int, dy: int) -> None:
        """Alpha-blend a content-cropped overlay at its home position + (dx, dy)."""
        premul, inv_a, (x0, y0) = ov
        h, w = premul.shape[:2]
        big_h, big_w = out.shape[:2]
        x, y = x0 + dx, y0 + dy
        sx, sy = max(0, -x), max(0, -y)
        x, y = max(0, x), max(0, y)
        ex, ey = min(big_w, x + w - sx), min(big_h, y + h - sy)
        if ex <= x or ey <= y:
            return
        p = premul[sy:sy + ey - y, sx:sx + ex - x]
        ia = inv_a[sy:sy + ey - y, sx:sx + ex - x]
        roi = out[y:ey, x:ex].astype(np.float32)
        out[y:ey, x:ex] = (roi * ia + p).astype(np.uint8)


def apply_head_transform(img: np.ndarray, yaw: float, pitch: float, roll: float, head_cfg: dict) -> np.ndarray:
    """Cheap 2.5D head motion: canvas rotation for roll, translation for yaw/pitch."""
    h, w = img.shape[:2]
    max_shift = head_cfg["max_shift_px"]
    dx = float(np.clip(yaw * head_cfg["yaw_gain_px"], -max_shift, max_shift))
    dy = float(np.clip(pitch * head_cfg["pitch_gain_px"], -max_shift, max_shift))
    angle = float(np.clip(roll * head_cfg["roll_gain"], -head_cfg["max_roll_deg"], head_cfg["max_roll_deg"]))
    m = cv2.getRotationMatrix2D((w / 2, h / 2), angle, 1.0)
    m[0, 2] += dx
    m[1, 2] += dy
    return cv2.warpAffine(img, m, (w, h), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
