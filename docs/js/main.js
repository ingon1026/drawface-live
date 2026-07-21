// DrawFace Live web — UI wiring and the render loop (browser twin of app/main.py).
import { CANVAS, CONFIG } from "./config.js";
import { fit512, expandBoxToInk, newCanvas } from "./imageops.js";
import { buildCharacter } from "./onboard.js";
import { deriveAll } from "./derive.js";
import { listCharacters, saveCharacter, deleteCharacter, loadCharacter } from "./store.js";
import {
  SMOOTH_KEYS, OneEuro, IdleMotion, TriStateEye, Calibration,
  pickMouth, eyeKeyForUserSide,
} from "./pipeline.js";
import { createTracker, detectOnImage } from "./tracker.js";
import { prepareCharacter, composeCharacter, drawScene } from "./compositor.js";
import { buildWarpRig, renderWarp } from "./warp.js";
import { StickerFx } from "./effects.js";

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
const BOX_HANDLE_RADIUS = 12;
const BOX_MIN_SIZE = 12;
const ob = { img: null, points: [], draft: null, previewChar: null, drag: null, landmarks: null };

function obStatus() {
  const n = ob.points.length;
  $("onboardStatus").textContent = n < 4
    ? `클릭 ${n + 1}/4: ${CLICK_STEPS[n]}`
    : "좌표 완료 — 이름을 확인하고 [미리보기]";
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
    const left = Math.min(x0, x1), top = Math.min(y0, y1);
    const right = Math.max(x0, x1), bottom = Math.max(y0, y1);
    ctx.strokeRect(left, top, right - left, bottom - top);
    ctx.fillStyle = "#fff";
    for (const [x, y] of [[left, top], [right, top], [right, bottom], [left, bottom]]) {
      ctx.fillRect(x - 4, y - 4, 8, 8);
      ctx.strokeRect(x - 4, y - 4, 8, 8);
    }
  }
}

function onboardPoint(e) {
  const r = e.currentTarget.getBoundingClientRect();
  return {
    x: Math.max(0, Math.min(CANVAS, Math.round((e.clientX - r.left) * CANVAS / r.width))),
    y: Math.max(0, Math.min(CANVAS, Math.round((e.clientY - r.top) * CANVAS / r.height))),
  };
}

function mouthBox() {
  const [, , [ax, ay], [bx, by]] = ob.points;
  return { left: Math.min(ax, bx), top: Math.min(ay, by), right: Math.max(ax, bx), bottom: Math.max(ay, by) };
}

function setMouthBox({ left, top, right, bottom }) {
  ob.points[2] = [Math.round(left), Math.round(top)];
  ob.points[3] = [Math.round(right), Math.round(bottom)];
}

function boxHit(x, y) {
  if (ob.points.length !== 4) return null;
  const box = mouthBox();
  const corners = [
    ["nw", box.left, box.top], ["ne", box.right, box.top],
    ["se", box.right, box.bottom], ["sw", box.left, box.bottom],
  ];
  for (const [handle, cx, cy] of corners) {
    if (Math.abs(x - cx) <= BOX_HANDLE_RADIUS && Math.abs(y - cy) <= BOX_HANDLE_RADIUS) return handle;
  }
  return x >= box.left && x <= box.right && y >= box.top && y <= box.bottom ? "move" : null;
}

function cursorForBoxHit(hit) {
  if (hit === "move") return "move";
  if (hit === "nw" || hit === "se") return "nwse-resize";
  if (hit === "ne" || hit === "sw") return "nesw-resize";
  return "crosshair";
}

function invalidateOnboardingPreview() {
  ob.draft = null;
  ob.previewChar = null;
  $("onboardReview").hidden = true;
}

