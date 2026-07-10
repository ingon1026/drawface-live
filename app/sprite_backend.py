"""Deterministic sprite backend: blendshapes -> sprite states -> composite.

Sprites are 512x512 full-canvas RGBA overlays aligned to base.png
(assets/sprites/<char>/). Composite = base + eye_L_* + eye_R_* + mouth_*.
Sprite keys 'L'/'R' mean VIEWER-left/right on the canvas.
"""
from __future__ import annotations

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

    def _optional(self, path: Path, fallback: tuple[np.ndarray, np.ndarray]) -> tuple[np.ndarray, np.ndarray]:
        if path.exists():
            return self._overlay(path)
        log.info("optional sprite not present, degrading gracefully: %s", path.name)
        return fallback

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
