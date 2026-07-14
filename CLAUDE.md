# DrawFace Live — Claude Code Implementation Guide

> **Project status (2026-07-10):** this guide records the original evaluation
> plan. The FasterLivePortrait evaluation is complete and the MediaPipe sprite
> pipeline is the selected runtime implementation; see `outputs/benchmark.md`
> and `README.md` for the current product and run instructions.

## 1. Project goal

Build a local desktop prototype that transfers the user's live webcam facial motion to a single hand-drawn character image.

Primary interaction:

1. Load `assets/source/character.png`.
2. Open the user's webcam.
3. Track the user's facial motion in real time.
4. Make the drawing reproduce independent left/right winks, blinking, mouth opening, smiling, and head motion.
5. Preserve the original body and background as much as possible.

This project is the facial-animation counterpart of Meta Animated Drawings:

- Animated Drawings: human motion → BVH/skeleton → drawing body animation
- This project: webcam face → implicit facial keypoints/blendshapes → drawing face animation

## 2. Recommended project folder

Use this short English folder name:

```text
drawface-live
```

Alternative names, in preference order:

1. `drawface-live`
2. `inkface`
3. `facepuppet`

Use `drawface-live` unless the directory already exists.

## 3. Runtime environment policy

Do not assume or hard-code any of the following:

- Operating system
- GPU vendor or model
- Available VRAM
- Python version
- CUDA, cuDNN, TensorRT, DirectML, ROCm, or MPS availability
- FFmpeg availability
- Webcam index
- Supported processing resolution
- Expected FPS

Inspect the machine where Claude Code is actually running and report the detected environment before selecting an installation path or backend.

Use the upstream project's verified compatibility requirements when selecting Python and dependency versions. If several backends are available, benchmark or justify the selection using the detected hardware. Never infer the current machine from previous documents, conversations, repository history, or common defaults.

## 4. Historical evaluation engine

