"""ARAP warp rig invariants: identity at rest, per-channel displacement
direction, ARAP cheek propagation, and render locality (style preservation).

Uses a synthetic landmark layout — no MediaPipe, runs headless.
"""

import numpy as np
import pytest

from app.warp_rig import (
    CHEEKS,
    CHIN,
    EYE_SPAN,
    L_EYE_TOP,
    MOUTH_CORNERS,
    R_EYE_TOP,
    WarpRig,
)


def synthetic_landmarks(size: int = 512) -> np.ndarray:
    """Plausible face layout; only FEATURE + EYE_SPAN indices are used by the rig."""
    from app.warp_rig import (
        FACE_OVAL, L_BROW, L_EYE_BOT, LIP_BOT, LIP_TOP, NOSE, R_BROW, R_EYE_BOT,
    )
    lm = np.zeros((478, 2), np.float32)

    def ring(ids, cx, cy, rx, ry, upper):
        n = len(ids)
        for k, i in enumerate(ids):
            t = (k + 1) / (n + 1) * np.pi
            y = cy - ry * np.sin(t) if upper else cy + ry * np.sin(t)
            lm[i] = (cx - rx * np.cos(t), y)

    for k, i in enumerate(FACE_OVAL):
        a = 2 * np.pi * k / len(FACE_OVAL)
        lm[i] = (256 + 150 * np.sin(a), 250 - 150 * np.cos(a))
    ring(L_EYE_TOP, 180, 220, 30, 12, upper=True)
    ring(L_EYE_BOT, 180, 220, 30, 12, upper=False)
    ring(R_EYE_TOP, 330, 220, 30, 12, upper=True)
    ring(R_EYE_BOT, 330, 220, 30, 12, upper=False)
    lm[EYE_SPAN[0]] = (148, 220)
    lm[EYE_SPAN[1]] = (362, 220)
    for k, i in enumerate(L_BROW):
        lm[i] = (150 + 15 * k, 195)
    for k, i in enumerate(R_BROW):
        lm[i] = (300 + 15 * k, 195)
    for k, i in enumerate(LIP_TOP):
        lm[i] = (226 + 8 * k, 298)
    for k, i in enumerate(LIP_BOT):
        lm[i] = (226 + 8 * k, 306)
    lm[MOUTH_CORNERS[0]] = (215, 302)
    lm[MOUTH_CORNERS[1]] = (295, 302)
    for k, i in enumerate(CHIN):
        lm[i] = (236 + 10 * k, 364 + 2 * (k % 2))
    for k, i in enumerate(NOSE):
        lm[i] = (250 + 4 * k, 240 + 4 * k)
    for (x, y), i in zip([(205, 260), (307, 260), (215, 275), (297, 275), (200, 285), (312, 285)],
                         CHEEKS):
        lm[i] = (x, y)
    return lm


@pytest.fixture(scope="module")
def rig() -> WarpRig:
    img = np.full((512, 512, 3), 255, np.uint8)
    img[208:232, 150:210] = 0  # left eye
    img[208:232, 300:360] = 0  # right eye
    img[300:306, 215:295] = 0  # mouth stroke
    return WarpRig(img, synthetic_landmarks())


def vid(rig: WarpRig, lm_idx: int) -> int:
    return rig._vid[lm_idx]


def test_rest_is_identity(rig):
    assert np.array_equal(rig.render(), rig._img)
    assert np.allclose(rig.deform(), rig.verts)


def test_blink_closes_lid_and_stays_local(rig):
    d = rig.deform(blink_l=1.0)
    moved = d - rig.verts
    # center of the left upper lid comes down…
    lid = [vid(rig, i) for i in L_EYE_TOP]
    assert max(moved[v, 1] for v in lid) > 3.0
    # …the right eye and the border do not move
    other = [vid(rig, i) for i in R_EYE_TOP]
    assert max(abs(moved[v]).max() for v in other) < 0.5
    n_feature = len(rig._vid)
    assert np.abs(moved[n_feature:]).max() < 0.5


def test_blink_tapers_at_eye_corners(rig):
    d = rig.deform(blink_l=1.0)
    moved = d - rig.verts
    lid = [vid(rig, i) for i in L_EYE_TOP]
    xs = rig.verts[lid, 0]
    center = lid[int(np.argmin(np.abs(xs - xs.mean())))]
    corner = lid[int(np.argmax(np.abs(xs - xs.mean())))]
    assert moved[center, 1] > moved[corner, 1]  # lids hinge at the corners


