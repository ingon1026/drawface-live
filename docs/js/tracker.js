// MediaPipe Face Landmarker wrapper (browser only) — the web counterpart of
// app/face_tracker.py. Loads @mediapipe/tasks-vision from CDN; detect() returns
// blendshapes + head euler angles + normalized landmarks, or null when no face.
import { CDN_URL, WASM_BASE, MODEL_URL, eulerFromMatrix } from "./trackconfig.js?v=20260729.5";

// Load MediaPipe only when tracking or image auto-detection is requested. A
// static CDN import prevents the entire authoring UI from starting when the
// user is offline or the CDN is temporarily unavailable.
let tasksVisionPromise = null;
let tasksVisionAttempt = 0;
async function loadTasksVision() {
  if (!tasksVisionPromise) {
    // Browsers cache a rejected module import by URL. Give retries a distinct
    // URL so the retry button really performs another CDN request instead of
    // immediately replaying the earlier offline failure.
    const url = tasksVisionAttempt ? `${CDN_URL}?retry=${tasksVisionAttempt}` : CDN_URL;
    tasksVisionPromise = import(url).catch((err) => {
      tasksVisionPromise = null; // a later retry may succeed after reconnecting
      tasksVisionAttempt += 1;
      throw new Error(`could not load MediaPipe tasks-vision from CDN (offline?): ${err.message}`);
    });
  }
  return tasksVisionPromise;
}

export async function createTracker() {
  let vision;
  let FaceLandmarker, FilesetResolver;
  try {
    ({ FaceLandmarker, FilesetResolver } = await loadTasksVision());
    vision = await FilesetResolver.forVisionTasks(WASM_BASE);
  } catch (e) {
    throw new Error(e.message ?? `could not load MediaPipe tasks-vision wasm from CDN (offline?)`);
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

/** Off-main-thread tracker: {sendFrame(video, tsMs), latest() → {obs, ts}|null,
 * failed(), close()}.
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
    worker = new Worker(new URL("./trackworker.js?v=20260729.5", import.meta.url), { type: "module" });
  } catch {
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    let last = null;
    let busy = false;
    let ready = false;
    let failed = false;
    let closed = false;
    let timer;
    const api = {
      sendFrame(videoEl, tsMs) {
        if (failed || busy || !videoEl.videoWidth) return; // latest-wins: drop while busy
        busy = true;
        createImageBitmap(videoEl).then(
          (bitmap) => {
            if (failed) { bitmap.close(); busy = false; return; }
            try {
              worker.postMessage({ type: "frame", bitmap, ts: tsMs }, [bitmap]);
            } catch {
              bitmap.close();
              fail();
            }
          },
          () => { busy = false; },
        );
      },
      latest() {
        return last;
      },
      failed() {
        return failed;
      },
      close() {
        closed = true;
        clearTimeout(timer);
        worker.terminate();
      },
    };
    const fail = () => {
      if (closed || failed) return;
      failed = true;
      busy = false;
      clearTimeout(timer);
      worker.terminate();
      if (!ready) resolve(null);
    };
    timer = setTimeout(fail, WORKER_INIT_TIMEOUT_MS);
    // Keep this installed after ready too: an inference exception otherwise
    // leaves the latest-wins gate permanently busy with no way to recover.
    worker.onerror = fail;
    worker.onmessage = (ev) => {
      const msg = ev.data;
      if (msg.type === "result") {
        busy = false;
        last = { obs: msg.obs, ts: msg.ts };
      } else if (msg.type === "ready") {
        clearTimeout(timer);
        ready = true;
        resolve(api);
      } else if (msg.type === "fail" || msg.type === "error") {
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
    const { FaceLandmarker, FilesetResolver } = await loadTasksVision();
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
