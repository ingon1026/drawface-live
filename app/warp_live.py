"""Live ARAP warp mode: webcam expressions drive the drawing itself — no
erase-and-paste sprites, so nothing looks glued on.

    PYTHONPATH=. .venv/bin/python -m app.warp_live --image assets/source/character.png
    PYTHONPATH=. .venv/bin/python -m app.warp_live --character assets/sprites/wave

--image needs a MediaPipe-detectable drawing (flattened; alpha is dropped).
--character takes any onboarded 4-click folder: eye/mouth boxes are recovered
from the sprite alphas and synthesized into landmarks, so scribbles work too.

Offline twin (no camera, no window — verification and A/B clips):

    PYTHONPATH=. .venv/bin/python -m app.warp_live \
        --image <drawing.png> --driving clip.mp4 --out warp_out.mp4
"""
from __future__ import annotations

import argparse
import logging
import sys
import time

import cv2
import numpy as np

from pathlib import Path

from app.camera import LatestFrameCamera
from app.config import load_config
from app.face_tracker import FaceTracker, Observation
from app.main import SMOOTH_KEYS, Calibration, TkDisplay, draw_tracking_viz
from app.sprite_backend import Ema, SpriteCharacter, apply_head_transform, eye_key_for_user_side
from app.warp_rig import WarpRig, landmarks_from_boxes

log = logging.getLogger("warp_live")

# Calibrated blendshapes rarely reach 1.0; gains map a comfortable expression
# to full channel travel. Overridable via the optional `warp:` config section.
DEFAULT_GAINS = {"blink_gain": 2.0, "smile_gain": 2.0, "jaw_gain": 1.6}


def channels(smoothed: dict[str, float], mirror: bool, gains: dict[str, float]) -> dict[str, float]:
    """Map calibrated+smoothed blendshapes to rig channels (rig L = viewer-left)."""
    blink = {}
    for user_side in ("left", "right"):
        rig_side = eye_key_for_user_side(user_side, mirror)
        blink[rig_side] = min(1.0, smoothed[f"eyeBlink{user_side.capitalize()}"] * gains["blink_gain"])
    smile = (smoothed["mouthSmileLeft"] + smoothed["mouthSmileRight"]) / 2
    return {
        "blink_l": blink["L"],
        "blink_r": blink["R"],
        "smile": min(1.0, smile * gains["smile_gain"]),
        "jaw": min(1.0, smoothed["jawOpen"] * gains["jaw_gain"]),
    }


def build_rig(image_path: str, tracker: FaceTracker) -> WarpRig | None:
    img = cv2.imread(image_path)
    if img is None:
        return None
    obs = tracker.process(img, 0)  # ts=0; camera/driving frames start at 1
    if obs is None or obs.landmarks is None:
        return None
    h, w = img.shape[:2]
    return WarpRig(img, obs.landmarks * np.array([w, h], np.float32))


