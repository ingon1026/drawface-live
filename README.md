# DrawFace Live

## 목표

사용자의 실시간 웹캠 얼굴 움직임(좌/우 윙크, 깜빡임, 입 벌림, 미소, 머리 움직임)을
손그림 캐릭터 한 장에 전이하는 WSL2 데스크톱 프로토타입.
Meta Animated Drawings의 "얼굴 애니메이션" 대응판.

## Phase 1 결과 (2026-07-10, 라이브 웹캠 실측)

[warmshao/FasterLivePortrait](https://github.com/warmshao/FasterLivePortrait)
(commit `8aad360`, Docker, ONNX GPU)를 무수정으로 검증한 결과:

- **Human 모드**: 손그림(돼지)에서 소스 얼굴 검출 실패 (insightface·MediaPipe 모두) → 구동 불가
- **Animal 모드**: XPose가 검출 성공, 실시간 구동됨(~8.1–8.4 FPS, VRAM 피크 ~11.5GiB).
  그러나 **머리 영역이 심하게 뭉개져 사용 불가** — 실사 학습 워핑 모델에 선화는 분포 밖 입력
- 몸통/배경 보존(paste_back)은 정상 동작

상세 수치: [`outputs/benchmark.md`](outputs/benchmark.md) / [`outputs/benchmark.json`](outputs/benchmark.json)

**판정**: CLAUDE.md Phase 3 규칙 충족 → **Phase 5 MediaPipe 스프라이트 폴백**으로 전환
(웹캠 표정 추적 + 원본 그림 위 스프라이트 합성, 화풍 100% 보존). 구현 진행 중.

## 검증된 환경

| 항목 | 값 |
| --- | --- |
| OS | WSL2 Ubuntu 24.04 (WSLg) |
| GPU | NVIDIA RTX 4070 Ti 12GB, 드라이버 591.86 |
| 런타임 | Docker Desktop + 파생 이미지 `drawface/flp:v3-x11` (`docker/Dockerfile`) |
| 웹캠 | Intel RealSense 455, usbipd attach → RGB는 `/dev/video4` (YUYV 640×480@30) |
| 엔진 커밋 | upstream `8aad3602177547aaa5e4beec0c3ef5b7944e7a1f` (`THIRD_PARTY.md`) |

> **의도된 스펙 이탈:** 실행 스크립트는 `.ps1`이 아니라 `.sh`다.
> 실제 런타임 환경이 Windows PowerShell이 아니라 WSL2 + Docker이기 때문이다.

## 설정 순서 (전부 실측 검증됨)

1. **웹캠 attach** (Windows측, usbipd-win 필요):
   ```powershell
   usbipd attach --wsl --busid 2-1
   ```
2. **엔진/체크포인트 설정** (WSL) — 서브모듈, 이미지 pull+파생 빌드, 체크포인트 3.1GB:
   ```bash
   bash scripts/setup.sh
   ```
3. **RGB 노드 확인** — RealSense는 `/dev/video0-5`를 노출하며 이름만으로 구분 불가:
   ```bash
   bash scripts/probe_camera.sh              # 노드 목록
   bash scripts/probe_camera.sh /dev/video4  # 한 프레임만 확인 (저장 안 함)
   ```
4. **실시간 구동** — 확인된 RGB 노드를 인자로:
   ```bash
   bash scripts/run_human.sh  /dev/video4   # human 모드 (이 소스에선 검출 실패로 종료)
   bash scripts/run_animal.sh /dev/video4   # animal 모드 (+paste_back)
   ```
   창이 뜨는 **첫 프레임이 모션 기준(중립)**이므로 시작 시 정면·무표정 유지.
   `q` 종료. paste_back 없이 실행하면 `[드라이빙|출력]` 나란히 보기.

환경 점검은 언제든:
```bash
bash scripts/diagnose.sh
```

## Phase 5 — 스프라이트 폴백 (현재 동작 확인된 파이프라인)

MediaPipe Face Landmarker(랜드마크 478점 + blendshape 52채널)로 표정을 추적해
원본 그림 위에 눈/입 스프라이트를 합성한다. **화풍 100% 보존.** 라이브 웹캠으로 검증 완료:
윙크 좌/우 독립, 깜빡임(히스테리시스), 입 벌림 단계(I/E/A)·오므림(U/O)·미소, 고개 2.5D 모션.

```bash
bash scripts/setup.sh                     # .venv + face_landmarker.task + 스프라이트 (idempotent)
PYTHONPATH= .venv/bin/python -m app.main  # configs/app.yaml 기반 실행
```

- 시작 시 30프레임 **중립 캘리브레이션** — 정면·무표정 유지
- 창: `[웹캠 프리뷰(미러)+추적 시각화 | 캐릭터]` — 프리뷰에 랜드마크 점·신호 바 표시
- 키: `q`/ESC 종료 · `c` 재캘리브레이션 · `m` 미러 좌우 전환
- 모든 임계값은 `configs/app.yaml`에서 조정 (블링크 open/close 이중 임계, EMA, 머리 gain, lost-face 타임아웃)
- 테스트: `PYTHONPATH= .venv/bin/python -m pytest tests/` (좌우 시맨틱 매핑·히스테리시스·비즈메 선택 검증)

스프라이트 규약과 누락 목록: `assets/sprites/README.md`

## 소스 이미지

`assets/source/character.png`는 커밋되지 않는다(개인 이미지). 원하는 512×512 그림을
그 경로에 놓으면 된다 (RGBA면 흰 배경으로 flatten 권장).

## 프라이버시

웹캠 프레임은 로컬에서만 처리하며 **어떤 스크립트도 프레임을 저장하지 않는다.**
외부 전송·분석·텔레메트리 없음. 카메라 프로브도 한 프레임을 읽어 통계만 출력한다.
업스트림 run.py가 종료 시 남기는 드라이빙 모션 pkl(`results/`)은 실행 후 삭제한다.
