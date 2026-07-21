// Shared between tracker.js (main thread) and trackworker.js (worker) — a
// worker cannot import tracker.js without pulling the whole module, so the
// CDN/model locations and head-pose math live here as the single source of truth.
export const CDN_URL = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.17";
export const WASM_BASE = `${CDN_URL}/wasm`;
export const MODEL_URL =
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
export function eulerFromMatrix(data) {
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
