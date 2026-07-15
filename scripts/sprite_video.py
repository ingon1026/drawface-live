"""Offline sprite pipeline: drive a character with a face VIDEO -> output video.

The comparison twin of the FLP offline path (run.py --dri_video <clip>): same
source + same driving clip, rendered by the deterministic sprite method instead
of neural warping.

    PYTHONPATH=. .venv/bin/python scripts/sprite_video.py \
        --character assets/sprites/<name> --driving clip.mp4 --out sprite_out.mp4

Uses the same config/state machines as app/main.py (no camera, no display).
"""
from __future__ import annotations

import argparse
from pathlib import Path

import cv2

from app.config import load_config
from app.face_tracker import FaceTracker
from app.main import SMOOTH_KEYS, Calibration
from app.sprite_backend import (
    Ema, SpriteCharacter, TriStateEye,
    apply_head_transform, eye_key_for_user_side, pick_mouth,
)

ROOT = Path(__file__).resolve().parents[1]


def main() -> int:
    ap = argparse.ArgumentParser(description="render a character following a driving face video")
    ap.add_argument("--character", required=True)
    ap.add_argument("--driving", required=True, help="driving face video (webcam clip)")
    ap.add_argument("--out", required=True, help="output mp4")
    ap.add_argument("--config", default=str(ROOT / "configs" / "app.yaml"))
    ap.add_argument("--mirror", choices=("on", "off"), default="on")
    args = ap.parse_args()

    cfg = load_config(args.config)
    character = SpriteCharacter(args.character)
    tracker = FaceTracker(cfg["tracker"]["model"])
    mirror = args.mirror == "on"

    cap = cv2.VideoCapture(args.driving)
    if not cap.isOpened():
        ap.error(f"cannot open driving video: {args.driving}")
    fps = cap.get(cv2.CAP_PROP_FPS) or 25.0
    writer = cv2.VideoWriter(args.out, cv2.VideoWriter_fourcc(*"mp4v"), fps, (512, 512))

    blink_alpha = cfg["smoothing"].get("blink_alpha", cfg["smoothing"]["blend_alpha"])
    emas = {k: Ema(blink_alpha if k.startswith("eyeBlink") else cfg["smoothing"]["blend_alpha"])
            for k in SMOOTH_KEYS}
    head_emas = {k: Ema(cfg["smoothing"]["head_alpha"]) for k in ("yaw", "pitch", "roll")}
    hyst = {side: TriStateEye(cfg["eyes"]) for side in ("left", "right")}
    calib = Calibration(cfg["calibration"]["frames"])
    smoothed = {k: 0.0 for k in SMOOTH_KEYS}
    head = {"yaw": 0.0, "pitch": 0.0, "roll": 0.0}

    ts, n = 0, 0
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        ts += int(1000 / fps)
        obs = tracker.process(frame, ts)
        if obs is not None:
            if calib.active:
                calib.feed(obs.blend)
            else:
                values = calib.apply(obs.blend)
                smoothed = {k: emas[k].update(v) for k, v in values.items()}
                head = {k: head_emas[k].update(getattr(obs, k)) for k in head_emas}

        eyes = {}
        for user_side in ("left", "right"):
            sprite_side = eye_key_for_user_side(user_side, mirror)
            eyes[sprite_side] = hyst[user_side].update(smoothed[f"eyeBlink{user_side.capitalize()}"])
        mouth = pick_mouth(smoothed, cfg["mouth"])
        out = character.render(eyes["L"], eyes["R"], mouth, {}, (0, 0))
        out = apply_head_transform(out, head["yaw"], head["pitch"], head["roll"], cfg["head"])
        writer.write(out)
        n += 1

    cap.release()
    writer.release()
    tracker.close()
    print(f"wrote {args.out} ({n} frames @ {fps:.0f}fps)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
