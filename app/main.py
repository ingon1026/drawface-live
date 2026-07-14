"""DrawFace Live — Phase 5 sprite fallback entry point.

python -m app.main [--config configs/app.yaml] [--camera N] [--character DIR]
                   [--no-preview] [--no-debug-overlay]

Keys: q/ESC quit · c recalibrate neutral · m toggle mirror control
"""
from __future__ import annotations

import argparse
import logging
import time
import tkinter as tk
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
    gaze_to_shift,
    pick_mouth,
)

log = logging.getLogger("drawface")

SMOOTH_KEYS = (
    "eyeBlinkLeft", "eyeBlinkRight", "jawOpen",
    "mouthSmileLeft", "mouthSmileRight", "mouthPucker", "mouthFunnel",
    # brow offset + gaze channels (used only when the character enables them)
    "browInnerUp", "browDownLeft", "browDownRight", "browOuterUpLeft", "browOuterUpRight",
    "eyeLookInLeft", "eyeLookInRight", "eyeLookOutLeft", "eyeLookOutRight",
    "eyeLookUpLeft", "eyeLookUpRight", "eyeLookDownLeft", "eyeLookDownRight",
)


class TkDisplay:
    """Render frames in a Tk window.

    cv2.imshow (Qt/XCB shared-memory path) bus-errors under some WSLg states;
    Tk uses plain X11 image puts and keeps working, so the video is shown via
    tk.PhotoImage instead. Runs on the main thread with update() per frame.
    """

    def __init__(self, title: str) -> None:
        self.root = tk.Tk()
        self.root.title(title)
        self.label = tk.Label(self.root)
        self.label.pack()
        self._key: str | None = None
        self._closed = False
        self.root.bind("<Key>", self._on_key)
        self.root.protocol("WM_DELETE_WINDOW", self._on_close)
        self.root.attributes("-topmost", True)
        self.root.after(1500, lambda: self.root.attributes("-topmost", False))

    def _on_key(self, event: tk.Event) -> None:
        self._key = event.keysym.lower()

    def _on_close(self) -> None:
        self._closed = True

    def show(self, frame_bgr: np.ndarray) -> str | None:
        """Display a BGR frame; return 'quit', a pressed key, or None."""
        rgb = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2RGB)
        h, w = rgb.shape[:2]
        self._img = tk.PhotoImage(data=b"P6 %d %d 255\n" % (w, h) + rgb.tobytes())
        self.label.configure(image=self._img)
        try:
            self.root.update()
        except tk.TclError:
            self._closed = True
        key, self._key = self._key, None
        if self._closed or key in ("q", "escape"):
            return "quit"
        return key

    def destroy(self) -> None:
        try:
            self.root.destroy()
        except tk.TclError:
            pass


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
    ap.add_argument("--mirror", choices=("on", "off"), default=None,
                    help="override control.mirror from the config")
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

    mirror = cfg["control"]["mirror"] if args.mirror is None else args.mirror == "on"
    blink_alpha = cfg["smoothing"].get("blink_alpha", cfg["smoothing"]["blend_alpha"])
    emas = {k: Ema(blink_alpha if k.startswith("eyeBlink") else cfg["smoothing"]["blend_alpha"])
            for k in SMOOTH_KEYS}
    head_emas = {k: Ema(cfg["smoothing"]["head_alpha"]) for k in ("yaw", "pitch", "roll")}
    hyst = {side: TriStateEye(cfg["eyes"]) for side in ("left", "right")}  # keyed by USER side
    calib = Calibration(cfg["calibration"]["frames"])

    smoothed: dict[str, float] = {k: 0.0 for k in SMOOTH_KEYS}
    head = {"yaw": 0.0, "pitch": 0.0, "roll": 0.0}
    fps = 0.0
    t0 = t_prev = last_seen = time.monotonic()

    display = TkDisplay("DrawFace Live")

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
            brow_dy = {}     # sprite side -> vertical brow offset in px (up = negative)
            for user_side in ("left", "right"):
                sprite_side = eye_key_for_user_side(user_side, mirror)
                eye_states[sprite_side] = hyst[user_side].update(smoothed[f"eyeBlink{user_side.capitalize()}"])
                s = user_side.capitalize()
                raise_amt = 0.5 * smoothed["browInnerUp"] + 0.5 * smoothed[f"browOuterUp{s}"] \
                    - smoothed[f"browDown{s}"]
                brow_dy[sprite_side] = -int(round(max(-1.0, min(1.0, raise_amt)) * character.brow_range))
            mouth = pick_mouth(smoothed, cfg["mouth"])
            gaze_left = (smoothed["eyeLookOutLeft"] + smoothed["eyeLookInRight"]
                         - smoothed["eyeLookInLeft"] - smoothed["eyeLookOutRight"]) / 2
            gaze_up = (smoothed["eyeLookUpLeft"] + smoothed["eyeLookUpRight"]
                       - smoothed["eyeLookDownLeft"] - smoothed["eyeLookDownRight"]) / 2
            # Closing lids inflates eyeLookDown — damp gaze while a blink is engaged
            # so pupils don't dive right before the eye state flips to closed.
            lid = max(smoothed["eyeBlinkLeft"], smoothed["eyeBlinkRight"])
            damp = max(0.0, 1.0 - 2.0 * lid)
            pupil_shift = gaze_to_shift(gaze_left * damp, gaze_up * damp, character.pupil_range, mirror)

            out = character.render(eye_states["L"], eye_states["R"], mouth, brow_dy, pupil_shift)
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

            key = display.show(out)
            if key == "quit":
                break
            if key == "c":
                calib.restart()
            if key == "m":
                mirror = not mirror
                log.info("mirror control: %s", mirror)
    finally:
        camera.release()
        tracker.close()
        display.destroy()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
