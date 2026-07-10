from pathlib import Path

import pytest

from app.config import load_config

ROOT = Path(__file__).resolve().parents[1]


def test_app_yaml_loads_and_is_complete():
    cfg = load_config(ROOT / "configs" / "app.yaml")
    assert cfg["eyes"]["close_threshold"] > cfg["eyes"]["open_threshold"]
    assert cfg["mouth"]["jaw_closed"] < cfg["mouth"]["jaw_mid"] < cfg["mouth"]["jaw_large"]
    assert cfg["calibration"]["frames"] > 0
    assert isinstance(cfg["control"]["mirror"], bool)


def test_missing_section_rejected(tmp_path):
    p = tmp_path / "bad.yaml"
    p.write_text("camera: {index: 0}\n")
    with pytest.raises(ValueError, match="missing sections"):
        load_config(p)


def test_broken_hysteresis_rejected(tmp_path):
    src = (ROOT / "configs" / "app.yaml").read_text()
    p = tmp_path / "bad.yaml"
    p.write_text(src.replace("close_threshold: 0.45", "close_threshold: 0.1"))
    with pytest.raises(ValueError, match="hysteresis"):
        load_config(p)
