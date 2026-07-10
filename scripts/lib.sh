# Shared constants and helpers for scripts/. Source, do not execute:
#   source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNIMG="drawface/flp:v3-x11"

list_video_nodes() {
  if ls /dev/video* >/dev/null 2>&1; then
    for dev in /dev/video*; do
      n="$(basename "$dev")"
      name="$(cat "/sys/class/video4linux/$n/name" 2>/dev/null || echo '?')"
      echo "  $dev -> $name"
    done
  else
    echo "  /dev/video*: MISSING"
  fi
}

# flp_run <human|animal> <RGB_NODE> — upstream FasterLivePortrait realtime run.
flp_run() {
  local mode="$1" node="${2:-}" extra=""
  [ "$mode" = animal ] && extra="--animal --paste_back"
  if [ -z "$node" ]; then
    echo "usage: $(basename "$0") <RGB_NODE>   e.g. /dev/video4" >&2
    exit 1
  fi
  [ -e "$node" ] || { echo "ERROR: camera node $node not found" >&2; exit 1; }
  [ -f "$ROOT/assets/source/character.png" ] || { echo "ERROR: assets/source/character.png missing" >&2; exit 1; }
  [ -n "$(find "$ROOT/checkpoints" -type f 2>/dev/null | head -1)" ] || { echo "ERROR: checkpoints/ empty — run scripts/setup.sh" >&2; exit 1; }
  [ -f "$ROOT/third_party/FasterLivePortrait/run.py" ] || { echo "ERROR: third_party/FasterLivePortrait submodule empty — run scripts/setup.sh" >&2; exit 1; }

  # shellcheck disable=SC2086
  docker run --rm -it --gpus all --name drawface_flp \
    -v "$ROOT/third_party/FasterLivePortrait:/root/FasterLivePortrait" \
    -v "$ROOT/checkpoints:/root/FasterLivePortrait/checkpoints" \
    -v "$ROOT/assets:/root/FasterLivePortrait/assets_local:ro" \
    -v /tmp/.X11-unix:/tmp/.X11-unix -e DISPLAY=:0 -e QT_X11_NO_MITSHM=1 \
    --device="$node:/dev/video0" -w /root/FasterLivePortrait \
    "$RUNIMG" \
    python run.py --src_image assets_local/source/character.png --dri_video 0 --cfg configs/onnx_infer.yaml --realtime $extra
}
