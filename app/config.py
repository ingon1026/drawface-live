"""Load and validate configs/app.yaml."""
from __future__ import annotations

from pathlib import Path
from typing import Any

import yaml

REQUIRED_SECTIONS = (
    "camera", "character", "tracker", "control",
    "smoothing", "eyes", "mouth", "head", "lost_face", "calibration",
)


def load_config(path: str | Path) -> dict[str, Any]:
    cfg = yaml.safe_load(Path(path).read_text(encoding="utf-8"))
    missing = [s for s in REQUIRED_SECTIONS if s not in cfg]
    if missing:
        raise ValueError(f"config missing sections: {missing}")
    eyes = cfg["eyes"]
    if eyes["close_threshold"] <= eyes["open_threshold"]:
        raise ValueError("eyes.close_threshold must be > eyes.open_threshold (hysteresis)")
    return cfg
