"""Semantic left/right mapping and blink stability (CLAUDE.md §6 Phase 5 requirement:
the mirrored preview must never swap semantic wink control)."""

import pytest

from app.sprite_backend import Hysteresis, eye_key_for_user_side, pick_mouth

MOUTH_CFG = {
    "jaw_closed": 0.06, "jaw_mid": 0.16, "jaw_large": 0.32,
    "pucker_threshold": 0.40, "funnel_threshold": 0.35,
    "smile_threshold": 0.30, "smile_sprite": "E",
}


def test_mirror_mapping_user_left_drives_viewer_left():
    # Mirror-like control (default): user's LEFT eye -> sprite 'L' (viewer-left).
    assert eye_key_for_user_side("left", mirror=True) == "L"
    assert eye_key_for_user_side("right", mirror=True) == "R"


def test_anatomical_mapping_swaps_sides():
    assert eye_key_for_user_side("left", mirror=False) == "R"
    assert eye_key_for_user_side("right", mirror=False) == "L"


def test_mapping_is_exclusive_both_modes():
    for mirror in (True, False):
        sides = {eye_key_for_user_side(s, mirror) for s in ("left", "right")}
        assert sides == {"L", "R"}


def test_invalid_side_rejected():
    with pytest.raises(ValueError):
        eye_key_for_user_side("up", mirror=True)


def test_hysteresis_prevents_flicker():
    h = Hysteresis(close_threshold=0.45, open_threshold=0.30)
    assert h.update(0.40) is False          # below close threshold: stays open
    assert h.update(0.50) is True           # crosses close threshold
    assert h.update(0.35) is True           # in the gap: STAYS closed (no flicker)
    assert h.update(0.29) is False          # below open threshold: reopens
    assert h.update(0.31) is False          # in the gap: stays open


def test_mouth_selection_ladder():
    assert pick_mouth({"jawOpen": 0.0}, MOUTH_CFG) == "closed"
    assert pick_mouth({"jawOpen": 0.02, "mouthSmileLeft": 0.5, "mouthSmileRight": 0.5}, MOUTH_CFG) == "E"
    assert pick_mouth({"jawOpen": 0.10}, MOUTH_CFG) == "I"
    assert pick_mouth({"jawOpen": 0.20}, MOUTH_CFG) == "E"
    assert pick_mouth({"jawOpen": 0.40}, MOUTH_CFG) == "A"
    assert pick_mouth({"jawOpen": 0.10, "mouthPucker": 0.5}, MOUTH_CFG) == "U"
    assert pick_mouth({"jawOpen": 0.20, "mouthPucker": 0.5}, MOUTH_CFG) == "O"
    assert pick_mouth({"jawOpen": 0.20, "mouthFunnel": 0.5}, MOUTH_CFG) == "O"
