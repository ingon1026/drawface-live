// MediaPipe Face Landmarker wrapper (browser only) — the web counterpart of
// app/face_tracker.py. Loads @mediapipe/tasks-vision from CDN; detect() returns
// blendshapes + head euler angles + normalized landmarks, or null when no face.
import { FaceLandmarker, FilesetResolver } from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.17";

const WASM_BASE = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.17/wasm";
const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/latest/face_landmarker.task";

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const DEG = 180 / Math.PI;

// Decompose a 4x4 face transform (flat 16) into yaw/pitch/roll degrees, matching
// app/face_tracker.py's atan2/asin on the 3x3 rotation block.
//
// tasks-vision docs are ambiguous on row- vs column-major, so detect the layout
// at runtime: the homogeneous translation column/row is the tell. Row-major stores
// translation at indices 3,7,11 (indices 12,13,14 == 0); column-major stores it at
// 12,13,14 (indices 3,7,11 == 0). The face's camera-space translation (esp. tz) is
// always substantially non-zero, so whichever triple has the larger magnitude marks
// the layout. Getting this wrong would transpose the rotation and flip every angle.
function eulerFromMatrix(data) {
  const colMajorT = Math.abs(data[12]) + Math.abs(data[13]) + Math.abs(data[14]);
  const rowMajorT = Math.abs(data[3]) + Math.abs(data[7]) + Math.abs(data[11]);
  const colMajor = colMajorT >= rowMajorT;
  // r(row, col) of the rotation block, layout-correct either way.
  const r = colMajor ? (row, col) => data[col * 4 + row] : (row, col) => data[row * 4 + col];
  return {
    yaw: Math.atan2(r(0, 2), r(2, 2)) * DEG,
    pitch: Math.asin(clamp(-r(1, 2), -1, 1)) * DEG,
    roll: Math.atan2(r(1, 0), r(0, 0)) * DEG,
  };
}

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