async function openOnboarding(file) {
  const bmp = await createImageBitmap(file);
  ob.img = fit512(bmp);
  ob.points = [];
  ob.drag = null;
  ob.draft = null;
  ob.previewChar = null;
  $("onboardReview").hidden = true;
  $("charName").value = file.name.replace(/\.[^.]+$/, "").replace(/[^\w-]+/g, "-").toLowerCase();
  $("onboardDlg").showModal();
  obRedraw();
  $("onboardStatus").textContent = "얼굴 자동 인식 시도 중…";
  // Photo-trained models often miss hand drawings — prefill when it works,
  // fall back to manual clicks when it doesn't (see outputs/benchmark.md).
  const auto = await detectOnImage(ob.img);
  ob.landmarks = auto?.landmarks ?? null; // real geometry -> finer warp rig
  if (auto && ob.points.length === 0) {
    ob.points = [auto.eyes.L, auto.eyes.R,
                 [auto.mouthBox[0], auto.mouthBox[1]], [auto.mouthBox[2], auto.mouthBox[3]]];
    expandMouthPoints(); // landmark lip box misses deep open-mouth interiors
    $("eyeHalf").value = auto.eyeHalf;
    obRedraw();
    obStatus();
    $("onboardStatus").textContent = "얼굴 자동 인식됨 — 박스 모서리로 크기 조절, 내부 드래그로 이동 후 [미리보기]";
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
  const { x, y } = onboardPoint(e);
  ob.points.push([x, y]);
  if (ob.points.length === 4) {
    expandMouthPoints();
    $("onboardStatus").textContent = "입 영역을 잉크에 맞춰 자동 확장했습니다 — 모서리로 크기 조절, 내부 드래그로 이동할 수 있습니다";
  }
  obRedraw();
  if (ob.points.length !== 4) obStatus();
  else $("obGenerate").disabled = !$("charName").value.trim();
});

$("onboardCanvas").addEventListener("pointerdown", (e) => {
  const { x, y } = onboardPoint(e);
  const handle = boxHit(x, y);
  if (!handle) return;
  invalidateOnboardingPreview();
  ob.drag = { handle, startX: x, startY: y, box: mouthBox() };
  e.currentTarget.setPointerCapture(e.pointerId);
  e.preventDefault();
});

$("onboardCanvas").addEventListener("pointermove", (e) => {
  const { x, y } = onboardPoint(e);
  const canvas = e.currentTarget;
  if (!ob.drag) {
    canvas.style.cursor = cursorForBoxHit(boxHit(x, y));
    return;
  }

  const { handle, startX, startY, box } = ob.drag;
  let { left, top, right, bottom } = box;
  if (handle === "move") {
    const width = right - left, height = bottom - top;
    left = Math.max(0, Math.min(CANVAS - width, left + x - startX));
    top = Math.max(0, Math.min(CANVAS - height, top + y - startY));
    right = left + width;
    bottom = top + height;
  } else if (handle === "nw") {
    left = Math.max(0, Math.min(right - BOX_MIN_SIZE, x));
    top = Math.max(0, Math.min(bottom - BOX_MIN_SIZE, y));
  } else if (handle === "ne") {
    right = Math.min(CANVAS, Math.max(left + BOX_MIN_SIZE, x));
    top = Math.max(0, Math.min(bottom - BOX_MIN_SIZE, y));
  } else if (handle === "se") {
    right = Math.min(CANVAS, Math.max(left + BOX_MIN_SIZE, x));
    bottom = Math.min(CANVAS, Math.max(top + BOX_MIN_SIZE, y));
  } else if (handle === "sw") {
    left = Math.max(0, Math.min(right - BOX_MIN_SIZE, x));
    bottom = Math.min(CANVAS, Math.max(top + BOX_MIN_SIZE, y));
  }
  setMouthBox({ left, top, right, bottom });
  obRedraw();
  canvas.style.cursor = cursorForBoxHit(handle);
  e.preventDefault();
});

function endBoxDrag(e) {
  if (!ob.drag) return;
  ob.drag = null;
  e.currentTarget.style.cursor = "crosshair";
  $("onboardStatus").textContent = "입 영역을 조정했습니다 — [미리보기]로 결과를 확인하세요";
}

$("onboardCanvas").addEventListener("pointerup", endBoxDrag);
$("onboardCanvas").addEventListener("pointercancel", endBoxDrag);
$("charName").addEventListener("input", obStatus);
$("obReset").onclick = () => {
  ob.points = [];
  ob.drag = null;
  invalidateOnboardingPreview();
  obRedraw();
  obStatus();
};
$("obCancel").onclick = () => $("onboardDlg").close();
$("obGenerate").onclick = () => {
  const name = $("charName").value.trim();
  const [L, R, [mx0, my0], [mx1, my1]] = ob.points;
  const mouth = [Math.min(mx0, mx1), Math.min(my0, my1), Math.max(mx0, mx1), Math.max(my0, my1)];
  try {
    const { manifest, canvases } = buildCharacter(ob.img, name, { L, R },
      Number($("eyeHalf").value) || 16, mouth);
    if (ob.landmarks) manifest.landmarks = ob.landmarks; // warp rig prefers real geometry
    deriveAll(canvases, manifest);
    ob.draft = { name, manifest, canvases };
    ob.previewChar = prepareCharacter(ob.draft);
    $("onboardReview").hidden = false;
    renderOnboardingPreview();
    $("onboardStatus").textContent = "표정별 결과를 확인한 뒤 저장하거나 위치를 수정하세요";
  } catch (err) {
    $("onboardStatus").textContent = `미리보기 생성 실패: ${err.message}`;
  }
};

