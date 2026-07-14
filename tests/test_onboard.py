from PIL import Image, ImageDraw

from app.onboard import build_character, fit_512, snap_to_ink


def _drawing() -> Image.Image:
    img = Image.new("RGB", (200, 200), (245, 245, 245))
    d = ImageDraw.Draw(img)
    d.ellipse((60, 40, 66, 46), fill=(20, 20, 20))    # left eye dot
    d.ellipse((110, 40, 116, 46), fill=(20, 20, 20))  # right eye dot
    d.arc((70, 70, 110, 95), 20, 160, fill=(20, 20, 20), width=3)  # mouth
    return img


def test_snap_to_ink_finds_nearby_dot():
    img = fit_512(_drawing())  # 200x200 -> scaled 2.56x, centered
    # the left dot lands near (161, 110) on the canvas; click sloppily nearby
    sx, sy = snap_to_ink(img, 168, 118, 12)
    assert abs(sx - 161) <= 4 and abs(sy - 110) <= 4


def test_build_character_produces_loadable_folder(tmp_path):
    img = fit_512(_drawing())
    out = build_character(img, tmp_path / "toon", "toon",
                          {"L": (161, 110), "R": (289, 110)}, 12, (180, 180, 285, 250))
    for f in ("base.png", "eye_L_open.png", "eye_L_closed.png",
              "eye_R_open.png", "eye_R_closed.png", "manifest.json"):
        assert (out / f).exists(), f
    import json
    mf = json.loads((out / "manifest.json").read_text())
    assert mf["proceduralMouth"] is True
    assert mf["mouthStyle"]["width"] >= 12
    # the eye dots must be erased from base
    base = Image.open(out / "base.png").convert("RGB")
    region = base.crop((149, 98, 173, 122))
    assert all(sum(p) > 300 for p in region.getdata()), "eye ink not inpainted"
