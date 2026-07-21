"""Guard against drift between the python sources of truth and their web twins.

configs/app.yaml + scripts/derive_sprites.py hold the real values; docs/js/config.js
mirrors them for the build-free GitHub Pages app. There is no shared file a browser
and python can both import without a build step, so this test parses the JS with
regexes and fails when the numbers diverge.
"""
import re
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
JS = (ROOT / "docs" / "js" / "config.js").read_text(encoding="utf-8")
APP = yaml.safe_load((ROOT / "configs" / "app.yaml").read_text(encoding="utf-8"))


def js_number(key: str) -> float:
    m = re.search(rf"\b{key}\s*:\s*(-?[\d.]+)", JS)
    assert m, f"config.js is missing key {key}"
    return float(m.group(1))


def test_thresholds_match_app_yaml():
    pairs = {
        "closeThreshold": APP["eyes"]["close_threshold"],
        "openThreshold": APP["eyes"]["open_threshold"],
        "halfCloseThreshold": APP["eyes"]["half_close_threshold"],
        "halfOpenThreshold": APP["eyes"]["half_open_threshold"],
        "jawClosed": APP["mouth"]["jaw_closed"],
        "jawMid": APP["mouth"]["jaw_mid"],
        "jawLarge": APP["mouth"]["jaw_large"],
        "puckerThreshold": APP["mouth"]["pucker_threshold"],
        "funnelThreshold": APP["mouth"]["funnel_threshold"],
        "smileThreshold": APP["mouth"]["smile_threshold"],
        "blendAlpha": APP["smoothing"]["blend_alpha"],
        "blinkAlpha": APP["smoothing"]["blink_alpha"],
        "headAlpha": APP["smoothing"]["head_alpha"],
        "holdMs": APP["lost_face"]["hold_ms"],
        "decayMs": APP["lost_face"]["decay_ms"],
        "frames": APP["calibration"]["frames"],
        "blinkGain": APP["warp"]["blink_gain"],
        "smileGain": APP["warp"]["smile_gain"],
        "jawGain": APP["warp"]["jaw_gain"],
        "headParallax": APP["warp"]["head_parallax"],
    }
    mismatches = {k: (js_number(k), v) for k, v in pairs.items() if js_number(k) != v}
    assert not mismatches, f"config.js drifted from configs/app.yaml: {mismatches}"


def test_warp_constants_match_python():
    """docs/js/warp.js mirrors app/warp_rig.py's tuned constants."""
    import app.warp_rig as wr

    warp_js = (ROOT / "docs" / "js" / "warp.js").read_text(encoding="utf-8")

    def js_const(pattern: str) -> list[float]:
        m = re.search(pattern, warp_js)
        assert m, f"warp.js missing {pattern}"
        return [float(g) for g in m.groups()]

    assert js_const(r"UNIT_REF = ([\d.]+)") == [wr.UNIT_REF]
    assert js_const(r"BLINK_MAX = ([\d.]+)") == [wr.BLINK_MAX]
    assert js_const(r"SEAL_RAMP = \[([\d.]+), ([\d.]+)\]") == list(wr.SEAL_RAMP)
    assert js_const(r"JAW_RAMP = \[([\d.]+), ([\d.]+)\]") == list(wr.JAW_RAMP)
    assert js_const(r"PARALLAX_AMP = \[([\d.]+), ([\d.]+)\]") == list(wr.PARALLAX_AMP)
    # MOUTH_FILL: python stores BGR, js stores RGB
    assert js_const(r"MOUTH_FILL = \[(\d+), (\d+), (\d+)\]") == list(wr.MOUTH_FILL[::-1])


def test_derive_params_match_python():
    import scripts.derive_sprites as ds  # noqa: E402 — scripts/ has no __init__

    assert js_number("squash") == ds.SQUASH
    assert js_number("smileAmpFrac") == ds.SMILE_AMP_FRAC
    assert js_number("fillDarken") == ds.FILL_DARKEN
    for name, p in ds.VISEMES.items():
        block = re.search(rf"{name}:\s*\{{([^}}]*)\}}", JS)
        assert block, f"config.js DERIVE.visemes missing {name}"
        for field in ("drop", "wx", "teeth", "tongue"):
            m = re.search(rf"{field}:\s*(-?[\d.]+)", block.group(1))
            assert m and float(m.group(1)) == p[field], \
                f"viseme {name}.{field}: js={m and m.group(1)} py={p[field]}"
