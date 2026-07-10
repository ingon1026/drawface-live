#!/usr/bin/env bash
# Human-mode real-time FasterLivePortrait on the live webcam.
#   run_human.sh <RGB_NODE>    e.g. run_human.sh /dev/video4
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMG="drawface/flp:v3-x11"

NODE="${1:-}"
if [ -z "$NODE" ]; then
  echo "usage: $(basename "$0") <RGB_NODE>   e.g. /dev/video4" >&2
  exit 1
fi
[ -e "$NODE" ] || { echo "ERROR: camera node $NODE not found" >&2; exit 1; }
[ -f "$ROOT/assets/source/character.png" ] || { echo "ERROR: assets/source/character.png missing" >&2; exit 1; }
[ -n "$(find "$ROOT/checkpoints" -type f 2>/dev/null | head -1)" ] || { echo "ERROR: checkpoints/ empty — run scripts/setup.sh" >&2; exit 1; }
[ -f "$ROOT/third_party/FasterLivePortrait/run.py" ] || { echo "ERROR: third_party/FasterLivePortrait submodule empty — run scripts/setup.sh" >&2; exit 1; }

docker run --rm -it --gpus all --name drawface_flp \
  -v "$ROOT/third_party/FasterLivePortrait:/root/FasterLivePortrait" \
  -v "$ROOT/checkpoints:/root/FasterLivePortrait/checkpoints" \
  -v "$ROOT/assets:/root/FasterLivePortrait/assets_local:ro" \
  -v /tmp/.X11-unix:/tmp/.X11-unix -e DISPLAY=:0 -e QT_X11_NO_MITSHM=1 \
  --device="$NODE:/dev/video0" -w /root/FasterLivePortrait \
  "$IMG" \
  python run.py --src_image assets_local/source/character.png --dri_video 0 --cfg configs/onnx_infer.yaml --realtime
