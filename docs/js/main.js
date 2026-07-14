// DrawFace Live web — UI wiring and the render loop (browser twin of app/main.py).
import { CONFIG } from "./config.js";
import { fit512, expandBoxToInk } from "./imageops.js";
import { buildCharacter } from "./onboard.js";
import { deriveAll } from "./derive.js";
import { listCharacters, saveCharacter, deleteCharacter, loadCharacter } from "./store.js";
import {
  SMOOTH_KEYS, Ema, TriStateEye, Calibration,
  pickMouth, eyeKeyForUserSide,
} from "./pipeline.js";
import { createTracker, detectOnImage } from "./tracker.js";
import { prepareCharacter, composeCharacter, drawScene } from "./compositor.js";

const $ = (id) => document.getElementById(id);
const status = (msg) => { $("status").textContent = msg; };

// Surface every failure in the status line — the user has no console open.
window.addEventListener("error", (e) => status(`오류: ${e.message}`));
window.addEventListener("unhandledrejection", (e) => status(`오류: ${e.reason?.message ?? e.reason}`));

const VIZ_BARS = [
  ["eyeL", "eyeBlinkLeft"], ["eyeR", "eyeBlinkRight"], ["jaw", "jawOpen"],
  ["smile", "mouthSmileLeft"], ["pucker", "mouthPucker"],
];
const CLICK_STEPS = ["왼눈 중심", "오른눈 중심", "입 좌상단", "입 우하단"];

// ---------- camera list ----------
// RealSense-class devices expose several video inputs (RGB/depth/IR) — the
// browser's default pick can be the wrong one, so let the user choose.
async function refreshCameras() {
  const sel = $("camSelect");
  const cur = sel.value;
  sel.innerHTML = "";
  try {
    const devs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "videoinput");
    devs.forEach((d, i) => sel.add(new Option(d.label || `카메라 ${i + 1}`, d.deviceId)));
    if ([...sel.options].some((o) => o.value === cur)) sel.value = cur;
    const rgb = [...sel.options].find((o) => /rgb|color/i.test(o.text));
    if (rgb && !cur) sel.value = rgb.value;
  } catch { /* enumerate unavailable — default device will be used */ }
}
navigator.mediaDevices?.addEventListener?.("devicechange", refreshCameras);

const CAM_ERRORS = {
  NotAllowedError: "카메라 권한이 차단됐습니다 — 주소창의 자물쇠/카메라 아이콘에서 '허용'으로 바꾸고 새로고침하세요",
  NotFoundError: "카메라를 찾을 수 없습니다 — 연결 상태를 확인하세요 (WSL에 attach된 카메라는 Windows에서 보이지 않습니다)",
  NotReadableError: "다른 프로그램이 카메라를 사용 중입니다 — 해당 앱을 닫고 다시 시도하세요",
  OverconstrainedError: "선택한 카메라가 요청 해상도를 지원하지 않습니다 — 다른 카메라를 선택해 보세요",
};

// ---------- character list ----------
function refreshList(selectName) {
  const sel = $("charSelect");
  sel.innerHTML = "";
  for (const name of listCharacters()) sel.add(new Option(name, name));
  if (selectName) sel.value = selectName;
  $("startBtn").disabled = sel.options.length === 0;
}

// ---------- onboarding ----------
const ob = { img: null, points: [] };

function obStatus() {
  const n = ob.points.length;
  $("onboardStatus").textContent = n < 4
    ? `클릭 ${n + 1}/4: ${CLICK_STEPS[n]}`
    : "좌표 완료 — 이름을 확인하고 [생성]";
  $("obGenerate").disabled = n < 4 || !$("charName").value.trim();
}

function obRedraw() {
  const ctx = $("onboardCanvas").getContext("2d");
  ctx.drawImage(ob.img, 0, 0);
  ctx.strokeStyle = "#e33";
  ctx.lineWidth = 2;
  ob.points.forEach(([x, y]) => { ctx.beginPath(); ctx.arc(x, y, 4, 0, 7); ctx.stroke(); });
  if (ob.points.length === 4) {
    const [, , [x0, y0], [x1, y1]] = ob.points;
    ctx.strokeRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
  }
}

async function openOnboarding(file) {
  const bmp = await createImageBitmap(file);
  ob.img = fit512(bmp);
  ob.points = [];
  $("charName").value = file.name.replace(/\.[^.]+$/, "").replace(/[^\w-]+/g, "-").toLowerCase();
  $("onboardDlg").showModal();
  obRedraw();
  $("onboardStatus").textContent = "얼굴 자동 인식 시도 중…";
  // Photo-trained models often miss hand drawings — prefill when it works,
  // fall back to manual clicks when it doesn't (see outputs/benchmark.md).
  const auto = await detectOnImage(ob.img);
  if (auto && ob.points.length === 0) {
    ob.points = [auto.eyes.L, auto.eyes.R,
                 [auto.mouthBox[0], auto.mouthBox[1]], [auto.mouthBox[2], auto.mouthBox[3]]];
    expandMouthPoints(); // landmark lip box misses deep open-mouth interiors
    $("eyeHalf").value = auto.eyeHalf;
    obRedraw();
    obStatus();
    $("onboardStatus").textContent = "얼굴 자동 인식됨 — 위치가 맞으면 [생성], 틀리면 [다시 클릭]";
  } else if (ob.points.length === 0) {
    obStatus(); // manual flow from step ①
  }
}