function renderOnboardingPreview() {
  if (!ob.previewChar) return;
  const state = $("reviewState").value;
  const expressions = {
    neutral: ["open", "open", "closed"],
    blink: ["closed", "closed", "closed"],
    smile: ["open", "open", "smile"],
    A: ["open", "open", "A"],
  };
  const [eyeL, eyeR, mouth] = expressions[state] ?? expressions.neutral;
  const ctx = $("reviewCanvas").getContext("2d");
  ctx.clearRect(0, 0, CANVAS, CANVAS);
  ctx.drawImage(composeCharacter(ob.previewChar, eyeL, eyeR, mouth), 0, 0);
}

$("reviewState").onchange = renderOnboardingPreview;
$("obEdit").onclick = () => {
  invalidateOnboardingPreview();
  $("onboardStatus").textContent = "빨간 박스 모서리를 드래그해 크기를 조절하거나, 내부를 드래그해 이동하세요";
};
$("obSave").onclick = () => {
  if (!ob.draft) return;
  try {
    saveCharacter(ob.draft.name, ob.draft.manifest, ob.draft.canvases);
    refreshList(ob.draft.name);
    $("onboardDlg").close();
    status(`캐릭터 '${ob.draft.name}' 저장 완료 — 시작을 누르세요`);
  } catch (err) {
    $("onboardStatus").textContent = `저장 실패: ${err.message}`;
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

// Clean flat avatar — solid colours, eyes/mouth on a solid skin field so the
// erased regions vanish. This is the ideal input shape for the sprite pipeline
// (unlike a textured hand drawing, where the erased patch is hard to hide).
function exampleDrawing() {
  const c = newCanvas(CANVAS, CANVAS);
  const ctx = c.getContext("2d");
  const SKIN = "#f6c9a0", SKIN_SH = "#e8b488", HAIR = "#4a3328", SHIRT = "#4c8bc4", SHIRT_D = "#3b71a3";
  const ell = (x0, y0, x1, y1, a0 = 0, a1 = Math.PI * 2) => {
    ctx.beginPath();
    ctx.ellipse((x0 + x1) / 2, (y0 + y1) / 2, (x1 - x0) / 2, (y1 - y0) / 2, 0, a0, a1);
    ctx.fill();
  };
  const rad = (deg) => (deg * Math.PI) / 180;

  ctx.fillStyle = "#f2e9de"; ctx.fillRect(0, 0, CANVAS, CANVAS);           // background
  ctx.fillStyle = SHIRT; ctx.beginPath(); ctx.roundRect(150, 360, 212, 152, 40); ctx.fill();
  ctx.fillStyle = SHIRT_D;
  ctx.beginPath(); ctx.moveTo(180, 360); ctx.lineTo(256, 430); ctx.lineTo(332, 360); ctx.closePath(); ctx.fill();
  ctx.fillStyle = SKIN_SH; ctx.fillRect(228, 320, 56, 52);                 // neck
  ctx.fillStyle = SKIN; ell(150, 96, 362, 350);                           // head
  ell(140, 200, 172, 250); ell(340, 200, 372, 250);                       // ears
  ctx.fillStyle = HAIR;
  ell(150, 70, 362, 300, rad(180), rad(360));                             // hair top
  ctx.fillRect(150, 150, 212, 22);
  ell(150, 96, 200, 210); ell(312, 96, 362, 210);                         // side hair
  ctx.beginPath(); ctx.roundRect(196, 205, 48, 9, 4); ctx.fill();         // brows
  ctx.beginPath(); ctx.roundRect(268, 205, 48, 9, 4); ctx.fill();
  for (const ex of [220, 292]) {                                          // eyes
    ctx.fillStyle = "#2b2420"; ell(ex - 16, 232, ex + 16, 272);
    ctx.fillStyle = "#ffffff"; ell(ex - 6, 240, ex + 6, 256);
  }
  ctx.strokeStyle = SKIN_SH; ctx.lineWidth = 4;                           // nose
  ctx.beginPath(); ctx.moveTo(256, 272); ctx.lineTo(250, 292); ctx.stroke();
  ctx.strokeStyle = "#b04a54"; ctx.lineWidth = 7;                         // mouth
  ctx.beginPath(); ctx.ellipse(256, 311, 32, 19, 0, rad(15), rad(165)); ctx.stroke();
  return c;
}

$("exampleBtn").onclick = () => {
  try {
    const name = "예시 캐릭터";
    const { manifest, canvases } = buildCharacter(exampleDrawing(), name,
      { L: [220, 252], R: [292, 252] }, 20, [222, 290, 290, 332]);
    deriveAll(canvases, manifest);
    saveCharacter(name, manifest, canvases);
    refreshList(name);
    status("예시 캐릭터를 불러왔습니다 — 시작을 눌러 웹캠 표정을 따라 해보세요");
  } catch (err) {
    status(`예시 캐릭터 생성 실패: ${err.message}`);
  }
};

$("deleteBtn").onclick = () => {
  const name = $("charSelect").value;
  if (name && confirm(`'${name}' 캐릭터를 삭제할까요?`)) { deleteCharacter(name); refreshList(); }
};

// ---------- live loop ----------
const run = { on: false, stream: null, tracker: null, video: null, raf: 0, videoFrame: 0, recording: null };

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
    run.video = video;

    const char = prepareCharacter(await loadCharacter(name));
    try {
      char.warp = buildWarpRig(char);
    } catch (err) {
      char.warp = null; // sprite path still works — warp is an upgrade, not a gate
      console.warn("warp rig unavailable:", err);
    }
    $("warpChk").disabled = !char.warp;
    const st = {
      mirror: $("mirrorChk").checked,
      calib: new Calibration(CONFIG.calibration.frames),
      emas: Object.fromEntries(SMOOTH_KEYS.map((k) => [k,
        new OneEuro(CONFIG.smoothing.minCutoff, CONFIG.smoothing.beta)])),
      headEmas: Object.fromEntries(["yaw", "pitch", "roll"].map((k) => [k,
        new OneEuro(CONFIG.smoothing.headMinCutoff, CONFIG.smoothing.headBeta)])),
      eyes: { left: new TriStateEye(CONFIG.eyes), right: new TriStateEye(CONFIG.eyes) },
      smoothed: Object.fromEntries(SMOOTH_KEYS.map((k) => [k, 0])),
      head: { yaw: 0, pitch: 0, roll: 0 },
      lastSeen: performance.now(), fps: 0, tPrev: performance.now(),
      outCtx: $("output").getContext("2d"),      // hoisted out of the frame loop
      prevCtx: $("preview").getContext("2d"),
      fx: new StickerFx(CANVAS),
      idle: new IdleMotion(CONFIG.idle),
    };
    run.on = true;
    $("startBtn").textContent = "정지";
    $("startBtn").disabled = false;
    $("calibBtn").disabled = false;
    $("recordBtn").disabled = !("MediaRecorder" in window && "captureStream" in $("output"));
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
  const render = (now) => {
    if (!run.on) return;
    try {
      loopBody(video, char, st, now);
    } catch (err) {
      status(`루프 오류: ${err.message}`);
      console.error(err);
      stop();
      return;
    }
    schedule();
  };
  const schedule = () => {
    if (!run.on) return;
    if (typeof video.requestVideoFrameCallback === "function") {
      run.videoFrame = video.requestVideoFrameCallback((now) => render(now));
    } else {
      const tick = (now) => {
        if (!run.on) return;
        if (video.currentTime !== st.lastVideoTime) {
          st.lastVideoTime = video.currentTime;
          render(now);
        } else {
          run.raf = requestAnimationFrame(tick);
        }
      };
      run.raf = requestAnimationFrame(tick);
    }
  };
  schedule();
}

function loopBody(video, char, st, now) {
  const obs = run.tracker.detect(video, now);

  if (obs) {
    st.lastSeen = now;
    if (st.calib.active) {
      st.calib.feed(obs.blend);
    } else {
      const values = st.calib.apply(obs.blend);
      const tSec = now / 1000;
      for (const k of SMOOTH_KEYS) st.smoothed[k] = st.emas[k].update(values[k], tSec);
      for (const k of ["yaw", "pitch", "roll"]) st.head[k] = st.headEmas[k].update(obs[k], tSec);
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

  const useWarp = char.warp && $("warpChk").checked;
  let frame;
  if (useWarp) {
    const g = CONFIG.warp;
    const blink = {};
    for (const side of ["left", "right"]) {
      const key = side === "left" ? "eyeBlinkLeft" : "eyeBlinkRight";
      blink[eyeKeyForUserSide(side, st.mirror)] = st.smoothed[key] * g.blinkGain;
    }
    const ch = {
      blinkL: blink.L, blinkR: blink.R,
      smile: ((st.smoothed.mouthSmileLeft + st.smoothed.mouthSmileRight) / 2) * g.smileGain,
      jaw: st.smoothed.jawOpen * g.jawGain,
      // Mesh parallax reuses the canvas-shift gains for direction/normalization.
      yaw: (st.head.yaw * CONFIG.head.yawGainPx / CONFIG.head.maxShiftPx) * g.headParallax,
      pitch: (st.head.pitch * CONFIG.head.pitchGainPx / CONFIG.head.maxShiftPx) * g.headParallax,
    };
    if (!st.calib.active) {
      st.idle.apply(ch, now, Math.max(st.smoothed.eyeBlinkLeft, st.smoothed.eyeBlinkRight));
    }
    frame = renderWarp(char.warp, ch);
  } else {
    frame = composeCharacter(char, eyeStates.L, eyeStates.R, mouth);
  }
  drawScene(st.outCtx, frame, st.head, CONFIG.head);
  if ($("fxChk").checked) {
    if (!st.calib.active) st.fx.update(st.smoothed, now);
    st.fx.draw(st.outCtx, now);
  }

  drawPreview(video, obs, st);

  st.fps = 0.9 * st.fps + 0.1 * (1000 / Math.max(1, now - st.tPrev));
  st.tPrev = now;
  // The recording cue must survive this per-frame status overwrite (spec §9).
  const rec = run.recording ? "  ● REC" : "";
  status((st.calib.active
    ? "캘리브레이션 중 — 정면을 보고 무표정을 유지하세요"
    : `${st.fps.toFixed(0)} FPS · ${useWarp ? "warp" : "sprite"} · ${obs ? "face:OK" : "face:LOST"}`
      + (useWarp ? "" : ` · L:${eyeStates.L} R:${eyeStates.R} mouth:${mouth}`)) + rec);
}

function drawPreview(video, obs, st) {
  const ctx = st.prevCtx;
  const { width: w, height: h } = ctx.canvas;
  ctx.save();
  ctx.scale(-1, 1);                       // mirror ONLY the user-facing preview
  ctx.drawImage(video, -w, 0, w, h);
  ctx.restore();
  if (!$("vizChk").checked) return;
  if (obs?.landmarks) {
    ctx.fillStyle = "#50ff78";
    for (const lm of obs.landmarks) ctx.fillRect((1 - lm.x) * w, lm.y * h, 2, 2);
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
  if (run.videoFrame && run.video?.cancelVideoFrameCallback) run.video.cancelVideoFrameCallback(run.videoFrame);
  run.videoFrame = 0;
  stopRecording();
  run.stream?.getTracks().forEach((t) => t.stop());
  run.stream = null;
  run.video = null;
  window.onkeydown = null;
  $("startBtn").textContent = "시작";
  $("startBtn").disabled = $("charSelect").options.length === 0;
  $("calibBtn").disabled = true;
  $("recordBtn").disabled = true;
  $("recordBtn").textContent = "녹화 시작";
  status("정지됨");
}

function recordMimeType() {
  return ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"]
    .find((type) => MediaRecorder.isTypeSupported(type));
}

function startRecording() {
  if (!run.on || run.recording || !("MediaRecorder" in window) || !("captureStream" in $("output"))) return;
  const mimeType = recordMimeType();
  if (!mimeType) { status("이 브라우저는 WebM 녹화를 지원하지 않습니다"); return; }
  const stream = $("output").captureStream(30);
  const recording = { stream, chunks: [], recorder: null };
  const recorder = recording.recorder = new MediaRecorder(stream, { mimeType });
  recorder.ondataavailable = (e) => { if (e.data.size) recording.chunks.push(e.data); };
  recorder.onerror = () => status("녹화 중 오류가 발생했습니다");
  recorder.onstop = () => {
    stream.getTracks().forEach((track) => track.stop());
    if (recording.chunks.length) {
      const blob = new Blob(recording.chunks, { type: mimeType });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `drawface-live-${new Date().toISOString().replace(/[:.]/g, "-")}.webm`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      status("녹화 완료 — WebM 다운로드를 시작했습니다");
    }
    if (run.recording === recording) run.recording = null;
    $("recordBtn").textContent = "녹화 시작";
  };
  run.recording = recording;
  recorder.start(1000);
  $("recordBtn").textContent = "녹화 종료";
  status("녹화 중 — 결과 캔버스만 WebM으로 저장합니다");
}

function stopRecording() {
  const recording = run.recording;
  if (!recording) return;
  if (recording.recorder.state !== "inactive") recording.recorder.stop();
}

$("recordBtn").onclick = () => (run.recording ? stopRecording() : startRecording());

$("startBtn").onclick = () => (run.on ? stop() : start());

refreshList();
refreshCameras();
