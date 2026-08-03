# Third-Party Components

## AnimatedDrawings ARAP solver (warp-rig research track)

| Field | Value |
| --- | --- |
| Upstream URL | https://github.com/facebookresearch/AnimatedDrawings |
| Pinned commit | `b859684857519c7424da51a0b0862fbd1fd258f4` (repo archived 2025-09, HEAD frozen) |
| File | `animated_drawings/model/arap.py` → vendored at `third_party/animated_drawings/arap.py` |
| License | MIT, Copyright (c) Meta Platforms, Inc. (`third_party/animated_drawings/LICENSE`) |

Vendored as a single file (the upstream repo is archived, so a submodule adds no update path).
Two numpy 2.x compatibility patches, both marked with `# [vendored]` comments in the file:
`np.bool8` → `np.bool_`, and `int()` on a size-1 array → `int(np.ravel(...)[0])`.
Integration lives in our wrapper (`app/warp_rig.py`); the solver file is otherwise unmodified.

## Delaunator (web warp-engine triangulation)

| Field | Value |
| --- | --- |
| Upstream URL | https://github.com/mapbox/delaunator |
| Version | 4.0.1 (dependency-free ESM build from unpkg) |
| File | vendored at `docs/js/delaunator.js`, unmodified below the provenance header |
| License | ISC, Copyright (c) 2021 Mapbox |

Used by `docs/js/warp.js` to build the same Delaunay face mesh the desktop rig
gets from `scipy.spatial.Delaunay`.

## avatar_core.js (shared render core, sibling repo)

| Field | Value |
| --- | --- |
| Upstream URL | https://github.com/ingon1026/talking-drawing-avatar |
| Upstream path | `static/avatar_core.js` |
| Vendored at | `docs/avatar_core.js` — consumed by `index.html` (mirroring studio) |
| License | same author, both repos |
| Sync | `./scripts/sync_avatar_core.sh` — `--check` compares without writing |
| CI | Vendor sync workflow, on push and daily |

The only vendored artifact here whose upstream **moves on its own**, which is why it gets a cron
and FasterLivePortrait does not: those patches target a pinned SHA and cannot drift unattended.
This copy did fall four commits behind unnoticed on 2026-07-31 — that is what the sync script and
the daily check exist to prevent.

Only the leading comment block differs between the two copies (each repo states its own role), so
the script compares everything *after* the first `*/` rather than hashing the whole file.

## FasterLivePortrait (primary animation engine)