// After the 4th click (or auto-detect), grow the mouth box to cover the whole
// drawn mouth — deep open mouths otherwise leave leftovers ("second mouth").
function expandMouthPoints() {
  const [, , [mx0, my0], [mx1, my1]] = ob.points;
  const box = expandBoxToInk(ob.img,
    [Math.min(mx0, mx1), Math.min(my0, my1), Math.max(mx0, mx1), Math.max(my0, my1)]);
  ob.points[2] = [box[0], box[1]];
  ob.points[3] = [box[2], box[3]];
}

$("onboardCanvas").addEventListener("click", (e) => {
  if (ob.points.length >= 4) return;
  const r = e.target.getBoundingClientRect();
  ob.points.push([Math.round((e.clientX - r.left) * 512 / r.width),
                  Math.round((e.clientY - r.top) * 512 / r.height)]);
  if (ob.points.length === 4) {
    expandMouthPoints();
    $("onboardStatus").textContent = "입 영역을 잉크에 맞춰 자동 확장했습니다 — 빨간 사각형 확인 후 [생성]";
  }
  obRedraw();
  if (ob.points.length !== 4) obStatus();
  else $("obGenerate").disabled = !$("charName").value.trim();
});
$("charName").addEventListener("input", obStatus);
$("obReset").onclick = () => { ob.points = []; obRedraw(); obStatus(); };
$("obCancel").onclick = () => $("onboardDlg").close();
$("obGenerate").onclick = () => {
  const name = $("charName").value.trim();
  const [L, R, [mx0, my0], [mx1, my1]] = ob.points;
  const mouth = [Math.min(mx0, mx1), Math.min(my0, my1), Math.max(mx0, mx1), Math.max(my0, my1)];
  try {
    const { manifest, canvases } = buildCharacter(ob.img, name, { L, R },
      Number($("eyeHalf").value) || 16, mouth);
    deriveAll(canvases, manifest);
    saveCharacter(name, manifest, canvases);
    refreshList(name);
    $("onboardDlg").close();
    status(`캐릭터 '${name}' 생성 완료 — 시작을 누르세요`);
  } catch (err) {
    $("onboardStatus").textContent = `생성 실패: ${err.message}`;
  }
};

// ---------- drop zone ----------
const dz = $("dropZone");
dz.onclick = () => $("fileInput").click();
$("fileInput").onchange = (e) => e.target.files[0] && openOnboarding(e.target.files[0]);
dz.ondragover = (e) => { e.preventDefault(); dz.classList.add("drag"); };
dz.ondragleave = () => dz.classList.remove("drag");
dz.ondrop = (e) => {
  e.preventDefault();
  dz.classList.remove("drag");
  const f = [...e.dataTransfer.files].find((f) => f.type.startsWith("image/"));
  if (f) openOnboarding(f);
};

$("deleteBtn").onclick = () => {
  const name = $("charSelect").value;
  if (name && confirm(`'${name}' 캐릭터를 삭제할까요?`)) { deleteCharacter(name); refreshList(); }
};

// ---------- live loop ----------
const run = { on: false, stream: null, tracker: null, raf: 0 };

async function start() {
  const name = $("charSelect").value;
  if (!name) return;
  $("startBtn").disabled = true;
  try {
    status("추적 모델 로딩 중…");
    run.tracker ??= await createTracker();
    status("웹캠 여는 중…");
    const video_c = { width: CONFIG.camera.width, height: CONFIG.camera.height };
    if ($("camSelect").value) video_c.deviceId = { exact: $("camSelect").value };
    try {
      run.stream = await navigator.mediaDevices.getUserMedia({ video: video_c });
    } catch (err) {
      throw new Error(CAM_ERRORS[err.name] ?? `${err.name}: ${err.message}`);
    }
    refreshCameras(); // labels become visible after the first grant
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.srcObject = run.stream;
    await video.play();

    const char = prepareCharacter(await loadCharacter(name));
    const st = {
      mirror: $("mirrorChk").checked,
      calib: new Calibration(CONFIG.calibration.frames),
      emas: Object.fromEntries(SMOOTH_KEYS.map((k) => [k,
        new Ema(k.startsWith("eyeBlink") ? CONFIG.smoothing.blinkAlpha : CONFIG.smoothing.blendAlpha)])),
      headEmas: { yaw: new Ema(CONFIG.smoothing.headAlpha), pitch: new Ema(CONFIG.smoothing.headAlpha), roll: new Ema(CONFIG.smoothing.headAlpha) },
      eyes: { left: new TriStateEye(CONFIG.eyes), right: new TriStateEye(CONFIG.eyes) },
      smoothed: Object.fromEntries(SMOOTH_KEYS.map((k) => [k, 0])),
      head: { yaw: 0, pitch: 0, roll: 0 },
      lastSeen: performance.now(), fps: 0, tPrev: performance.now(),
    };
    run.on = true;
    $("startBtn").textContent = "정지";
    $("startBtn").disabled = false;
    $("calibBtn").disabled = false;
    $("calibBtn").onclick = () => st.calib.restart();
    $("mirrorChk").onchange = () => { st.mirror = $("mirrorChk").checked; };
    window.onkeydown = (e) => {
      if (e.key === "c") st.calib.restart();
      if (e.key === "m") { $("mirrorChk").checked = !$("mirrorChk").checked; st.mirror = $("mirrorChk").checked; }
    };
    loop(video, char, st);
  } catch (err) {
    status(`시작 실패: ${err.message}`);
    stop();
  }
}

