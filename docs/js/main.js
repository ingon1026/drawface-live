// DrawFace Live web — UI wiring and the render loop (browser twin of app/main.py).
import { CANVAS, CONFIG, SOURCE_MAX } from "./config.js?v=20260729.6";
import { fit512, fitTo, expandBoxToInk, newCanvas } from "./imageops.js?v=20260729.6";
import { buildCharacter } from "./onboard.js?v=20260729.6";
import { deriveAll } from "./derive.js?v=20260729.6";
import { listCharacters, saveCharacter, deleteCharacter, loadCharacter } from "./store.js?v=20260729.6";
import {
  SMOOTH_KEYS, OneEuro, IdleMotion, TriStateEye, Calibration,
  pickMouth, eyeKeyForUserSide,
} from "./pipeline.js?v=20260729.6";
import { createTracker, createWorkerTracker, detectOnImage } from "./tracker.js?v=20260729.6";
import { prepareCharacter, composeCharacter, drawScene } from "./compositor.js?v=20260729.6";
import { buildWarpRig, renderWarp } from "./warp.js?v=20260729.6";
import { StickerFx } from "./effects.js?v=20260729.6";
import { RenderPerformance } from "./performance.js?v=20260729.6";

const $ = (id) => document.getElementById(id);
const status = (msg) => { $("status").textContent = msg; };

// Surface every failure in the status line — the user has no console open.
window.addEventListener("error", (e) => status(`Error: ${e.message}`));
window.addEventListener("unhandledrejection", (e) => status(`Error: ${e.reason?.message ?? e.reason}`));

const VIZ_BARS = [
  ["eyeL", "eyeBlinkLeft"], ["eyeR", "eyeBlinkRight"], ["jaw", "jawOpen"],
  ["smile", "mouthSmileLeft"], ["pucker", "mouthPucker"],
];
const CLICK_STEPS = [
  "centre of the eye on the screen's left",
  "centre of the eye on the screen's right",
  "mouth box: top-left corner",
  "mouth box: bottom-right corner",
];
const PERF_MODE_KEY = "drawface-live:performance-mode";
const PERF_MODES = new Set(["auto", "full", "economy"]);

// In warp mode the mesh rolls the face itself, so the canvas keeps only this
// share of the roll (body sways a little, face leads) — full canvas roll on top
// of the mesh roll would rotate the face twice.
const CANVAS_ROLL_SHARE = 0.35;

// ---------- camera list ----------
// RealSense-class devices expose several video inputs (RGB/depth/IR) — the
// browser's default pick can be the wrong one, so let the user choose.
async function refreshCameras() {
  const sel = $("camSelect");
  const cur = sel.value;
  sel.innerHTML = "";
  try {
    const devs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "videoinput");
    devs.forEach((d, i) => sel.add(new Option(d.label || `Camera ${i + 1}`, d.deviceId)));
    if ([...sel.options].some((o) => o.value === cur)) sel.value = cur;
    const rgb = [...sel.options].find((o) => /rgb|color/i.test(o.text));
    if (rgb && !cur) sel.value = rgb.value;
  } catch { /* enumerate unavailable — default device will be used */ }
}
navigator.mediaDevices?.addEventListener?.("devicechange", refreshCameras);

const CAM_ERRORS = {
  NotAllowedError: "Camera permission is blocked — set it to 'Allow' from the lock/camera icon in the address bar and reload the page",
  NotFoundError: "No camera found — check that it is connected (a camera attached to WSL is not visible to Windows)",
  NotReadableError: "Another program is using the camera — close that app and try again",
  OverconstrainedError: "The selected camera does not support the requested resolution — try a different camera",
};

function showTrackerRetry(message) {
  status(`${message} — check your network connection and try again`);
  $("trackerRetryBtn").hidden = false;
}

function clearTrackerRetry() {
  $("trackerRetryBtn").hidden = true;
}

function restorePerformanceMode() {
  try {
    const saved = localStorage.getItem(PERF_MODE_KEY);
    if (PERF_MODES.has(saved)) $("perfMode").value = saved;
  } catch { /* storage may be disabled in private browsing */ }
}