| Field | Value |
| --- | --- |
| Upstream URL | https://github.com/warmshao/FasterLivePortrait |
| Pinned commit | `8aad3602177547aaa5e4beec0c3ef5b7944e7a1f` |
| Commit date | 2025-06-29 15:36:41 +0800 (merge of PR #182, `kokoro`) |
| Integration | Git submodule at `third_party/FasterLivePortrait`; unmodified in git, local patches applied to the working tree for the illustration track |
| Local patches | `vendor_patches/faster-live-portrait/*.patch` (`git format-patch` output, text only) |
| Apply | `./scripts/apply_vendor_patches.sh` — idempotent; `--check` verifies without applying |
| License | MIT License, Copyright (c) 2025 warmshao (`third_party/FasterLivePortrait/LICENSE`) |

The submodule is checked out at the exact pinned SHA (`git -C third_party/FasterLivePortrait rev-parse HEAD`
returns the SHA above). It is registered in `.gitmodules` with `ignore = untracked` because upstream `run.py`
writes a `results/` directory inside its own tree at runtime; that directory must not appear as submodule dirt.

The sprite and ARAP warp tracks use no upstream code at all — their integration lives entirely in
our own wrapper (`app/`). The illustration track is the one exception.

### Local patches — illustration track only

Real-time webcam puppeting of standard-proportion illustrations and paintings (TensorRT,
27–37 ms/frame on an RTX 4070 Ti) needs four changes that do not exist upstream. They are kept as
`git format-patch` files under `vendor_patches/faster-live-portrait/`, not as a fork:

| Patch | Touches | What it does |
| --- | --- | --- |
| `0001-local` | `src/pipelines/faster_live_portrait_pipeline.py`, `scripts/all_onnx2trt.sh`, adds `configs/trt_infer_eyes.yaml` | realtime eye-retargeting crash fix; driving motion (mouth, head) preserved under eye retargeting by adding the delta on top of the motion instead of replacing it; head-rotation axis-angle clamp (`max_head_rot_deg`) so cartoons do not smear; absolute python path in the human TRT build script |
| `0002-local` | adds `live.sh`, `README_LOCAL.md` | one-command runner (camera attach, out-of-tree source image copy) plus local run and tuning notes |
| `0003-local` | `README_LOCAL.md` | measured which-artwork-works examples (text only — the images it references are excluded, see below) |
| `0004-local` | `scripts/all_onnx2trt_animal.sh` | same absolute python path for the animal TRT build script, which `0001` left behind: the docker image has no `python` on `PATH`, only `/root/miniconda3/bin/python` |

`0001` carries a `base-commit: 8aad3602177547aaa5e4beec0c3ef5b7944e7a1f` trailer, so the series
records its own target. `apply_vendor_patches.sh` independently reads the gitlink SHA the parent
repo has recorded, and refuses to run if the submodule sits anywhere else.

To restore the patched tree **outside** this repo — a standalone clone rather than the submodule —
use `git am` instead (verified independently by two people: 4 patches apply cleanly and the result
is byte-identical to the original working tree, text files):

```bash
git clone https://github.com/warmshao/FasterLivePortrait
cd FasterLivePortrait && git checkout 8aad360
git am <이 리포>/vendor_patches/faster-live-portrait/00*.patch
```

The script uses `git apply`, not `git am`, so the submodule HEAD stays at the pinned SHA and the
gitlink the parent repo records never moves. The changes live in the submodule working tree, so
after applying, the parent reports `third_party/FasterLivePortrait (modified content)` — expected,
not dirt to clean up. `ignore = untracked` hides the files the patches *add* but not the ones they
*modify*. To revert: `git -C third_party/FasterLivePortrait checkout -- .` and delete the three
added files (`live.sh`, `README_LOCAL.md`, `configs/trt_infer_eyes.yaml`).

The Verify workflow runs `--check` on every push and PR (its checkout uses `submodules: true` for
this). A red light there means this repo contradicts itself — the patches or the gitlink moved —
never that upstream drifted, since the patches apply to a pinned SHA that cannot change on its own.

One caveat when running the patched `live.sh` from inside the submodule: it mounts only its own
tree (`-v "$PWD:/root/FLP"`), and `third_party/FasterLivePortrait/checkpoints/` here is an empty
placeholder (upstream `.gitignore:5` ignores it) — the 2.9 GB of weights live at the repo root, one
level up and outside that mount. Add a second bind mount for them, the way `scripts/lib.sh`'s
`flp_run` already does for the ONNX path, or the container starts with no weights. (The empty
directory is verified; the added mount is not.)

#### TensorRT engines must be rebuilt locally (procedure reconstructed, NOT verified end to end)

The patched track runs on TensorRT: `trt_infer_eyes.yaml` points at nine
`checkpoints/liveportrait_onnx/*.trt` engines that are **not** in `checkpoints/` and cannot be
copied from another machine — they are built against TensorRT 8.6.1.6 for a specific GPU (here an
RTX 4070 Ti) and will not load elsewhere. Writing the procedure down is the only way to preserve it.

> **Status: reconstructed by reading `live.sh`, not executed end to end.** The `LD_LIBRARY_PATH`
> line below comes from `live.sh`'s `run.py` invocation, not from a conversion run anyone has
> completed. Treat step ③ as the best available reconstruction and correct it once someone runs it.

```bash
# ① runtime image
docker pull shaoguo/faster_liveportrait:v3
# ② ONNX weights — skip if scripts/setup.sh already populated checkpoints/
#    (includes libgrid_sample_3d_plugin.so, so the TRT plugin needs no separate build)
uvx --from 'huggingface_hub[cli]' huggingface-cli download \
  warmshao/FasterLivePortrait --local-dir checkpoints
# ③ convert ONNX → TRT inside the container
docker run --rm --gpus=all -v "$PWD/third_party/FasterLivePortrait:/root/FLP" \
  -v "$PWD/checkpoints:/root/FLP/checkpoints" -w /root/FLP \
  shaoguo/faster_liveportrait:v3 \
  bash -c "export LD_LIBRARY_PATH=/opt/TensorRT-8.6.1.6/lib:\$LD_LIBRARY_PATH; \
    sh scripts/all_onnx2trt.sh"
```

That builds the nine human engines, which is all the illustration track uses. For animal mode, run
`sh scripts/all_onnx2trt_animal.sh` the same way (six more engines) — otherwise skip it.

`export LD_LIBRARY_PATH=/opt/TensorRT-8.6.1.6/lib` is the piece that exists nowhere else in writing:
upstream `README.md` says only "run `sh scripts/all_onnx2trt.sh`", and `README_LOCAL.md` does not
mention the TRT build at all. Without it the conversion fails inside the container. The two
conversion scripts must also have the patches applied first (`0001`, `0004`) — they call
`/root/miniconda3/bin/python` because the image has no `python` on `PATH`. (`onnx2trt.py` itself
imports only stdlib, `tensorrt` and `numpy`, so the extra `pip install` inside `live.sh` is for
`run.py`, not for the conversion.)

#### Binary test assets are excluded

The patch series is text only. Nine binary files (~4.7 MB combined) that the patch author had in
their tree were deliberately left out — partly for size, and partly because `drive.mp4` is an 8.8 s
recording with audio whose provenance cannot be confirmed, and this repo's `CLAUDE.md` forbids
committing webcam recordings. Paths are inside the submodule tree
(`third_party/FasterLivePortrait/…`), which is where `live.sh` resolves them:

| Missing | Files | Impact |
| --- | --- | --- |
| `assets/test/` | `boy.png`, `girl.jpg`, `pig.png`, `drive.mp4` (3.4 MB) | **breaks commands.** Not an upstream directory — upstream examples live in `assets/examples/` and are unaffected. These are the patch author's own inputs, and `live.sh` defaults to `assets/test/girl.jpg`, so `./live.sh` with no argument fails. Pass your own image (`./live.sh ~/my_illustration.png`); the script copies out-of-tree paths in for you. Same for a driving clip. |
| `docs_local/` | `fail_boy.png`, `fail_pig.png`, `ok_girl.png`, `ok_oil.png`, `ok_pearl.png` | **documentation only.** The five image references in `README_LOCAL.md` render as broken links. Nothing at runtime depends on them. The text was left untouched on purpose — editing it would break the byte-for-byte match with the author's tree. |

The author's before/after comparison therefore cannot be re-run as-is. Reproduce it with your own
standard-proportion illustration and a live webcam.

## Runtime Docker image

| Field | Value |
| --- | --- |
| Image | `shaoguo/faster_liveportrait:v3` |
| Digest | `sha256:c2fb2b22c61594ca3c187cfcae514cd449135a1aee693b79f924998d394b378d` |
| GPU check | `docker run --rm --gpus all shaoguo/faster_liveportrait:v3 nvidia-smi` (run during the P4 smoke test) |

The image bundles Python 3.10.12 (`/root/miniconda3/bin/python`, not on default PATH), the custom
ONNX Runtime GPU 1.17.0 (CUDAExecutionProvider verified on the RTX 4070 Ti), torch 2.0.1+cu117, and
the prebuilt XPose `MultiScaleDeformableAttention` CUDA op needed for animal mode (loads after
`import torch`). TensorRT python bindings are broken in this image (`libnvinfer.so.8` missing) —
ONNX is the only usable GPU backend from this image.

### Derived runtime image `drawface/flp:v3-x11`

Built by `scripts/setup.sh` from `docker/Dockerfile`: upstream image + `libsm6 libxext6 libxrender1`
(OpenCV's Qt xcb plugin needs them for `cv2.imshow` under WSLg) + conda python on PATH.
The image build itself does not touch upstream files.

## Model weights (checkpoints)

| Field | Value |
| --- | --- |
| Source | https://huggingface.co/warmshao/FasterLivePortrait |
| Download | `uvx --from 'huggingface_hub[cli]' huggingface-cli download warmshao/FasterLivePortrait --local-dir checkpoints` (same as `scripts/setup.sh`) |
| Size | ~2.9 GB, 31 files |

`checkpoints/` lives **outside** the submodule (at the repo root) and is **bind-mounted** over
`/root/FasterLivePortrait/checkpoints` at container runtime. It is not committed.

Config files reference weights with `./checkpoints/...` relative paths, so the container must run with
working directory `/root/FasterLivePortrait` (as the bind-mount and `-w` flag ensure).

Layout the configs expect (all present):

- `checkpoints/liveportrait_onnx/` — human ONNX models (warping_spade, motion_extractor, landmark,
  retinaface_det_static, face_2dpose_106_static, appearance_feature_extractor, stitching, stitching_eye,
  stitching_lip).
- `checkpoints/liveportrait_animal_onnx/` — animal ONNX models + `xpose.pth` +
  `clip_embedding_9.pkl` / `clip_embedding_68.pkl` (the pipeline derives `checkpoint_dir` from
  `dirname(model_path)`, so these XPose assets are read from inside this directory).
- `checkpoints/liveportrait_animal_onnx_v1.1/` — alternate animal weights (present, not required by the
  default `onnx_infer.yaml`).
