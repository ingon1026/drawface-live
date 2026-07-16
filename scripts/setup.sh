#!/usr/bin/env bash
# Idempotent setup: submodule, docker image, checkpoints. Each step skips if done.
set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"   # ROOT, RUNIMG
IMG="shaoguo/faster_liveportrait:v3"
SM="$ROOT/third_party/FasterLivePortrait"
CKPT="$ROOT/checkpoints"
VENV="$ROOT/.venv"
PY="$VENV/bin/python"
MPMODEL="$CKPT/mediapipe/face_landmarker.task"
MPURL="https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/latest/face_landmarker.task"
SPRITES="$ROOT/assets/sprites/pig"
PIGSRC="/home/ingon/face/assets_characters/pig"

echo "== [1/4] submodule =="
if [ -f "$SM/run.py" ]; then
  echo "  already checked out — skipping"
else
  # NOTE: requires .gitmodules (owned by Agent B / third_party setup).
  git -C "$ROOT" submodule update --init "third_party/FasterLivePortrait" \
    || echo "  submodule not configured (no .gitmodules yet) — skipping"
fi

echo "== [2/4] docker image =="
if docker image ls "$IMG" 2>/dev/null | grep -q faster_liveportrait; then
  echo "  $IMG already present — skipping"
else
  docker pull "$IMG"
fi

echo "== [2b/4] derived runtime image (X11 libs) =="
if docker image inspect "$RUNIMG" >/dev/null 2>&1; then
  echo "  $RUNIMG already present — skipping"
else
  docker build -t "$RUNIMG" "$ROOT/docker/"
fi

echo "== [3/4] checkpoints =="
if [ -n "$(find "$CKPT" -type f 2>/dev/null | head -1)" ]; then
  echo "  checkpoints/ already populated — skipping"
else
  uvx --from 'huggingface_hub[cli]' huggingface-cli download \
    warmshao/FasterLivePortrait --local-dir "$CKPT"
fi

echo "== [4/4] fallback (MediaPipe) =="
# venv
if [ -x "$PY" ]; then
  echo "  .venv already present — skipping create"
else
  uv venv --python 3.12 "$VENV"
fi
# python deps (mediapipe import is the proxy for the whole set)
if "$PY" -c "import mediapipe, cv2, numpy, yaml, scipy" 2>/dev/null; then
  echo "  fallback deps already importable — skipping install"
else
  uv pip install --python "$PY" mediapipe opencv-python numpy pyyaml pillow pytest scipy
fi
# face landmarker model
if [ -f "$MPMODEL" ]; then
  echo "  face_landmarker.task already present — skipping download"
else
  curl -L -o "$MPMODEL" --create-dirs "$MPURL"
fi
# pig sprite set
if [ -f "$SPRITES/base.png" ]; then
  echo "  pig sprites already present — skipping copy"
elif [ -d "$PIGSRC" ]; then
  mkdir -p "$SPRITES"
  cp "$PIGSRC"/*.png "$PIGSRC"/manifest.json "$SPRITES"/
  echo "  copied pig sprites from $PIGSRC"
else
  echo "  WARNING: sprite source $PIGSRC not found — supply pig artwork into $SPRITES manually"
fi
# derived expression sprites (half-eye, smile) — mechanical transforms of existing art
if [ -f "$SPRITES/base.png" ] && [ ! -f "$SPRITES/eye_L_half.png" ] && [ -x "$PY" ]; then
  PYTHONPATH= "$PY" "$ROOT/scripts/derive_sprites.py" "$SPRITES" || echo "  sprite derivation failed (non-fatal)"
fi

echo "== setup summary =="
echo "  submodule : $([ -f "$SM/run.py" ] && echo present || echo MISSING)"
echo "  image     : $(docker image ls "$IMG" 2>/dev/null | grep -q faster_liveportrait && echo present || echo MISSING)"
echo "  run image : $(docker image inspect "$RUNIMG" >/dev/null 2>&1 && echo present || echo MISSING)"
echo "  checkpoints: $([ -n "$(find "$CKPT" -type f 2>/dev/null | head -1)" ] && echo present || echo MISSING)"
echo "  venv      : $([ -x "$PY" ] && echo present || echo MISSING)"
echo "  mp deps   : $("$PY" -c 'import mediapipe' 2>/dev/null && echo present || echo MISSING)"
echo "  mp model  : $([ -f "$MPMODEL" ] && echo present || echo MISSING)"
echo "  sprites   : $([ -f "$SPRITES/base.png" ] && echo present || echo MISSING)"