function savePerformanceMode(mode) {
  try { localStorage.setItem(PERF_MODE_KEY, mode); } catch { /* preference remains session-only */ }
}

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
const ob = { img: null, points: [], draft: null, previewChar: null, drag: null, landmarks: null, src: null };

function obStatus() {
  const n = ob.points.length;
  $("onboardStatus").textContent = n < 4
    ? `Click ${n + 1}/4: ${CLICK_STEPS[n]}`
    : "All 4 points are set — check the name, then press [Preview]";
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
  // Keep a hi-res copy when the original beats 512 — 원본 보존용 메타데이터
  // (r6 부터 warp rig 는 사용 안 함; hi-res 재설계·신경망 트랙 대비 저장만).
  ob.src = (bmp.width > CANVAS || bmp.height > CANVAS) ? fitTo(bmp, SOURCE_MAX) : null;
  ob.points = [];
  ob.drag = null;
  ob.draft = null;
  ob.previewChar = null;
  $("onboardReview").hidden = true;
  $("charName").value = file.name.replace(/\.[^.]+$/, "").replace(/[^\w-]+/g, "-").toLowerCase();
  $("onboardDlg").showModal();
  obRedraw();
  $("onboardStatus").textContent = "Trying to detect the face automatically…";
  // Photo-trained models often miss hand drawings — prefill when it works,
  // fall back to manual clicks when it doesn't (see outputs/benchmark.md).
  const auto = await detectOnImage(ob.img);
  ob.landmarks = auto?.landmarks ?? null; // 메타데이터로 저장만 — rig 는 사용 안 함(r6)
  if (auto && ob.points.length === 0) {
    ob.points = [auto.eyes.L, auto.eyes.R,
                 [auto.mouthBox[0], auto.mouthBox[1]], [auto.mouthBox[2], auto.mouthBox[3]]];
    expandMouthPoints(); // landmark lip box misses deep open-mouth interiors
    $("eyeHalf").value = auto.eyeHalf;
    obRedraw();
    obStatus();
    $("onboardStatus").textContent = "Face detected — drag a corner to resize, inside to move, then [Preview]";
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
    $("onboardStatus").textContent = "Mouth box auto-expanded to the ink — drag a corner to resize, inside to move";
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
  $("onboardStatus").textContent = "Mouth area adjusted — press [Preview] to check the result";
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
    if (ob.landmarks) manifest.landmarks = ob.landmarks; // 저장만 — rig 는 박스 기하 고정(r6)
    if (ob.src) canvases["source.png"] = ob.src;         // 원본 보존용 — rig 는 사용 안 함(r6)
    deriveAll(canvases, manifest);
    ob.draft = { name, manifest, canvases };
    ob.previewChar = prepareCharacter(ob.draft);
    $("onboardReview").hidden = false;
    renderOnboardingPreview();
    $("onboardStatus").textContent = "Check each expression, then save it or adjust the positions";
  } catch (err) {
    $("onboardStatus").textContent = `Failed to generate the preview: ${err.message}`;
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
  $("onboardStatus").textContent = "Drag a corner of the red box to resize, or drag inside it to move";
};
$("obSave").onclick = () => {
  if (!ob.draft) return;
  try {
    saveCharacter(ob.draft.name, ob.draft.manifest, ob.draft.canvases);
    refreshList(ob.draft.name);
    $("onboardDlg").close();
    status(`Character '${ob.draft.name}' saved — press Start`);
  } catch (err) {
    $("onboardStatus").textContent = `Failed to save: ${err.message}`;
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

// 소년 프리셋: talking-drawing-avatar 의 렌더 방법(벡터 입·WebGL 워핑·시선)을 그대로 쓰는
// 전용 페이지로 연결 — drawface 파이프라인에 대입하면 어색해서 원본 방식 그대로 구동한다.
$("boyBtn").onclick = () => { window.location.href = "boy.html"; };

$("exampleBtn").onclick = () => {
  try {
    const name = "example-character";
    const { manifest, canvases } = buildCharacter(exampleDrawing(), name,
      { L: [220, 252], R: [292, 252] }, 20, [222, 290, 290, 332]);
    deriveAll(canvases, manifest);
    saveCharacter(name, manifest, canvases);
    refreshList(name);
    status("Example character loaded — press Start and try mirroring your webcam expressions");
  } catch (err) {
    status(`Failed to create the example character: ${err.message}`);
  }
};

$("deleteBtn").onclick = () => {
  const name = $("charSelect").value;
  if (name && confirm(`Delete the character '${name}'?`)) { deleteCharacter(name); refreshList(); }
};

// ---------- live loop ----------
const run = {
  on: false, stream: null, tracker: null, workerTracker: null, trackerLoading: null,
  video: null, raf: 0, videoFrame: 0, recording: null, perf: null,
};

async function start() {
  const name = $("charSelect").value;
  if (!name) return;
  $("startBtn").disabled = true;
  clearTrackerRetry();
  let loadingTracker = true;
  try {
    status("Loading the tracking model…");
    run.workerTracker = await createWorkerTracker(); // null → silent sync fallback
    if (run.workerTracker) console.log("[tracker] worker mode");
    else run.tracker ??= await createTracker();
    loadingTracker = false;
    status("Opening the webcam…");
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
    // rig 출력 크기에 backing store 를 맞춤 (r6 부터 항상 512 — CSS 가 표시 크기 유지).
    const outSize = char.warp ? char.warp.out.width : CANVAS;
    $("output").width = $("output").height = outSize;
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
      lastSeen: performance.now(), fps: 0, tPrev: performance.now(), workerTs: -1,
      perf: new RenderPerformance(CONFIG.performance, $("perfMode").value),
      outCtx: $("output").getContext("2d"),      // hoisted out of the frame loop
      prevCtx: $("preview").getContext("2d"),
      fx: new StickerFx(outSize),
      idle: new IdleMotion(CONFIG.idle),
    };
    run.perf = st.perf;
    run.on = true;
    $("startBtn").textContent = "Stop";
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
    stop();
    if (loadingTracker) showTrackerRetry(`Failed to load the tracking model: ${err.message}`);
    else status(`Failed to start: ${err.message}`);
  }
}

function loop(video, char, st) {
  const render = (now) => {
    if (!run.on) return;
    try {
      const began = performance.now();
      loopBody(video, char, st, now);
      st.perf.record(now, performance.now() - began);
    } catch (err) {
      status(`Render loop error: ${err.message}`);
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

// Worker-mode observation: send the current frame (dropped if the worker is
// busy) and integrate the newest result. Results repeat across render frames
// until the worker posts a fresher one, so each is integrated exactly once,
// keyed by its capture timestamp; smoothing uses that capture ts while
// lost-face decay is keyed on when the last non-null obs ARRIVED.
function workerObserve(video, st, now) {
  if (run.workerTracker.failed()) {
    // A worker-side MediaPipe fault must not leave the app with a permanently
    // busy frame gate. Load the normal tracker lazily and keep rendering neutral
    // frames while it initializes.
    run.workerTracker.close();
    run.workerTracker = null;
    if (!run.tracker && !run.trackerLoading) {
      status("Recovering the tracking worker…");
      run.trackerLoading = createTracker()
        .then((tracker) => { run.tracker = tracker; })
        .catch((err) => {
          if (run.on) {
            stop();
            showTrackerRetry(`Failed to recover face tracking: ${err.message}`);
          }
        })
        .finally(() => { run.trackerLoading = null; });
    }
    return null;
  }
  run.workerTracker.sendFrame(video, now);
  const res = run.workerTracker.latest();
  const obs = res?.obs ?? null;
  const fresh = !!res && res.ts !== st.workerTs;
  if (fresh) st.workerTs = res.ts;

  if (fresh && obs) {
    st.lastSeen = now;
    if (st.calib.active) {
      st.calib.feed(obs.blend);
    } else {
      const values = st.calib.apply(obs.blend);
      const tSec = (res.ts ?? now) / 1000;
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
  return obs;
}

function loopBody(video, char, st, now) {
  let obs = null;
  if (run.workerTracker) {
    obs = workerObserve(video, st, now);
  } else if (run.tracker) {
    obs = run.tracker.detect(video, now);

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
  }

  const eyeStates = {};
  for (const side of ["left", "right"]) {
    const key = side === "left" ? "eyeBlinkLeft" : "eyeBlinkRight";
    eyeStates[eyeKeyForUserSide(side, st.mirror)] = st.eyes[side].update(st.smoothed[key]);
  }
  const mouth = pickMouth(st.smoothed, CONFIG.mouth);

  const economy = st.perf.useEconomy(now);
  const useWarp = char.warp && $("warpChk").checked && !economy;
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
      roll: (st.head.roll * CONFIG.head.rollGain / CONFIG.head.maxRollDeg) * g.headParallax,
    };
    if (!st.calib.active) {
      st.idle.apply(ch, now, Math.max(st.smoothed.eyeBlinkLeft, st.smoothed.eyeBlinkRight));
    }
    const frame = renderWarp(char.warp, ch);
    // The mesh already rolled the face — the canvas keeps only a share.
    drawScene(st.outCtx, frame, { ...st.head, roll: st.head.roll * CANVAS_ROLL_SHARE }, CONFIG.head);
  } else {
    drawScene(st.outCtx, composeCharacter(char, eyeStates.L, eyeStates.R, mouth), st.head, CONFIG.head);
  }
  if ($("fxChk").checked && !economy) {
    if (!st.calib.active) st.fx.update(st.smoothed, now);
    st.fx.draw(st.outCtx, now);
  }

  drawPreview(video, obs, st);

  st.fps = 0.9 * st.fps + 0.1 * (1000 / Math.max(1, now - st.tPrev));
  st.tPrev = now;
  // The recording cue must survive this per-frame status overwrite (spec §9).
  const rec = run.recording ? "  ● REC" : "";
  status((st.calib.active
    ? "Calibrating — face the camera straight on and keep a neutral expression"
    : `${st.fps.toFixed(0)} FPS · ${st.perf.label()}${run.workerTracker ? " · worker" : ""} · ${useWarp ? "warp" : "sprite"} · ${obs ? "face:OK" : "face:LOST"}`
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
  run.workerTracker?.close();
  run.workerTracker = null;
  run.stream?.getTracks().forEach((t) => t.stop());
  run.stream = null;
  run.video = null;
  run.perf = null;
  window.onkeydown = null;
  $("startBtn").textContent = "Start";
  $("startBtn").disabled = $("charSelect").options.length === 0;
  $("calibBtn").disabled = true;
  $("recordBtn").disabled = true;
  $("recordBtn").textContent = "Start recording";
  status("Stopped");
}

function recordMimeType() {
  return ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"]
    .find((type) => MediaRecorder.isTypeSupported(type));
}

function startRecording() {
  if (!run.on || run.recording || !("MediaRecorder" in window) || !("captureStream" in $("output"))) return;
  const mimeType = recordMimeType();
  if (!mimeType) { status("This browser does not support WebM recording"); return; }
  const stream = $("output").captureStream(30);
  const recording = { stream, chunks: [], recorder: null };
  const recorder = recording.recorder = new MediaRecorder(stream, { mimeType });
  recorder.ondataavailable = (e) => { if (e.data.size) recording.chunks.push(e.data); };
  recorder.onerror = () => status("An error occurred while recording");
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
      status("Recording finished — the WebM download has started");
    }
    if (run.recording === recording) run.recording = null;
    $("recordBtn").textContent = "Start recording";
  };
  run.recording = recording;
  recorder.start(1000);
  $("recordBtn").textContent = "Stop recording";
  status("Recording — only the output canvas is saved as WebM");
}

function stopRecording() {
  const recording = run.recording;
  if (!recording) return;
  if (recording.recorder.state !== "inactive") recording.recorder.stop();
}

$("recordBtn").onclick = () => (run.recording ? stopRecording() : startRecording());

$("startBtn").onclick = () => (run.on ? stop() : start());
$("trackerRetryBtn").onclick = () => start();
$("perfMode").onchange = () => {
  const mode = $("perfMode").value;
  savePerformanceMode(mode);
  run.perf?.setPreference(mode);
};

restorePerformanceMode();
refreshList();
refreshCameras();
