#!/usr/bin/env bash
# docs/avatar_core.js 는 talking-drawing-avatar 의 static/avatar_core.js 를 벤더링한 사본이다.
# 벤더 헤더(파일 첫 주석 블록)만 이 리포 고유로 두고, 그 아래 본문은 원본과 바이트 단위로 같아야 한다.
#
#   ./scripts/sync_avatar_core.sh          원본 본문을 내려받아 갱신 (헤더는 보존)
#   ./scripts/sync_avatar_core.sh --check  본문이 원본과 같은지만 확인 (다르면 exit 1)
#
# 원본은 ~/face 가 있으면 거기서, 없으면 GitHub raw 에서 읽는다 (CI 는 후자).
# AVATAR_CORE_UPSTREAM 으로 원본 경로를 덮어쓸 수 있다. 로컬에서 CI 와 같은 raw 경로를
# 시험할 때 쓴다: AVATAR_CORE_UPSTREAM=/nonexistent ./scripts/sync_avatar_core.sh --check
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENDORED="$ROOT/docs/avatar_core.js"
LOCAL_UPSTREAM="${AVATAR_CORE_UPSTREAM:-$HOME/face/static/avatar_core.js}"
RAW_URL="https://raw.githubusercontent.com/ingon1026/talking-drawing-avatar/main/static/avatar_core.js"

# 첫 주석 블록(' */' 로 끝나는 줄)까지가 헤더, 그 다음부터가 본문.
body() { awk 'f { print } /^ \*\//  { f = 1 }' "$1"; }

upstream_raw="$(mktemp)"; trap 'rm -f "$upstream_raw"' EXIT
if [ -f "$LOCAL_UPSTREAM" ]; then
  cp "$LOCAL_UPSTREAM" "$upstream_raw"
  source_desc="$LOCAL_UPSTREAM"
else
  curl -fsSL "$RAW_URL" -o "$upstream_raw"
  source_desc="$RAW_URL"
fi

if ! grep -q '^ \*/' "$upstream_raw" || ! grep -q '^ \*/' "$VENDORED"; then
  echo "✘ 헤더 주석 블록(' */')을 찾지 못했습니다 — 파일 서식이 바뀌었으면 이 스크립트도 함께 고치세요." >&2
  exit 2
fi

if [ "${1:-}" = "--check" ]; then
  # `|| true` 가 없으면 diff 의 exit 1 이 set -e 로 스크립트를 여기서 죽여, 정작 필요한
  # 조치 안내가 출력되지 않는다. exit code 는 1 로 같아 CI 만 보면 눈치채지 못한다.
  delta="$(diff <(body "$VENDORED") <(body "$upstream_raw") || true)"
  if [ -z "$delta" ]; then
    echo "✔ docs/avatar_core.js 본문이 원본과 일치합니다 ($source_desc)"
    exit 0
  fi
  {
    echo "✘ docs/avatar_core.js 가 원본보다 뒤처졌습니다 ($source_desc)"
    printf '%s\n' "$delta" | head -40
    echo "→ ./scripts/sync_avatar_core.sh 로 갱신한 뒤 커밋하세요."
  } >&2
  exit 1
fi

{ sed -n '1,/^ \*\//p' "$VENDORED"; body "$upstream_raw"; } > "$VENDORED.tmp"
mv "$VENDORED.tmp" "$VENDORED"
echo "✔ docs/avatar_core.js 본문을 갱신했습니다 ($source_desc). 헤더는 그대로 두었습니다."