Evaluate [warmshao/FasterLivePortrait](https://github.com/warmshao/FasterLivePortrait) as the initial animation-engine candidate.

Reasons:

- Accepts one source image.
- Accepts a webcam device through the `--dri_video` argument.
- Provides a real-time execution path.
- Supports human and animal models.
- Provides stitching, regional animation, and paste-back behavior.
- Provides ONNX and TensorRT execution paths.

Do not reimplement LivePortrait from scratch.

Place external code under:

```text
third_party/FasterLivePortrait/
```

Prefer a Git submodule. If that is impractical, clone the repository and record its exact commit SHA in `THIRD_PARTY.md`. Do not modify upstream files unless absolutely necessary. Put integrations and patches in our own wrapper code.

## 5. Required repository layout

Create or maintain this structure:

```text
drawface-live/
├─ CLAUDE.md
├─ README.md
├─ THIRD_PARTY.md
├─ requirements-wrapper.txt
├─ assets/
│  ├─ source/
│  │  └─ character.png
│  └─ sprites/
│     └─ README.md
├─ app/
│  ├─ __init__.py
│  ├─ main.py
│  ├─ config.py
│  ├─ camera.py
│  ├─ neural_backend.py
│  ├─ benchmark.py
│  └─ diagnostics.py
├─ configs/
│  └─ app.yaml
├─ scripts/
│  ├─ setup.*
│  ├─ diagnose.*
│  ├─ run.*
│  └─ run_animal.*
├─ tests/
│  ├─ test_config.py
│  └─ test_camera_mapping.py
├─ outputs/
└─ third_party/
   └─ FasterLivePortrait/
```

Do not commit model weights, generated videos, webcam recordings, virtual environments, TensorRT engine files, or private user images unless the user explicitly requests it. Add appropriate rules to `.gitignore`.

## 6. Development phases

### Phase 0 — Inspect before changing anything

Before installation or code changes:

1. Inspect the current directory and Git status.
2. Preserve all existing user files and changes.
3. Detect the OS, CPU, GPU, available memory/VRAM, Python, `pip`, Git, FFmpeg, and every applicable acceleration backend. Check CUDA, cuDNN, and TensorRT only when NVIDIA hardware is actually present.
4. Check whether `assets/source/character.png` exists.
5. Enumerate available webcams and verify the selected device without recording or saving frames.
6. Write the results to the terminal in a concise table.

Never fabricate a character image. If the source image is missing, scaffold the project and provide a clear instruction telling the user where to place it.

### Phase 1 — Baseline FasterLivePortrait test

First reproduce the upstream behavior with the fewest modifications.

Test human mode using the command syntax appropriate for the detected operating system:

```text
python third_party/FasterLivePortrait/run.py --src_image assets/source/character.png --dri_video <detected-camera-index> --cfg <verified-config> --realtime
```

Test animal mode because the drawing has a pig-like face:

```text
python third_party/FasterLivePortrait/run.py --src_image assets/source/character.png --dri_video <detected-camera-index> --cfg <verified-config> --realtime --animal --paste_back
```

Confirm the actual flags from the checked-out upstream version before using them. Do not blindly assume the README and CLI are synchronized.

Select TensorRT, ONNX Runtime, PyTorch, MPS, CPU, or another supported path only after inspecting the detected hardware and the checked-out upstream version. Do not silently change backends or claim real-time performance without measurement. Clearly report the chosen backend and measured FPS.

### Phase 2 — Build a local wrapper

After the upstream command works, build `app/main.py` as a thin wrapper. It must not duplicate the upstream model implementation.

Required CLI:

```text
python -m app.main \
  --source assets/source/character.png \
  --camera <detected-camera-index> \
  --mode auto \
  --backend auto \
  --mirror-preview true \
  --paste-back true
```

Required options:

- `--source`: source drawing path
- `--camera`: webcam index
- `--mode`: `auto`, `human`, or `animal`
- `--backend`: `auto` plus only the backends actually supported by the integrated upstream version
- `--mirror-preview`: mirror only the user-facing preview
- `--paste-back`: preserve the original body/background
- `--resolution`: processing resolution
- `--save-output`: disabled by default
- `--debug-overlay`: show FPS/backend/detection state

The wrapper must:

- Validate paths before model loading.
- Produce actionable errors for missing weights or dependencies.
- Select the best available backend for the detected system without hiding fallback decisions.
- Keep only the latest camera frame to avoid growing latency.
- Release the webcam and GPU resources on exit.
- Exit cleanly when the user presses `Q` or `Esc`.
- Never save webcam frames unless `--save-output` is explicitly enabled.

### Phase 3 — Human vs. animal evaluation

Run both modes on the same source image and record:

- Whether the source face is detected
- Whether the driving face is detected
- Independent left/right wink behavior
- Blink stability
- Mouth-open response
- Smile response
- Head yaw/pitch/roll response
- Character identity preservation
- Background/body preservation
- Average FPS
- End-to-end latency if measurable
- Peak VRAM
- Visible artifacts

Write results to `outputs/benchmark.json` and a human-readable summary in `outputs/benchmark.md`.

Use this decision rule:

1. If only one mode detects and animates the drawing, select it.
2. If both work, prefer the mode with better identity preservation and wink accuracy, not merely higher FPS.
3. If neither detects the source face, stop modifying the neural model and proceed to the fallback design in Phase 5.

### Phase 4 — Product-level controls

Add a minimal local UI only after the CLI pipeline works.

The UI should provide:

- Source-image chooser
- Camera selector
- Human/animal/auto mode
- ONNX/TensorRT/auto backend
- Mirror-preview toggle
- Paste-back toggle
- Start/stop buttons
- Current FPS and backend
- Clear error messages

Prefer a lightweight local UI toolkit compatible with the detected operating system. PySide6 is acceptable when supported. Do not introduce Electron, a web server, authentication, cloud APIs, a database, or telemetry.

### Phase 5 — Fallback only if the neural pipeline fails

If the pig-like hand drawing cannot be detected reliably, implement a deterministic sprite backend using MediaPipe Face Landmarker.

Do not start this phase unless Phase 3 provides evidence that FasterLivePortrait is unsuitable.

Fallback pipeline:

```text
Webcam
  → MediaPipe Face Landmarker
  → face blendshapes/head transform
  → smoothing and calibration
  → eye/mouth sprite selection and optional 2D warp
  → composite onto the original drawing
```

Map at least:

- `eyeBlinkLeft` → left eye open/half/closed
- `eyeBlinkRight` → right eye open/half/closed
- `jawOpen` → mouth-open amount
- `mouthSmileLeft`, `mouthSmileRight` → smile state
- brow blendshapes → eyebrow vertical offset
- facial transformation matrix → head yaw/pitch/roll

The mirrored webcam preview must not accidentally swap semantic left/right control. Add an automated mapping test and a manual calibration screen.

Expected sprite paths:

```text
assets/sprites/
├─ eye_left_open.png
├─ eye_left_half.png
├─ eye_left_closed.png
├─ eye_right_open.png
├─ eye_right_half.png
├─ eye_right_closed.png
├─ mouth_neutral.png
├─ mouth_A.png
├─ mouth_E.png
├─ mouth_I.png
├─ mouth_O.png
└─ mouth_U.png
```

If sprite files are missing, report them. Do not generate replacement artwork.

## 7. Smoothing and calibration

For the deterministic fallback, use:

- Exponential moving average for continuous values
- Separate open and close thresholds for blinking to prevent flicker
- Per-user neutral calibration
- Optional maximum-expression calibration
- A short lost-face timeout that holds the last valid state, then returns to neutral

All thresholds must be configurable in `configs/app.yaml` rather than hard-coded throughout the code.

## 8. Performance and memory requirements

- Detect available compute and memory before selecting a model configuration.
- Load one face and one model at a time unless measurement shows that concurrent loading is safe and useful.
- Avoid loading human and animal engines simultaneously during the initial comparison.
- Avoid unbounded queues and retaining unnecessary frame history.
- Use FP16, TensorRT, or another optimized runtime only when supported and verified on the detected system.
- Select an initial resolution based on actual memory headroom and upstream model constraints.
- Measure and log FPS, latency when possible, memory usage, and peak VRAM when a GPU exposes that metric.

If memory is insufficient, report the exact allocation failure and propose the smallest safe change. Do not mask out-of-memory failures with broad exception handling.

## 9. Privacy and safety

- Process webcam frames locally.
- Do not send images or video to external services.
- Do not save frames by default.
- Clearly indicate when recording is enabled.
- Do not add analytics or telemetry.
- Model downloads must come from the upstream project or its documented model host.

## 10. Code quality rules

- Use type hints for new Python code.
- Keep upstream code separate from wrapper code.
- Add concise docstrings only where behavior is not obvious.
- Use structured logging instead of scattered `print()` calls.
- Keep configuration in YAML or CLI arguments.
- Avoid premature abstractions.
- Never rewrite unrelated user files.
- Do not use destructive Git commands.
- Run targeted tests after each meaningful phase.
- Update `README.md` with commands that were actually verified.

## 11. Acceptance criteria

The initial prototype is complete only when:

- [ ] The project starts through a launcher appropriate for the detected operating system.
- [ ] A source drawing can be selected without editing code.
- [ ] The selected webcam opens and closes cleanly.
- [ ] The active backend and mode are visible.
- [ ] At least one pipeline produces live character facial movement.
- [ ] Right and left winks are tested independently.
- [ ] Mouth opening is visibly reflected.
- [ ] The body/background remain unchanged or limitations are documented.
- [ ] Average FPS and peak VRAM are measured.
- [ ] Missing models, camera errors, and source detection failures have useful messages.
- [ ] Webcam frames are not saved by default.
- [ ] Setup and run instructions are documented in `README.md`.

Do not claim success based only on a prerecorded driving video. The final verification must use a live webcam.

## 12. Required final report

When finishing a work session, report:

1. What was implemented
2. Files created or changed
3. Commands executed
4. Tests and benchmark results
5. Active backend and model mode
6. Measured FPS and VRAM
7. Remaining limitations
8. The exact next command for the user

If blocked, state the concrete blocker and the smallest user action needed. Do not describe unfinished work as completed.

## 13. Initial Claude Code prompt

Use the following as the first prompt after opening Claude Code in the project directory:

```text
Read CLAUDE.md in full and treat it as the project specification.

First inspect the current directory, Git status, operating system, CPU, GPU, available memory/VRAM, Python environment, applicable acceleration backends, FFmpeg, available webcams, and whether assets/source/character.png exists. Preserve all existing user files and changes. Do not infer the environment from earlier conversations, documents, repository history, or common defaults.

Then implement Phase 0 and Phase 1 only. Set up FasterLivePortrait under third_party, record the exact upstream commit, create the minimal project scaffold and platform-appropriate diagnostic/run scripts, and attempt both human and animal real-time webcam modes on the supplied drawing. Choose the backend, dependency versions, resolution, and performance settings from the environment you actually detect and the checked-out upstream documentation. Do not begin the MediaPipe sprite fallback unless both neural modes are objectively tested and fail to detect or animate the drawing.

Measure source-face detection, driving-face detection, independent left/right wink response, mouth opening, FPS, latency if possible, and peak VRAM. Do not save webcam frames unless explicitly enabled. Do not fabricate missing images or claim success from prerecorded video.

After implementation, run the relevant tests and provide a concise report containing changed files, exact commands, results, limitations, and the next command I should run.
```
