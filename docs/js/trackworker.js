// Module worker: runs the MediaPipe FaceLandmarker off the main thread so a
// slow detect no longer janks the render loop. Protocol —
//   in : {type:"frame", bitmap:ImageBitmap (transferred), ts}
//   out: {type:"ready"} once initialized, {type:"fail", message} on init error,
//        {type:"result", ts, obs|null} per frame (obs matches tracker.js detect()).
import { CDN_URL, WASM_BASE, MODEL_URL, eulerFromMatrix } from "./trackconfig.js";

// tasks-vision loads its classic wasm loader via importScripts(), which throws
// in module workers. Shim it with sync XHR + indirect eval: synchronous like
// the original, and non-strict global eval so the loader's top-level
// `var ModuleFactory` lands on `self` where the bundle expects it.
self.importScripts = (...urls) => {
  for (const url of urls) {
    const xhr = new XMLHttpRequest();
    xhr.open("GET", url, false);
    xhr.send();
    if (xhr.status !== 200) throw new Error(`importScripts shim: HTTP ${xhr.status} for ${url}`);
    (0, eval)(xhr.responseText);
  }
};

let landmarker = null;

async function init() {
  const { FaceLandmarker, FilesetResolver } = await import(CDN_URL);
  const vision = await FilesetResolver.forVisionTasks(WASM_BASE);
  const options = {
    baseOptions: { modelAssetPath: MODEL_URL, delegate: "GPU" },
    runningMode: "VIDEO",
    numFaces: 1,
    outputFaceBlendshapes: true,
    outputFacialTransformationMatrixes: true,
  };
  try {
    landmarker = await FaceLandmarker.createFromOptions(vision, options);
  } catch {
    options.baseOptions.delegate = "CPU"; // GPU delegate unavailable — retry on CPU
    landmarker = await FaceLandmarker.createFromOptions(vision, options);
  }
}

init().then(
  () => self.postMessage({ type: "ready" }),
  (e) => self.postMessage({ type: "fail", message: e?.message ?? String(e) }),
);

function detect(bitmap, ts) {
  const result = landmarker.detectForVideo(bitmap, ts);
  if (!result.faceBlendshapes || result.faceBlendshapes.length === 0) return null;

  const blend = {};
  for (const c of result.faceBlendshapes[0].categories) blend[c.categoryName] = c.score;

  // Plain {x, y} copies — the observation must survive structured clone.
  const landmarks = result.faceLandmarks?.[0]?.map((p) => ({ x: p.x, y: p.y })) ?? null;

  let yaw = 0, pitch = 0, roll = 0;
  if (result.facialTransformationMatrixes && result.facialTransformationMatrixes.length) {
    ({ yaw, pitch, roll } = eulerFromMatrix(result.facialTransformationMatrixes[0].data));
  }
  return { blend, yaw, pitch, roll, landmarks };
}

self.onmessage = (ev) => {
  const { type, bitmap, ts } = ev.data ?? {};
  if (type !== "frame") return;
  let obs = null;
  try {
    if (landmarker) obs = detect(bitmap, ts);
  } finally {
    bitmap.close();
    // Always answer — the main thread's latest-wins gate waits on this reply.
    self.postMessage({ type: "result", ts, obs });
  }
};
