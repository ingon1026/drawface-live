"""DrawFace Live — Phase 5 sprite fallback entry point.

python -m app.main [--config configs/app.yaml] [--camera N] [--character DIR]
                   [--no-preview] [--no-debug-overlay]

Keys: q/ESC quit · c recalibrate neutral · m toggle mirror control
"""
from __future__ import annotations

import argparse
import logging
import time
from pathlib import Path

import cv2
import numpy as np

from app.camera import LatestFrameCamera
from app.config import load_config
from app.face_tracker import FaceTracker, Observation
from app.sprite_backend import (
    Ema,
    SpriteCharacter,
    TriStateEye,
    apply_head_transform,
    eye_key_for_user_side,
    pick_mouth,
)

log = logging.getLogger("drawface")

SMOOTH_KEYS = (
    "eyeBlinkLeft", "eyeBlinkRight", "jawOpen",
    "mouthSmileLeft", "mouthSmileRight", "mouthPucker", "mouthFunnel",
)


class Calibration:
    """Neutral-pose baseline: calibrated = max(0, raw - neutral) / (1 - neutral)."""

    def __init__(self, n_frames: int) -> None:
        self.n_frames = n_frames
        self.samples: list[dict[str, float]] = []
        self.neutral: dict[str, float] = {}

    @property
    def active(self) -> bool:
        return len(self.samples) < self.n_frames

    def feed(self, blend: dict[str, float]) -> None:
        self.samples.append(blend)
        if not self.active:
            self.neutral = {
                k: float(np.median([s.get(k, 0.0) for s in self.samples])) for k in SMOOTH_KEYS
            }
            log.info("neutral calibrated: %s", {k: round(v, 3) for k, v in self.neutral.items()})

    def apply(self, blend: dict[str, float]) -> dict[str, float]:
        out = {}
        for k in SMOOTH_KEYS:
            n = self.neutral.get(k, 0.0)
            out[k] = max(0.0, blend.get(k, 0.0) - n) / max(0.2, 1.0 - n)
        return out

    def restart(self) -> None:
        self.samples.clear()
        self.neutral.clear()


VIZ_BARS = (
    ("eyeL", "eyeBlinkLeft"), ("eyeR", "eyeBlinkRight"), ("jaw", "jawOpen"),
    ("smile", "mouthSmileLeft"), ("pucker", "mouthPucker"),
)