def test_smile_propagates_into_free_cheeks(rig):
    d = rig.deform(smile=1.0)
    moved = d - rig.verts
    corners = [vid(rig, i) for i in MOUTH_CORNERS]
    assert all(moved[v, 1] < -3.0 for v in corners)  # corners up
    cheeks = [vid(rig, i) for i in CHEEKS]
    # cheeks are unpinned: ARAP must lift them without an explicit offset
    assert min(moved[v, 1] for v in cheeks) < -0.5


def test_jaw_drops_chin(rig):
    d = rig.deform(jaw=1.0)
    moved = d - rig.verts
    chin = [vid(rig, i) for i in CHIN]
    assert min(moved[v, 1] for v in chin) > 5.0


def test_render_preserves_far_pixels(rig):
    out = rig.render(blink_l=1.0, blink_r=1.0, smile=1.0, jaw=1.0)
    assert np.array_equal(out[:60], rig._img[:60])          # top strip
    assert np.array_equal(out[:, :60], rig._img[:, :60])    # left strip


# ---- 4-click bridge (synthesized landmarks from onboarding boxes) ----

BOXES = ((150, 200, 210, 240), (300, 200, 360, 240), (215, 290, 295, 320))


def test_landmarks_from_boxes_layout():
    from app.warp_rig import FEATURE, landmarks_from_boxes

    lm = landmarks_from_boxes(*BOXES, (512, 512))
    pts = lm[FEATURE]
    assert pts.min() >= 0 and pts.max() < 512
    # no duplicates — a duplicated point falls out of the Delaunay triangulation
    keys = {(round(float(x), 1), round(float(y), 1)) for x, y in lm[FEATURE + list(EYE_SPAN)]}
    assert len(keys) == len(FEATURE) + 2
    # eye rings sit on their boxes, mouth corners on the mouth box edges
    assert abs(lm[L_EYE_TOP][:, 0].mean() - 180) < 12
    assert abs(lm[MOUTH_CORNERS[0]][0] - 215) < 2 and abs(lm[MOUTH_CORNERS[1]][0] - 295) < 2


def test_box_rig_blinks_without_touching_far_pixels():
    from app.warp_rig import landmarks_from_boxes

    img = np.full((512, 512, 3), 255, np.uint8)
    img[215:225, 175:185] = 0  # left-eye dot
    img[215:225, 325:335] = 0  # right-eye dot
    rig = WarpRig(img, landmarks_from_boxes(*BOXES, (512, 512)), brow_follow=False)
    out = rig.render(blink_l=1.0, blink_r=1.0)
    assert not np.array_equal(out[200:240, 150:210], img[200:240, 150:210])  # eye region moved
    assert np.array_equal(out[:100], img[:100])  # far pixels untouched (no brow follow)


# ---- hybrid layers (eyelid seal + mouth interior) ----

def test_full_jaw_fills_mouth_interior():
    from app.warp_rig import MOUTH_FILL, landmarks_from_boxes

    img = np.full((512, 512, 3), 255, np.uint8)
    img[300:306, 215:295] = 0  # mouth stroke
    rig = WarpRig(img, landmarks_from_boxes(*BOXES, (512, 512)), brow_follow=False)
    out = rig.render(jaw=1.0)
    region = out[295:345, 210:300].reshape(-1, 3).astype(int)
    assert (np.abs(region - MOUTH_FILL).sum(axis=1) < 30).any()  # interior fill present
    assert np.array_equal(out[:200], img[:200])  # face above untouched


def test_eye_seal_engages_only_past_ramp():
    from app.warp_rig import landmarks_from_boxes, piecewise_affine

    img = np.full((512, 512, 3), 255, np.uint8)
    img[190:250, 140:220] = (160, 180, 200)  # skin patch so the lid color differs from bg
    img[215:225, 175:185] = 0
    rig = WarpRig(img, landmarks_from_boxes(*BOXES, (512, 512)), brow_follow=False)
    for amt, engaged in ((0.6, False), (1.0, True)):
        warp_only = piecewise_affine(img, rig.verts, rig.deform(blink_l=amt), rig.tris)
        differs = not np.array_equal(rig.render(blink_l=amt), warp_only)
        assert differs == engaged  # seal layer appears only above SEAL_RAMP start
