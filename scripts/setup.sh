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
# 스프라이트는 사용자가 직접 그린 그림에서 파생돼 이 리포에는 커밋되지 않는다(.gitignore).
# 원본은 자매 리포에 공개돼 있으므로 로컬 체크아웃이 없으면 거기서 내려받는다.
# 자기 그림을 쓰려면: PIGSRC=~/art/pig ./scripts/setup.sh
PIGSRC="${PIGSRC:-$HOME/face/assets_characters/pig}"
SPRITE_REPO="ingon1026/talking-drawing-avatar"
SPRITE_PATH="assets_characters/pig"

# 자매 리포에서 스프라이트 한 벌을 받아온다. 파일 목록은 GitHub contents API 로 나열한다 —
# 하드코딩하면 원본에 파일이 늘어날 때 조용히 어긋난다(manifest.json 은 설정만 담고 목록이 없다).
# 임시 디렉터리에 다 받은 뒤 옮겨, 중간에 끊겨도 반쯤 채워진 상태가 남지 않게 한다.
fetch_sprites() {
  [ -x "$PY" ] || return 1
  local tmp names
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' RETURN
  curl -fsSL "https://api.github.com/repos/$SPRITE_REPO/contents/$SPRITE_PATH" -o "$tmp/listing.json" || return 1
  names="$(PYTHONPATH= "$PY" -c '
import json, sys
try:
    items = json.load(open(sys.argv[1]))
except Exception:
    sys.exit(1)
for it in items:
    n = it.get("name", "")
    if it.get("type") == "file" and (n.endswith(".png") or n == "manifest.json"):
        print(n)
' "$tmp/listing.json")" || return 1
  [ -n "$names" ] || return 1
  while read -r n; do
    curl -fsSL -o "$tmp/$n" "https://raw.githubusercontent.com/$SPRITE_REPO/main/$SPRITE_PATH/$n" || return 1
  done <<<"$names"
  mkdir -p "$SPRITES"
  mv "$tmp"/*.png "$tmp/manifest.json" "$SPRITES"/
}

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
# Python deps — install is idempotent and corrects pinned packages without
# deleting optional developer tooling already present in a reused venv.
uv pip install --python "$PY" --requirement "$ROOT/requirements.txt"
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
elif fetch_sprites; then
  echo "  downloaded pig sprites from $SPRITE_REPO"
else
  echo "  WARNING: 스프라이트를 로컬($PIGSRC)에서도 $SPRITE_REPO 에서도 가져오지 못했습니다."
  echo "           네트워크 문제라면 다시 실행하고, 자기 그림을 쓰려면"
  echo "           PIGSRC=<내_그림_폴더> ./scripts/setup.sh 로 넘기세요."
  echo "           필요한 파일은 assets/sprites/README.md 참고."
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
