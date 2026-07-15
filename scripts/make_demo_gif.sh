#!/usr/bin/env bash
# Turn a DrawFace recording (output-canvas WebM) into an optimized README GIF
# with a caption band. The recording never contains the webcam feed, so the
# caption states what drives the animation.
#   make_demo_gif.sh <input.webm> [output.gif] [caption]
set -euo pipefail

IN="${1:?usage: make_demo_gif.sh <input.webm> [out.gif] [caption]}"
OUT="${2:-docs/img/demo.gif}"
CAPTION="${3:-웹캠 표정으로 실시간 구동  ·  ingon1026.github.io/drawface-live}"
FPS=15
WIDTH=420
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# Caption band below the square canvas; drawtext needs a Korean-capable font path.
FONT="$(fc-match -f '%{file}' 'sans:lang=ko' 2>/dev/null || true)"
[ -n "$FONT" ] || FONT=/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc
VF="fps=${FPS},scale=${WIDTH}:-1:flags=lanczos,\
pad=iw:ih+40:0:0:color=0x14161a,\
drawtext=fontfile='${FONT}':text='${CAPTION}':fontcolor=0xb7bec7:fontsize=15:x=(w-tw)/2:y=h-28"

ffmpeg -y -i "$IN" -vf "${VF},palettegen=stats_mode=diff" "$TMP/pal.png" 2>/dev/null
ffmpeg -y -i "$IN" -i "$TMP/pal.png" \
  -lavfi "${VF}[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=3" "$OUT" 2>/dev/null

printf 'wrote %s (%s)\n' "$OUT" "$(du -h "$OUT" | cut -f1)"
