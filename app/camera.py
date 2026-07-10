"""Webcam capture that keeps only the latest frame (no growing latency)."""
from __future__ import annotations

import cv2


class LatestFrameCamera:
    def __init__(self, index: int, width: int = 640, height: int = 480) -> None:
        self.cap = cv2.VideoCapture(index, cv2.CAP_V4L2)
        if not self.cap.isOpened():
            raise RuntimeError(
                f"camera index {index} could not be opened — check usbipd attach and "
                f"scripts/probe_camera.sh for the RGB node"
            )
        self.cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
        self.cap.set(cv2.CAP_PROP_FRAME_WIDTH, width)
        self.cap.set(cv2.CAP_PROP_FRAME_HEIGHT, height)

    def read(self):
        """Return (ok, frame). BUFFERSIZE=1 keeps V4L2 from queueing stale frames."""
        return self.cap.read()

    def release(self) -> None:
        self.cap.release()
