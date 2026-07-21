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

## FasterLivePortrait (primary animation engine)

| Field | Value |
| --- | --- |
| Upstream URL | https://github.com/warmshao/FasterLivePortrait |
| Pinned commit | `8aad3602177547aaa5e4beec0c3ef5b7944e7a1f` |
| Commit date | 2025-06-29 15:36:41 +0800 (merge of PR #182, `kokoro`) |
| Integration | Git submodule at `third_party/FasterLivePortrait`, **unmodified** |
| License | MIT License, Copyright (c) 2025 warmshao (`third_party/FasterLivePortrait/LICENSE`) |

The submodule is checked out at the exact pinned SHA (`git -C third_party/FasterLivePortrait rev-parse HEAD`
returns the SHA above). It is registered in `.gitmodules` with `ignore = untracked` because upstream `run.py`
writes a `results/` directory inside its own tree at runtime; that directory must not appear as submodule dirt.

We do not modify upstream files. All integration and patches live in our own wrapper code (`app/`).

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
Upstream files remain unmodified.

## Model weights (checkpoints)

| Field | Value |
| --- | --- |
| Source | https://huggingface.co/warmshao/FasterLivePortrait |
| Download | `hf download warmshao/FasterLivePortrait --local-dir checkpoints` |
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
