#!/usr/bin/env bash
# Camera probe. Saves NOTHING.
#   probe_camera.sh          -> list /dev/video* with their names
#   probe_camera.sh /dev/videoN -> grab ONE frame via docker, print ret/shape/mean
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
IMG="$RUNIMG"

if [ $# -eq 0 ]; then
  echo "== video nodes =="
  list_video_nodes
  echo
  echo "usage: $(basename "$0") /dev/videoN   # probe one node (one frame, saved nowhere)"
  exit 0
fi

NODE="$1"
if [ ! -e "$NODE" ]; then
  echo "ERROR: $NODE does not exist" >&2
  exit 1
fi

docker run --rm --device="$NODE:/dev/video0" "$IMG" \
  python -c "
import cv2
cap = cv2.VideoCapture(0)
ok, frame = cap.read()
cap.release()
if not ok or frame is None:
    print('ret=False — no frame from $NODE')
else:
    print('ret=True shape=%s mean=%.1f' % (frame.shape, float(frame.mean())))
"
