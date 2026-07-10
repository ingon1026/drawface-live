#!/usr/bin/env bash
# Animal-mode real-time FasterLivePortrait on the live webcam (pig-like drawing).
#   run_animal.sh <RGB_NODE>    e.g. run_animal.sh /dev/video4
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
flp_run animal "${1:-}"
