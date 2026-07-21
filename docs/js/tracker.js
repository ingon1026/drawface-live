// MediaPipe Face Landmarker wrapper (browser only) — the web counterpart of
// app/face_tracker.py. Loads @mediapipe/tasks-vision from CDN; detect() returns
// blendshapes + head euler angles + normalized landmarks, or null when no face.
import { WASM_BASE, MODEL_URL, eulerFromMatrix } from "./trackconfig.js";

// STATIC import (URL must match trackconfig.CDN_URL — workers can't share a
// static specifier): the page's load event then waits for the module graph, so
// UI listeners are wired the moment the page looks ready. A top-level dynamic
// import left every button dead while the CDN resolved.
import { FaceLandmarker, FilesetResolver } from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.17";

export async function createTracker() {
  let vision;
  try {
    vision = await FilesetResolver.forVisionTasks(WASM_BASE);
  } catch (e) {
    throw new Error(`could not load MediaPipe tasks-vision wasm from CDN (offline?): ${e.message}`);
  }

  const options = {
    baseOptions: { modelAssetPath: MODEL_URL, delegate: "GPU" },
    runningMode: "VIDEO",
    numFaces: 1,
    outputFaceBlendshapes: true,
    outputFacialTransformationMatrixes: true,
  };

  let landmarker;
  try {
    landmarker = await FaceLandmarker.createFromOptions(vision, options);
  } catch (gpuErr) {
    try {
      options.baseOptions.delegate = "CPU"; // GPU delegate unavailable — retry on CPU
      landmarker = await FaceLandmarker.createFromOptions(vision, options);
    } catch (cpuErr) {
      throw new Error(`could not create FaceLandmarker (model download failed?): ${cpuErr.message}`);
    }
  }

  return {
    /** Detect one face in a <video>; return an observation or null when none. */
    detect(videoEl, tsMs) {
      if (!videoEl.videoWidth) return null; // not decoding yet
      const result = landmarker.detectForVideo(videoEl, tsMs);
      if (!result.faceBlendshapes || result.faceBlendshapes.length === 0) return null;

      const blend = {};
      for (const c of result.faceBlendshapes[0].categories) blend[c.categoryName] = c.score;

      // Raw landmark objects ({x, y, z}) — no per-frame array rebuild; consumers
      // read .x/.y directly (only the debug overlay uses these).
      const landmarks = result.faceLandmarks?.[0] ?? null;

      let yaw = 0, pitch = 0, roll = 0;
      if (result.facialTransformationMatrixes && result.facialTransformationMatrixes.length) {
        ({ yaw, pitch, roll } = eulerFromMatrix(result.facialTransformationMatrixes[0].data));
      }
      return { blend, yaw, pitch, roll, landmarks };
    },
    close() {
      landmarker.close();
    },
  };
}

// Worker init that neither succeeds nor fails (rare CDN stall) must not wedge
// start() forever; past this we fall back to the sync tracker.
const WORKER_INIT_TIMEOUT_MS = 15000;

/** Off-main-thread tracker: {sendFrame(video, tsMs), latest() → {obs, ts}|null, close()}.
 *  Latest-wins — sendFrame drops the frame while the worker is busy, so there is
 *  no queue growth. Resolves null when workers/bitmaps are unsupported or the
 *  worker fails to initialize (CDN imports can fail inside workers on some
 *  setups); callers then fall back to the sync createTracker() path. */
export function createWorkerTracker() {
  if (typeof Worker === "undefined" || typeof createImageBitmap === "undefined"
      || typeof OffscreenCanvas === "undefined") {
    return Promise.resolve(null);
  }
  let worker;
  try {
    worker = new Worker(new URL("./trackworker.js", import.meta.url), { type: "module" });
  } catch {
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    let last = null;
    let busy = false;
    const api = {
      sendFrame(videoEl, tsMs) {
        if (busy || !videoEl.videoWidth) return; // latest-wins: drop while busy
        busy = true;
        createImageBitmap(videoEl).then(
          (bitmap) => worker.postMessage({ type: "frame", bitmap, ts: tsMs }, [bitmap]),
          () => { busy = false; },
        );
      },
      latest() {
        return last;
      },
      close() {
        worker.terminate();
      },
    };
    const fail = () => {
      worker.terminate();
      resolve(null);
    };
    const timer = setTimeout(fail, WORKER_INIT_TIMEOUT_MS);
    worker.onerror = fail; // module-load failure never posts "fail" — only onerror fires
    worker.onmessage = (ev) => {
      const msg = ev.data;
      if (msg.type === "result") {
        busy = false;
        last = { obs: msg.obs, ts: msg.ts };
      } else if (msg.type === "ready") {
        clearTimeout(timer);
        worker.onerror = null;
        resolve(api);
      } else if (msg.type === "fail") {
        clearTimeout(timer);
        fail();
      }
    };
  });
}

// Face-mesh corner indices (MediaPipe topology): two eyes and the mouth ring.
const EYE_A = [33, 133];   // one eye's outer/inner corners
const EYE_B = [263, 362];  // the other eye's corners
const MOUTH = [61, 291, 13, 14, 0, 17];

/** Try to auto-locate eyes/mouth on a DRAWING (IMAGE mode). Returns
 *  {eyes:{L:[x,y],R:[x,y]}, eyeHalf, mouthBox} in canvas px, or null —
 *  photo-trained models often fail on hand drawings, so callers must
 *  fall back to manual clicks. */
export async function detectOnImage(canvas) {
  let landmarker = null;
  try {
    const vision = await FilesetResolver.forVisionTasks(WASM_BASE);
    landmarker = await FaceLandmarker.createFromOptions(vision, {
      baseOptions: { modelAssetPath: MODEL_URL, delegate: "CPU" },
      runningMode: "IMAGE",
      numFaces: 1,
    });
    const result = landmarker.detect(canvas);
    if (!result.faceLandmarks || result.faceLandmarks.length === 0) return null;
    const lm = result.faceLandmarks[0];
    const px = (i) => [lm[i].x * canvas.width, lm[i].y * canvas.height];
    const center = (idx) => idx.map(px).reduce(([ax, ay], [x, y]) => [ax + x / idx.length, ay + y / idx.length], [0, 0]);

    const a = center(EYE_A), b = center(EYE_B);
    // Sprite 'L' is VIEWER-left on the canvas — assign by x, no subject-side logic needed.
    const [L, R] = a[0] <= b[0] ? [a, b] : [b, a];
    const [ax0, ax1] = EYE_A.map(px);
    const eyeHalf = Math.max(8, Math.round(Math.hypot(ax1[0] - ax0[0], ax1[1] - ax0[1]) * 0.7));

    const pts = MOUTH.map(px);
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    const margin = 6;
    const mouthBox = [Math.min(...xs) - margin, Math.min(...ys) - margin,
                      Math.max(...xs) + margin, Math.max(...ys) + margin].map(Math.round);
    return {
      eyes: { L: L.map(Math.round), R: R.map(Math.round) },
      eyeHalf,
      mouthBox,
      // Raw normalized landmarks — stored in the character manifest so the warp
      // rig can use real face geometry instead of box-synthesized rings.
      landmarks: lm.map((p) => [Number(p.x.toFixed(5)), Number(p.y.toFixed(5))]),
    };
  } catch {
    return null; // CDN/offline or detection failure — manual clicks still work
  } finally {
    landmarker?.close();
  }
}
