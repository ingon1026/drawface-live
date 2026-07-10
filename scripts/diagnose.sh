#!/usr/bin/env bash
# Read-only environment report for DrawFace Live. Never captures or saves frames.
# Tolerant by design: prints MISSING instead of aborting on any absent tool.
set -u
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
IMG="$RUNIMG"

hr() { printf '%s\n' "----------------------------------------"; }

echo "== DrawFace Live diagnostics =="
echo "root: $ROOT"
hr

echo "[OS / kernel]"
uname -srmo 2>/dev/null || echo "  MISSING"
echo "DISPLAY=${DISPLAY:-MISSING}"
hr

echo "[GPU]"
if command -v nvidia-smi >/dev/null 2>&1; then
  nvidia-smi --query-gpu=name,memory.used,memory.total --format=csv,noheader 2>&1 || echo "  nvidia-smi FAILED"
else
  echo "  nvidia-smi: MISSING"
fi
hr

echo "[Docker]"
if command -v docker >/dev/null 2>&1; then
  docker --version 2>&1 || echo "  docker --version FAILED"
  if docker image inspect "$IMG" >/dev/null 2>&1; then
    docker image ls "$IMG" --format '  image: {{.Repository}}:{{.Tag}} ({{.Size}})' 2>/dev/null
  else
    echo "  image $IMG: MISSING"
  fi
else
  echo "  docker: MISSING"
fi
hr

echo "[Video nodes]"
list_video_nodes
hr

echo "[Assets]"
if [ -f "$ROOT/assets/source/character.png" ]; then
  echo "  character.png: present"
else
  echo "  character.png: MISSING"
fi
hr

echo "[Checkpoints]"
CKPT="$ROOT/checkpoints"
if [ -d "$CKPT" ]; then
  cnt="$(find "$CKPT" -type f 2>/dev/null | wc -l)"
  sz="$(du -sh "$CKPT" 2>/dev/null | cut -f1)"
  echo "  files: ${cnt:-0}, size: ${sz:-?}"
else
  echo "  checkpoints/: MISSING"
fi
hr

echo "[Submodule]"
SM="$ROOT/third_party/FasterLivePortrait"
sha="$(git -C "$SM" rev-parse HEAD 2>/dev/null)"
echo "  commit: ${sha:-MISSING}"
hr

echo "done."
