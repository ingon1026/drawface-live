"""MediaPipe Face Landmarker wrapper: blendshapes + head pose (yaw/pitch/roll)."""
from __future__ import annotations

import math
from dataclasses import dataclass, field

import cv2
import numpy as np
from mediapipe import Image, ImageFormat
from mediapipe.tasks.python import BaseOptions
from mediapipe.tasks.python.vision import (
    FaceLandmarker,
    FaceLandmarkerOptions,
    RunningMode,
)


@dataclass
class Observation:
    blend: dict[str, float] = field(default_factory=dict)
    yaw: float = 0.0    # degrees, + = turn toward user's left
    pitch: float = 0.0  # degrees, + = look up
    roll: float = 0.0   # degrees, + = tilt
    landmarks: np.ndarray | None = None  # (478, 2) normalized xy, for process visualization


class FaceTracker:
    def __init__(self, model_path: str) -> None:
        self._landmarker = FaceLandmarker.create_from_options(FaceLandmarkerOptions(
            base_options=BaseOptions(model_asset_path=model_path),
            running_mode=RunningMode.VIDEO,
            output_face_blendshapes=True,
            output_facial_transformation_matrixes=True,
            num_faces=1,
        ))

    def process(self, frame_bgr: np.ndarray, ts_ms: int) -> Observation | None:
        rgb = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2RGB)
        result = self._landmarker.detect_for_video(Image(image_format=ImageFormat.SRGB, data=rgb), ts_ms)
        if not result.face_blendshapes:
            return None
        obs = Observation(blend={c.category_name: c.score for c in result.face_blendshapes[0]})
        if result.face_landmarks:
            obs.landmarks = np.array([(lm.x, lm.y) for lm in result.face_landmarks[0]], dtype=np.float32)
        if result.facial_transformation_matrixes:
            r = np.asarray(result.facial_transformation_matrixes[0])[:3, :3]
            # Face axes in camera coords; small-angle friendly, signs tunable via head gains.
            obs.yaw = math.degrees(math.atan2(r[0, 2], r[2, 2]))
            obs.pitch = math.degrees(math.asin(np.clip(-r[1, 2], -1.0, 1.0)))
            obs.roll = math.degrees(math.atan2(r[1, 0], r[0, 0]))
        return obs

    def close(self) -> None:
        self._landmarker.close()
