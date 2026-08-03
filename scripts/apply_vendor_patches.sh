#!/usr/bin/env bash
# 일러스트 트랙(LivePortrait 실시간 카툰 퍼펫팅)에 필요한 로컬 패치를 서브모듈에 얹는다.
# 업스트림에는 없는 변경이라 이 패치 없이는 일러스트 트랙이 동작하지 않는다 — 배경은
# THIRD_PARTY.md 의 "FasterLivePortrait" 항목.
#
#   ./scripts/apply_vendor_patches.sh          vendor_patches/faster-live-portrait/*.patch 를 순서대로 적용
#   ./scripts/apply_vendor_patches.sh --check  적용하지 않고 적용 가능 여부만 확인 (불가하면 exit 1)
#
# 패치는 커밋이 아니라 워킹트리에 얹는다(git am 아닌 git apply). 서브모듈 HEAD 는 고정 SHA 로
# 남고 대신 부모 리포에 "modified content" 로 보인다 — 정상이다. 되돌리려면
#   git -C third_party/FasterLivePortrait checkout -- .
#
# 이미 적용돼 있으면 조용히 넘어간다(재실행 안전). exit 1 = 패치가 안 붙음, exit 2 = 환경 문제.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SM="$ROOT/third_party/FasterLivePortrait"
PATCH_DIR="${VENDOR_PATCH_DIR:-$ROOT/vendor_patches/faster-live-portrait}"

if [ ! -e "$SM/.git" ]; then
  echo "✘ 서브모듈 third_party/FasterLivePortrait 가 체크아웃돼 있지 않습니다." >&2
  echo "→ git submodule update --init third_party/FasterLivePortrait" >&2
  exit 2
fi

shopt -s nullglob
patches=("$PATCH_DIR"/*.patch)   # 글롭은 사전순 = format-patch 의 0001, 0002 … 순서
shopt -u nullglob
if [ "${#patches[@]}" -eq 0 ]; then
  echo "✘ 패치 파일이 없습니다: $PATCH_DIR/*.patch" >&2
  exit 2
fi

# 부모 리포가 기록한 gitlink SHA 가 이 패치들이 전제하는 업스트림 커밋이다.
expected="$(git -C "$ROOT" rev-parse "HEAD:third_party/FasterLivePortrait")"
actual="$(git -C "$SM" rev-parse HEAD)"
if [ "$expected" != "$actual" ]; then
  echo "✘ 서브모듈이 기대한 업스트림 커밋에 있지 않습니다." >&2
  echo "  기대: $expected" >&2
  echo "  현재: $actual" >&2
  echo "→ git submodule update --init third_party/FasterLivePortrait 로 맞춘 뒤 다시 실행하세요." >&2
  exit 2
fi

# 패치들을 고정 SHA 의 임시 워크트리에 순서대로 적용해 "합친 diff" 하나로 만든다.
# 이 과정 자체가 --check 이고, 동시에 재실행 안전성의 근거이기도 하다:
#   · git apply --check 는 패치를 여러 개 줘도 앞 패치의 결과를 반영하지 않아 순서 의존을 못 본다.
#   · 뒤 패치가 앞 패치가 건드린 줄을 또 고치면 패치 낱개로는 "이미 적용됐는지"를 판정할 수 없다.
#     합친 diff 하나면 --reverse --check 한 번으로 정확히 판정된다.
series="$(mktemp)"
wt="$(mktemp -d)"
trap 'git -C "$SM" worktree remove --force "$wt" >/dev/null 2>&1 || rm -rf "$wt"; rm -f "$series"' EXIT
git -C "$SM" worktree add --detach -q "$wt" "$expected"
for p in "${patches[@]}"; do
  if ! git -C "$wt" apply --whitespace=nowarn "$p"; then
    echo "✘ 적용 불가: $(basename "$p") — 업스트림 ${expected:0:7} 에 붙지 않습니다." >&2
    exit 1
  fi
done
git -C "$wt" add -A                                   # 패치가 새로 만든 파일도 diff 에 담기게
git -C "$wt" diff --cached --binary > "$series"

if [ "${1:-}" = "--check" ]; then
  echo "✔ 패치 ${#patches[@]}개가 업스트림 ${expected:0:7} 에 깨끗이 적용됩니다"
  exit 0
fi

if git -C "$SM" apply --reverse --check "$series" 2>/dev/null; then
  echo "✔ 이미 적용돼 있습니다 — 패치 ${#patches[@]}개, 변경 없음"
elif git -C "$SM" apply "$series"; then
  echo "✔ 벤더 패치 ${#patches[@]}개를 적용했습니다 (업스트림 ${expected:0:7} 위)."
  echo "  서브모듈이 'modified content' 로 보이는 것은 정상입니다."
else
  echo "✘ 적용 실패 — 서브모듈이 부분 적용되었거나 손으로 수정된 상태일 수 있습니다." >&2
  echo "→ git -C third_party/FasterLivePortrait checkout -- . 로 되돌린 뒤 다시 실행하세요." >&2
  exit 1
fi