function loop(video, char, st) {
  if (!run.on) return;
  try {
    loopBody(video, char, st);
  } catch (err) {
    status(`루프 오류: ${err.message}`);
    console.error(err);
    stop();
    return;
  }
  run.raf = requestAnimationFrame(() => loop(video, char, st));
}

function loopBody(video, char, st) {
  const now = performance.now();
  const obs = run.tracker.detect(video, now);

  if (obs) {
    st.lastSeen = now;
    if (st.calib.active) {
      st.calib.feed(obs.blend);
    } else {
      const values = st.calib.apply(obs.blend);
      for (const k of SMOOTH_KEYS) st.smoothed[k] = st.emas[k].update(values[k]);
      for (const k of ["yaw", "pitch", "roll"]) st.head[k] = st.headEmas[k].update(obs[k]);
    }
  } else {
    const lost = now - st.lastSeen;
    if (lost > CONFIG.lostFace.holdMs) {
      const decay = Math.min(1, (lost - CONFIG.lostFace.holdMs) / CONFIG.lostFace.decayMs);
      for (const k of SMOOTH_KEYS) st.smoothed[k] *= (1 - decay);
      for (const k of ["yaw", "pitch", "roll"]) st.head[k] *= (1 - decay);
    }
  }

  const eyeStates = {};
  for (const side of ["left", "right"]) {
    const key = side === "left" ? "eyeBlinkLeft" : "eyeBlinkRight";
    eyeStates[eyeKeyForUserSide(side, st.mirror)] = st.eyes[side].update(st.smoothed[key]);
  }
  const mouth = pickMouth(st.smoothed, CONFIG.mouth);

  const composed = composeCharacter(char, eyeStates.L, eyeStates.R, mouth);
  drawScene($("output").getContext("2d"), composed, st.head, CONFIG.head);

  drawPreview(video, obs, st);

  st.fps = 0.9 * st.fps + 0.1 * (1000 / Math.max(1, now - st.tPrev));
  st.tPrev = now;
  status(st.calib.active
    ? "캘리브레이션 중 — 정면을 보고 무표정을 유지하세요"
    : `${st.fps.toFixed(0)} FPS · ${obs ? "face:OK" : "face:LOST"} · L:${eyeStates.L} R:${eyeStates.R} mouth:${mouth}`);
}

function drawPreview(video, obs, st) {
  const ctx = $("preview").getContext("2d");
  const { width: w, height: h } = ctx.canvas;
  ctx.save();
  ctx.scale(-1, 1);                       // mirror ONLY the user-facing preview
  ctx.drawImage(video, -w, 0, w, h);
  ctx.restore();
  if (!$("vizChk").checked) return;
  if (obs?.landmarks) {
    ctx.fillStyle = "#50ff78";
    for (const [x, y] of obs.landmarks) ctx.fillRect((1 - x) * w, y * h, 2, 2);
  }
  ctx.font = "11px monospace";
  VIZ_BARS.forEach(([label, key], i) => {
    const y = h - 14 * VIZ_BARS.length - 8 + 14 * i;
    ctx.fillStyle = "#fff";
    ctx.fillText(label, 6, y + 9);
    ctx.strokeStyle = "#666";
    ctx.strokeRect(58, y, 80, 10);
    ctx.fillStyle = "#50ff78";
    ctx.fillRect(58, y, 80 * Math.min(1, st.smoothed[key] ?? 0), 10);
  });
}

function stop() {
  run.on = false;
  cancelAnimationFrame(run.raf);
  run.stream?.getTracks().forEach((t) => t.stop());
  run.stream = null;
  window.onkeydown = null;
  $("startBtn").textContent = "시작";
  $("startBtn").disabled = $("charSelect").options.length === 0;
  $("calibBtn").disabled = true;
  status("정지됨");
}

$("startBtn").onclick = () => (run.on ? stop() : start());

refreshList();
refreshCameras();
