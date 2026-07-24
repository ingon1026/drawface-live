# 🐷 DrawFace Live

**손그림 한 장이 웹캠 표정을 실시간으로 따라 합니다.**
엔진은 둘 — 눈·입 조각을 바꿔 끼우는 **스프라이트 오버레이**(웹, 기본)와 그림 자체를
메시로 구부리는 **ARAP 워프**(데스크톱, 차세대). 둘 다 원본 그림에 없는 픽셀을 만들지
않으므로 화풍이 변형 없이 유지됩니다.

[![Live Demo](https://img.shields.io/badge/▶_Live_Demo-ingon1026.github.io-2ea44f?style=for-the-badge)](https://ingon1026.github.io/drawface-live/)
[![MediaPipe](https://img.shields.io/badge/MediaPipe-Face_Landmarker-blue)](https://ai.google.dev/edge/mediapipe)

![데모 — 표정을 따라 하는 캐릭터](docs/img/demo.gif)

<sub>예시 캐릭터로 렌더링한 표정 시퀀스(윙크·깜빡임·입 모양·미소·고개). 웹캠을 켜면 이 동작이 내 표정을 따라 실시간으로 재생됩니다.</sub>

![표정 상태](docs/img/pig_states.png)

## ▶ 바로 체험

**https://ingon1026.github.io/drawface-live/** — 메인은 트랙 허브(그래픽·손그림·초상화·석고상).
손그림 앱은 [drawface-live/draw.html](https://ingon1026.github.io/drawface-live/draw.html),
소년 그래픽은 [drawface-live/boy.html](https://ingon1026.github.io/drawface-live/boy.html)로 바로 열립니다.

1. (손그림 앱) 그림 파일을 **드래그앤드롭** — 얼굴 자동 인식이 눈·입 위치를 찾아줍니다 (실패 시 4번 클릭)
2. **시작** → 웹캠 허용 → 정면·무표정으로 잠깐 캘리브레이션
3. 끝 — 윙크, 입 모양(아·에·이·오·우), 미소, 고개 움직임이 그림에 실시간 반영

그림이 아직 없으면 **예시 캐릭터로 체험**을 눌러 바로 시작할 수 있습니다. 새 그림은
저장 전에 기본·눈 감기·미소·입 벌리기 결과를 확인하고 위치를 다시 조정할 수 있으며,
실행 중 **녹화 시작**을 누르면 결과 캔버스만 WebM 영상으로 저장합니다.

추적·합성 전부 브라우저 안에서 실행되고, 캐릭터는 내 브라우저(localStorage)에만 저장됩니다.

3D 미러링(NVIDIA A2F mark 헤드)은 **메인 페이지에서 바로** 체험합니다 — mark 헤드는
[Maya-ACE](https://github.com/NVIDIA/Maya-ACE)(MIT) 파생으로 라이선스 확인 후 고지
포함([`docs/assets3d/LICENSE-mark.txt`](docs/assets3d/LICENSE-mark.txt)) 재배포합니다.

```mermaid
flowchart LR
    A[Webcam] --> B["MediaPipe Face Landmarker<br/>랜드마크 478점 · blendshape 52채널"]
    B --> C["중립 캘리브레이션<br/>EMA · 이중 임계 히스테리시스"]
    C --> D["눈 3단계 · 비즈메 선택<br/>2.5D 머리 변환"]
    D --> E["스프라이트 알파 합성<br/>원본 그림 위 출력"]
```

## 표정 매핑

| 입력 (blendshape) | 출력 |
| --- | --- |
| `eyeBlinkLeft/Right` | 눈 open / half / closed — 좌우 독립 윙크, 히스테리시스로 떨림 방지 |
| `jawOpen` 크기 | 입 I → E → A 단계 전환 |
| `mouthPucker` / `mouthFunnel` | U / O |
| `mouthSmile` (입 다문 상태) | smile |
| 눈썹·시선 채널 | 눈썹 오프셋·동공 이동 (스프라이트 있는 캐릭터) |
| 얼굴 변환 행렬 | 캔버스 2.5D 이동·회전 |
| 얼굴 소실 | 표정 유지 후 중립으로 감쇠 복귀 |

## 새 캐릭터 = 그림 1장

필요한 손작업은 **눈·입 위치 지정뿐** — 나머지 표정은 그림 자신의 획을 기하 변형해 자동 생성됩니다
(잉크 색·선 두께까지 실제 획에서 샘플링, 새 그림을 "생성"하지 않음).

수제 비즈메(위) vs 자동 파생(아래) — 수제 파일이 있으면 항상 우선:

![비즈메 비교](docs/img/auto_visemes.png)

입이 그려져 있지 않은 캐릭터도 manifest 선언만으로 전체 세트가 나옵니다:

![stick 자동 파생](docs/img/stick_auto.png)

## 데스크톱 버전 (Python · WSL2/Linux)

같은 파이프라인의 네이티브 구현. 웹캠은 usbipd로 WSL에 attach해 사용합니다.

```bash
bash scripts/setup.sh                          # venv + 모델 + 스프라이트 (idempotent)
PYTHONPATH= .venv/bin/python -m app.ui         # 컨트롤 패널 — 스프라이트 모드 (캐릭터·카메라 선택)
PYTHONPATH= .venv/bin/python -m app.onboard <그림> <이름>   # 4클릭 온보딩 도구

# ARAP 워프 모드 (아래 "ARAP 워프 모드" 참고)
PYTHONPATH= .venv/bin/python -m app.warp_live --image <그림.png>            # 얼굴 검출되는 그림
PYTHONPATH= .venv/bin/python -m app.warp_live --character assets/sprites/<이름>  # 4클릭 낙서 캐릭터

PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 PYTHONPATH= .venv/bin/python -m pytest tests/  # 테스트
```

> ROS 등 전역 pytest 플러그인이 설치된 환경에서도 프로젝트 테스트만 실행하도록
> `PYTEST_DISABLE_PLUGIN_AUTOLOAD=1`을 붙입니다.

영상 창 키: `q` 종료 · `c` 재캘리브레이션 · `m` 미러 전환.
임계값·게인은 전부 [`configs/app.yaml`](configs/app.yaml)에서 조정.
스프라이트 규약: [`assets/sprites/README.md`](assets/sprites/README.md)

> 카메라는 한쪽만 씁니다 — 웹앱은 Windows 카메라, 파이썬 앱은 WSL attach(`usbipd attach --wsl --busid <id>`).

### 카메라가 안 잡힐 때 (`/dev/video*` 없음)

**attach는 Windows 재부팅마다 풀립니다.** 커널 문제가 아니라 십중팔구 이것입니다 — PowerShell(관리자)에서:

```powershell
usbipd list                        # RealSense D455 의 BUSID 확인 (STATE 가 Shared 여도 attach 는 별도)
usbipd attach --wsl --busid 2-1    # 그 순간 WSL 에 /dev/video0~5 생성
```

- WSL 쪽 확인: `ls /dev/video*` — 권한이 `crw-rw-rw-`라 sudo 불필요
- 노드 판별(D455): **video4 = 깨끗한 RGB**(`configs/app.yaml`의 `index: 4`), video2 는 IR 도트 혼입, video0 은 depth
- 최초 1회만: `usbipd bind --busid 2-1` (Shared 로 만들기). 이후 재부팅엔 attach 만 다시

## 왜 결정론 방식인가 — 신경망 실측 비교

"사진 한 장이면 알아서 움직여주는" 신경망 모델 두 계열을 같은 조건에서 실측한 뒤
결정론(스프라이트·워프) 노선을 확정했습니다.

**① 워핑 계열 — [FasterLivePortrait](https://github.com/warmshao/FasterLivePortrait)**
는 실사 얼굴로 학습돼 입력이 실제 얼굴에 가까워야 동작합니다:

| 소스 | FLP 얼굴 검출 | 결과 |
| --- | --- | --- |
| 실사 얼굴 사진 | ✅ | 자연스럽게 워핑 (FLP의 강점) |
| **표준 비율 일러스트·명화** | ✅ | **입·눈·고개 추종 + 화풍 보존** — 아래 "일러스트 트랙" (2026-07-23 재실측) |
| 손그림(돼지) | ❌ human 실패 → animal만 | 머리 전체 워핑·뭉개짐 + paste-back 사각 자국 |
| **플랫 디지털 아바타·치비** | **❌ human 실패** (손그림과 동일) | animal로 구동되나 얼굴 변형 |

같은 그림 + 같은 표정 클립 비교 (`scripts/sprite_video.py`로 재현):

![스프라이트 vs FLP](docs/img/sprite_vs_flp.gif)

**② 디퓨전 계열 — [PersonaLive](https://github.com/GVCLab/PersonaLive)** (CVPR 2026,
실시간 스트리밍)도 실측: 일러스트가 **구동은 되지만** 출력이 모델의 학습 화풍(준실사)으로
**재생성**됩니다 — 왕눈·선 입 같은 캐릭터 디자인이 사라지고 프레임마다 얼굴이 드리프트.
실사 소스에서는 우수했으나(VRAM 피크 11.9GB, 4070 Ti 오프라인 ~3fps) 그림 도메인은 탈락.

결론: 갈림점은 매체가 아니라 **"실사에 얼마나 가까운가"**입니다. 그래서 **두 트랙**으로 갑니다 —
손그림·낙서·치비는 **원본 픽셀 밖을 만들지 않는 결정론 변형**(이 리포, 웹 데모)이 유일한 방법이고
(Live2D·Adobe Character Animator·Meta Animated Drawings 도 같은 방식), 표준 비율 일러스트·실사는
아래 신경망 트랙이 더 자연스럽습니다. 측정치·재현 절차: [`outputs/benchmark.md`](outputs/benchmark.md).

### 일러스트 트랙 — LivePortrait 실시간 (2026-07-23 재실측)

7/10 실측은 손그림 기준이었고, **표준 비율 일러스트에서 human 모드를 재실측한 결과 판정이
뒤집혔습니다**: TensorRT 27~37 ms/frame(≈30fps, RTX 4070 Ti)로 실시간 웹캠 퍼펫팅이 되고,
벌린 입 원본도 자연스럽게 다물며 화풍이 보존됩니다.

웹캠 드라이빙 실측 프레임 — 일러스트(벌린 입 원본):

![FLP 일러스트 실측](docs/img/flp_illust_ok.png)

명화(베르메르)도 동일:

![FLP 명화 실측](docs/img/flp_painting_ok.png)

업스트림에 그대로는 안 되고 카툰 퍼펫팅용 패치 3개가 필요합니다 — ① 실시간 경로 eye
retargeting 크래시 수정 ② eye retargeting 시 드라이빙 모션(입·고개)이 버려지는 설계를
모션 위 델타 가산으로 변경 ③ 고개 회전 축각 클램프(카툰은 큰 회전 정보가 없어 뭉개짐).
GPU 필수라 웹 데모에는 못 올라가며, 로컬 실행(원커맨드 `live.sh`)·도커 셋업·패치 상세는
별도 로컬 클론에 정리돼 있습니다. 웹 통합(로컬 서버 + 브라우저 스트림)은 설계 완료, 미착수.

## ARAP 워프 모드 (차세대 엔진)

스프라이트의 남은 약점 — 패치 교체 경계의 "붙인 티" — 를 원리적으로 없앤 두 번째 엔진.
[Meta AnimatedDrawings](https://github.com/facebookresearch/AnimatedDrawings)의 ARAP
솔버(MIT, 단일 파일 벤더링) 위에 메시 자동 생성과 표정 채널을 얹었습니다
([`app/warp_rig.py`](app/warp_rig.py)). 눈·입을 지우고 붙이는 대신 **그림 자체의 획이
움직이므로** 볼·주변부까지 자연스럽게 따라갑니다.

| | 스프라이트 오버레이 | ARAP 워프 |
| --- | --- | --- |
| 원리 | 눈·입 조각 교체 | 제어점 이동 → 메시 변형 |
| 표정 | 이산 상태 (open/half/closed, 비즈메) | 연속 채널 (blink L/R · smile · jaw, 0~1) |
| 강점 | 완전 감김·입 안쪽까지 명확한 상태 표현 | 붙인 티 0, 부드러운 중간 표정 |
| 완전 감김·입 내부 | 스프라이트 교체 | **하이브리드 레이어** — 워프된 메시를 따라가는 폴리곤에 그림에서 샘플한 색으로 그림 (박스 아님 → 붙인 티 없음) |
| 지원 | 웹 + 데스크톱 | **웹(기본 엔진) + 데스크톱** — 웹은 `워프 엔진` 토글로 스프라이트 폴백 가능 |

두 입력 루트가 같은 엔진으로 수렴합니다:

- **얼굴이 검출되는 그림** (일러스트 등): MediaPipe 랜드마크 478점 → 메시 자동 생성 — `--image`
- **검출 안 되는 낙서** (졸라맨·크레용): 온보딩 4클릭 박스 → 가상 랜드마크 합성 — `--character`

```bash
PYTHONPATH= .venv/bin/python -m app.warp_live --image <그림.png>                 # 라이브 (웹캠)
PYTHONPATH= .venv/bin/python -m app.warp_live --character assets/sprites/<이름>
PYTHONPATH=. .venv/bin/python scripts/warp_demo.py --image <그림.png> --out outputs/warp_demo  # 오프라인 스틸
```

512² 기준 프레임당 solve+렌더 ≈ 5~9 ms(CPU)로 실시간 여유가 큽니다. 게인은
[`configs/app.yaml`](configs/app.yaml)의 `warp:` 섹션.

완전 눈감김은 blink 0.7→1.0 구간에서 눈꺼풀 실(폴리곤 채움+감김 선)이 알파로 차올라
**팝 없이 연속으로** 닫히고, 입 내부는 jaw가 커지면 입술 링이 실제로 분리되며 그 사이가
입안색으로 채워집니다. 색은 전부 그림 자체에서 샘플(눈 주변 밝은 픽셀 중앙값 = 눈꺼풀,
어두운 분위수 = 잉크선) — 새 그림을 생성하지 않습니다.

웹 이식(`docs/js/warp.js`)은 같은 메시·필드·하이브리드 설계를 canvas 삼각형 매핑으로
렌더합니다(측정 0.6 ms/frame). 데스크톱과의 유일한 차이는 볼 정점 처리 — ARAP 솔브 대신
빌드 타임에 구운 역거리 가중치로 근사합니다(자유 정점이 볼 6개뿐이라 시각 차이 없음).

세 가지 최근 개선 (웹·데스크톱 공통):

- **One Euro 필터**로 고정 EMA를 교체 — 정지 시엔 부드럽게, 빠른 움직임(깜빡임)엔 지연 없이
  따라갑니다. 파라미터는 [`configs/app.yaml`](configs/app.yaml)의 `smoothing:`
  (`min_cutoff`·`beta`·`head_min_cutoff`·`head_beta`), 웹은 `docs/js/config.js`에 동일 반영.
- **실측 랜드마크 우선** (웹): 검출되는 그림은 온보딩 때 저장한 MediaPipe 랜드마크
  (`manifest.landmarks`)로 눈꺼풀·입술 기하를 잡습니다 — 박스 합성 링보다 정밀. 단, 각 특징
  링이 클릭한 박스에 잘 정렬됐을 때만 신뢰(중심 오차 1/4 박스 이내, 링 폭 ≥ 박스 45%),
  아니면 박스 루트로. 낙서는 계속 박스 루트.
- **유휴 모션**: 얼굴이 정지·소실돼도 살아 있게 — 미세한 호흡 흔들림(pitch 사인파)과
  4~7초 무깜빡임 시 자동 깜빡임. 설정은 양쪽 `idle:` 섹션.

## 프라이버시

- 웹캠 영상은 **어디로도 전송·저장되지 않습니다** (웹: 브라우저 내 처리, 데스크톱: 로컬 처리)
- **녹화(웹, 선택 기능)**: 기본 꺼짐. `녹화 시작`을 눌렀을 때만, 그리고 **웹캠 화면이 아니라 캐릭터 결과 캔버스만** WebM으로 저장(내 기기로 직접 다운로드). 녹화 중에는 버튼이 `녹화 종료`로 바뀌어 상태가 드러납니다
- 텔레메트리·분석·계정 없음
- 추적 모델은 MediaPipe 공식 저장소에서 로드

## 구조

```text
docs/     웹앱 (GitHub Pages 루트) — 정적 파일, 빌드 없음
app/      데스크톱 파이프라인 (config · camera · tracker · compositor · UI · onboard · warp_rig · warp_live)
scripts/  setup · diagnose · 스프라이트 파생 · 워프 데모 · FasterLivePortrait 실행
tests/    시맨틱 매핑 · 상태머신 · 설정 · 온보딩 · 워프 리그 검증
third_party/FasterLivePortrait   평가용 업스트림 (서브모듈, 무수정)
third_party/animated_drawings    ARAP 솔버 (MIT, 단일 파일 벤더링)
```
