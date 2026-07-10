#!/usr/bin/env bash
# Idempotent setup: submodule, docker image, checkpoints. Each step skips if done.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMG="shaoguo/faster_liveportrait:v3"
RUNIMG="drawface/flp:v3-x11"
SM="$ROOT/third_party/FasterLivePortrait"
CKPT="$ROOT/checkpoints"

echo "== [1/3] submodule =="
if [ -f "$SM/run.py" ]; then
  echo "  already checked out — skipping"
else
  # NOTE: requires .gitmodules (owned by Agent B / third_party setup).
  git -C "$ROOT" submodule update --init "third_party/FasterLivePortrait" \
    || echo "  submodule not configured (no .gitmodules yet) — skipping"
fi

echo "== [2/3] docker image =="
if docker image ls "$IMG" 2>/dev/null | grep -q faster_liveportrait; then
  echo "  $IMG already present — skipping"
else
  docker pull "$IMG"
fi

echo "== [2b/3] derived runtime image (X11 libs) =="
if docker image inspect "$RUNIMG" >/dev/null 2>&1; then
  echo "  $RUNIMG already present — skipping"
else
  docker build -t "$RUNIMG" "$ROOT/docker/"
fi

echo "== [3/3] checkpoints =="
if [ -n "$(find "$CKPT" -type f 2>/dev/null | head -1)" ]; then
  echo "  checkpoints/ already populated — skipping"
else
  uvx --from 'huggingface_hub[cli]' huggingface-cli download \
    warmshao/FasterLivePortrait --local-dir "$CKPT"
fi

echo "== setup summary =="
echo "  submodule : $([ -f "$SM/run.py" ] && echo present || echo MISSING)"
echo "  image     : $(docker image ls "$IMG" 2>/dev/null | grep -q faster_liveportrait && echo present || echo MISSING)"
echo "  run image : $(docker image inspect "$RUNIMG" >/dev/null 2>&1 && echo present || echo MISSING)"
echo "  checkpoints: $([ -n "$(find "$CKPT" -type f 2>/dev/null | head -1)" ] && echo present || echo MISSING)"
