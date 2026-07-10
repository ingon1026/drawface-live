#!/usr/bin/env bash
# Human-mode real-time FasterLivePortrait on the live webcam.
#   run_human.sh <RGB_NODE>    e.g. run_human.sh /dev/video4
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
flp_run human "${1:-}"