def rig_from_character(char_dir: str) -> WarpRig | None:
    """Warp rig for a 4-click character: no face detection — eye/mouth boxes
    are recovered from the onboarding sprites (full-canvas overlays whose alpha
    bounds ARE the clicked boxes) and turned into synthetic landmarks. The warp
    source is the neutral composite, not the inpainted base."""
    d = Path(char_dir)

    def alpha_box(name: str) -> tuple[float, float, float, float] | None:
        img = cv2.imread(str(d / name), cv2.IMREAD_UNCHANGED)
        if img is None or img.ndim < 3 or img.shape[2] < 4:
            return None
        ys, xs = np.where(img[:, :, 3] > 0)
        if len(xs) == 0:
            return None
        return (float(xs.min()), float(ys.min()), float(xs.max()), float(ys.max()))

    boxes = [alpha_box(n) for n in ("eye_L_open.png", "eye_R_open.png", "mouth_closed.png")]
    if any(b is None for b in boxes):
        return None
    neutral = SpriteCharacter(str(d)).render("open", "open", "closed", {}, (0, 0))
    h, w = neutral.shape[:2]
    lm = landmarks_from_boxes(boxes[0], boxes[1], boxes[2], (w, h))
    return WarpRig(neutral, lm, brow_follow=False)


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
    ap = argparse.ArgumentParser(description="drive a drawing with the ARAP warp rig")
    src = ap.add_mutually_exclusive_group(required=True)
    src.add_argument("--image", help="character drawing (flattened, MediaPipe-detectable face)")
    src.add_argument("--character", help="onboarded character dir (4-click scribbles work here)")
    ap.add_argument("--config", default="configs/app.yaml")
    ap.add_argument("--camera", type=int, default=None, help="override camera index")
    ap.add_argument("--mirror", choices=("on", "off"), default=None)
    ap.add_argument("--no-preview", action="store_true")
    ap.add_argument("--no-debug-overlay", action="store_true")
    ap.add_argument("--driving", default=None, help="drive from a face video instead of the camera")
    ap.add_argument("--out", default=None, help="output mp4 (driving mode)")
    args = ap.parse_args()
    if args.driving and not args.out:
        ap.error("--driving requires --out")

    cfg = load_config(args.config)
    gains = {**DEFAULT_GAINS, **cfg.get("warp", {})}
    mirror = cfg["control"]["mirror"] if args.mirror is None else args.mirror == "on"

    tracker = FaceTracker(cfg["tracker"]["model"])
    if args.character:
        rig = rig_from_character(args.character)
        problem = f"{args.character} is missing onboarding sprites (eye_L_open/eye_R_open/mouth_closed)"
    else:
        rig = build_rig(args.image, tracker)
        problem = f"{args.image} is unreadable or has no MediaPipe-detectable face (use --character for scribbles)"
    if rig is None:
        print(f"cannot build rig: {problem}", file=sys.stderr)
        tracker.close()
        return 1

    blink_alpha = cfg["smoothing"].get("blink_alpha", cfg["smoothing"]["blend_alpha"])
    emas = {k: Ema(blink_alpha if k.startswith("eyeBlink") else cfg["smoothing"]["blend_alpha"])
            for k in SMOOTH_KEYS}
    head_emas = {k: Ema(cfg["smoothing"]["head_alpha"]) for k in ("yaw", "pitch", "roll")}
    calib = Calibration(cfg["calibration"]["frames"])
    smoothed = {k: 0.0 for k in SMOOTH_KEYS}
    head = {"yaw": 0.0, "pitch": 0.0, "roll": 0.0}

    def step(frame: np.ndarray, ts_ms: int, obs_holder: list) -> np.ndarray:
        nonlocal smoothed, head
        obs = tracker.process(frame, ts_ms)
        obs_holder[:] = [obs]
        if obs is not None:
            if calib.active:
                calib.feed(obs.blend)
            else:
                values = calib.apply(obs.blend)
                smoothed = {k: emas[k].update(v) for k, v in values.items()}
                head = {k: head_emas[k].update(getattr(obs, k)) for k in head_emas}
        ch = channels(smoothed, mirror, gains)
        out = rig.render(**ch)
        out = apply_head_transform(out, head["yaw"], head["pitch"], head["roll"], cfg["head"])
        if not args.no_debug_overlay:
            face = "face:OK" if obs is not None else "face:LOST"
            state = "CALIBRATING" if calib.active else " ".join(f"{k}:{v:.2f}" for k, v in ch.items())
            for i, txt in enumerate((f"warp/ARAP  {face}  mirror:{mirror}", state)):
                cv2.putText(out, txt, (8, 20 + 22 * i), cv2.FONT_HERSHEY_SIMPLEX, 0.5,
                            (30, 30, 30), 1, cv2.LINE_AA)
        return out

    if args.driving:
        cap = cv2.VideoCapture(args.driving)
        if not cap.isOpened():
            ap.error(f"cannot open driving video: {args.driving}")
        fps = cap.get(cv2.CAP_PROP_FPS) or 25.0
        h, w = rig._img.shape[:2]
        writer = cv2.VideoWriter(args.out, cv2.VideoWriter_fourcc(*"mp4v"), fps, (w, h))
        ts, n = 0, 0
        holder: list = []
        while True:
            ok, frame = cap.read()
            if not ok:
                break
            ts += max(1, int(1000 / fps))
            writer.write(step(frame, ts, holder))
            n += 1
        cap.release()
        writer.release()
        tracker.close()
        print(f"wrote {args.out} ({n} frames @ {fps:.0f}fps)")
        return 0

    cam_index = args.camera if args.camera is not None else cfg["camera"]["index"]
    camera = LatestFrameCamera(cam_index, cfg["camera"]["width"], cfg["camera"]["height"])
    display = TkDisplay("DrawFace Live — warp")
    fps = 0.0
    t0 = t_prev = last_seen = time.monotonic()
    holder = []
    try:
        while True:
            ok, frame = camera.read()
            if not ok:
                log.error("camera read failed")
                break
            now = time.monotonic()
            out = step(frame, int((now - t0) * 1000) + 1, holder)
            obs: Observation | None = holder[0]
            if obs is not None:
                last_seen = now
            else:
                lost_for = (now - last_seen) * 1000
                if lost_for > cfg["lost_face"]["hold_ms"]:
                    decay = min(1.0, (lost_for - cfg["lost_face"]["hold_ms"]) / cfg["lost_face"]["decay_ms"])
                    smoothed = {k: v * (1 - decay) for k, v in smoothed.items()}
                    head = {k: v * (1 - decay) for k, v in head.items()}

            dt, t_prev = time.monotonic() - t_prev, time.monotonic()
            fps = 0.9 * fps + 0.1 * (1.0 / max(dt, 1e-6))
            if not args.no_debug_overlay:
                cv2.putText(out, f"{fps:5.1f} FPS", (8, out.shape[0] - 10),
                            cv2.FONT_HERSHEY_SIMPLEX, 0.5, (30, 30, 30), 1, cv2.LINE_AA)

            if not args.no_preview:
                preview = cv2.flip(frame, 1)
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