def draw_tracking_viz(preview: np.ndarray, obs: Observation | None, smoothed: dict[str, float]) -> None:
    """Overlay the tracking process on the mirrored preview: landmark mesh + signal bars."""
    h, w = preview.shape[:2]
    if obs is not None and obs.landmarks is not None:
        # preview is mirrored, so mirror x too
        xs = ((1 - obs.landmarks[:, 0]) * w).astype(int)
        ys = (obs.landmarks[:, 1] * h).astype(int)
        m = (xs >= 0) & (xs < w) & (ys >= 0) & (ys < h)
        preview[ys[m], xs[m]] = (80, 255, 120)
    y0 = h - 14 * len(VIZ_BARS) - 8
    for i, (label, key) in enumerate(VIZ_BARS):
        y = y0 + 14 * i
        v = smoothed.get(key, 0.0)
        cv2.putText(preview, label, (6, y + 9), cv2.FONT_HERSHEY_SIMPLEX, 0.35, (255, 255, 255), 1, cv2.LINE_AA)
        cv2.rectangle(preview, (58, y), (58 + 80, y + 10), (70, 70, 70), 1)
        cv2.rectangle(preview, (58, y), (58 + int(80 * min(v, 1.0)), y + 10), (80, 255, 120), -1)


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
    ap = argparse.ArgumentParser(description="DrawFace Live sprite fallback")
    ap.add_argument("--config", default="configs/app.yaml")
    ap.add_argument("--camera", type=int, default=None, help="override camera index")
    ap.add_argument("--character", default=None, help="override character sprite dir")
    ap.add_argument("--no-preview", action="store_true", help="hide the mirrored webcam preview pane")
    ap.add_argument("--no-debug-overlay", action="store_true")
    args = ap.parse_args()

    cfg = load_config(args.config)
    cam_index = args.camera if args.camera is not None else cfg["camera"]["index"]
    char_dir = args.character or cfg["character"]["dir"]
    model_path = cfg["tracker"]["model"]
    for p, hint in ((char_dir, "scripts/setup.sh copies the pig set"),
                    (model_path, "scripts/setup.sh downloads the model")):
        if not Path(p).exists():
            ap.error(f"not found: {p} ({hint})")

    character = SpriteCharacter(char_dir)
    tracker = FaceTracker(model_path)
    camera = LatestFrameCamera(cam_index, cfg["camera"]["width"], cfg["camera"]["height"])

    mirror = bool(cfg["control"]["mirror"])
    emas = {k: Ema(cfg["smoothing"]["blend_alpha"]) for k in SMOOTH_KEYS}
    head_emas = {k: Ema(cfg["smoothing"]["head_alpha"]) for k in ("yaw", "pitch", "roll")}
    hyst = {side: TriStateEye(cfg["eyes"]) for side in ("left", "right")}  # keyed by USER side
    calib = Calibration(cfg["calibration"]["frames"])

    smoothed: dict[str, float] = {k: 0.0 for k in SMOOTH_KEYS}
    head = {"yaw": 0.0, "pitch": 0.0, "roll": 0.0}
    fps = 0.0
    t0 = t_prev = last_seen = time.monotonic()

    try:
        while True:
            ok, frame = camera.read()
            if not ok:
                log.error("camera read failed")
                break
            now = time.monotonic()
            obs: Observation | None = tracker.process(frame, int((now - t0) * 1000))

            if obs is not None:
                last_seen = now
                if calib.active:
                    calib.feed(obs.blend)
                else:
                    values = calib.apply(obs.blend)
                    smoothed = {k: emas[k].update(v) for k, v in values.items()}
                    head = {k: head_emas[k].update(getattr(obs, k)) for k in head_emas}
            else:
                lost_for = (now - last_seen) * 1000
                if lost_for > cfg["lost_face"]["hold_ms"]:
                    # ease everything back to neutral
                    decay = min(1.0, (lost_for - cfg["lost_face"]["hold_ms"]) / cfg["lost_face"]["decay_ms"])
                    smoothed = {k: v * (1 - decay) for k, v in smoothed.items()}
                    head = {k: v * (1 - decay) for k, v in head.items()}

            eye_states = {}  # sprite side -> 'open' | 'half' | 'closed'
            for user_side in ("left", "right"):
                sprite_side = eye_key_for_user_side(user_side, mirror)
                eye_states[sprite_side] = hyst[user_side].update(smoothed[f"eyeBlink{user_side.capitalize()}"])
            mouth = pick_mouth(smoothed, cfg["mouth"])

            out = character.compose(eye_states["L"], eye_states["R"], mouth)
            out = apply_head_transform(out, head["yaw"], head["pitch"], head["roll"], cfg["head"])

            dt, t_prev = time.monotonic() - t_prev, time.monotonic()
            fps = 0.9 * fps + 0.1 * (1.0 / max(dt, 1e-6))

            if not args.no_debug_overlay:
                status = "CALIBRATING: look straight, neutral face" if calib.active else (
                    f"L:{eye_states['L']} R:{eye_states['R']} "
                    f"mouth:{mouth} yaw:{head['yaw']:+.0f} pitch:{head['pitch']:+.0f} roll:{head['roll']:+.0f}"
                )
                face = "face:OK" if obs is not None else "face:LOST"
                for i, txt in enumerate((f"{fps:5.1f} FPS  sprite/mediapipe  {face}  mirror:{mirror}", status)):
                    cv2.putText(out, txt, (8, 20 + 22 * i), cv2.FONT_HERSHEY_SIMPLEX, 0.5,
                                (30, 30, 30), 1, cv2.LINE_AA)

            if not args.no_preview:
                preview = cv2.flip(frame, 1)  # mirror ONLY the user-facing preview
                ph = out.shape[0]
                preview = cv2.resize(preview, (int(preview.shape[1] * ph / preview.shape[0]), ph))
                if not args.no_debug_overlay:
                    draw_tracking_viz(preview, obs, smoothed)
                out = np.hstack([preview, out])

            cv2.imshow("DrawFace Live", out)
            key = cv2.waitKey(1) & 0xFF
            if key in (ord("q"), 27):
                break
            if key == ord("c"):
                calib.restart()
            if key == ord("m"):
                mirror = not mirror
                log.info("mirror control: %s", mirror)
    finally:
        camera.release()
        tracker.close()
        cv2.destroyAllWindows()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
