// Canvas compositor — the web counterpart of app/sprite_backend.py's
// SpriteCharacter.compose + apply_head_transform. Sprites are 512x512 RGBA
// overlays aligned to a flattened base; canvas alpha compositing replaces the
// premultiplied numpy math. Sprite keys 'L'/'R' are VIEWER-left/right.
import { CANVAS } from "./config.js";
import { newCanvas } from "./imageops.js";

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function req(canvases, file) {
  const c = canvases[file];
  if (!c) throw new Error(`missing sprite: ${file} (artwork is never auto-generated)`);
  return c;
}

// Flatten a possibly-transparent base onto white paper, once, into a 512 canvas.
function flattenBase(base) {
  const c = newCanvas(CANVAS, CANVAS);
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, CANVAS, CANVAS);
  ctx.drawImage(base, 0, 0);
  return c;
}

// From {name, manifest, canvases:{file:canvas}} (store.js loadCharacter shape) build
// the runtime character: flattened base, eye/mouth sprite lookup, memo cache. Absent
// optional sprites resolve once here (half->open, smile->closed), like sprite_backend.
export function prepareCharacter(loaded) {
  const { canvases } = loaded;
  const base = flattenBase(req(canvases, "base.png"));

  const eyes = {};
  for (const side of ["L", "R"]) {
    const open = req(canvases, `eye_${side}_open.png`);
    const closed = req(canvases, `eye_${side}_closed.png`);
    const half = canvases[`eye_${side}_half.png`] ?? open;
    eyes[side] = { open, half, closed };
  }

  const mouths = {};
  for (const k of ["closed", "A", "E", "I", "O", "U"]) mouths[k] = req(canvases, `mouth_${k}.png`);
  mouths.smile = canvases["mouth_smile.png"] ?? mouths.closed;

  return { name: loaded.name, manifest: loaded.manifest, base, eyes, mouths, memo: new Map() };
}

// Memoized per-state composite (base + eye L + eye R + mouth), <=72 combinations.
// Callers must NOT mutate the returned canvas — it is the cached instance.
export function composeCharacter(char, eyeL, eyeR, mouth) {
  const key = `${eyeL}|${eyeR}|${mouth}`;
  const cached = char.memo.get(key);
  if (cached) return cached;

  const c = newCanvas(CANVAS, CANVAS);
  const ctx = c.getContext("2d");
  ctx.drawImage(char.base, 0, 0);
  ctx.drawImage(char.eyes.L[eyeL], 0, 0);
  ctx.drawImage(char.eyes.R[eyeR], 0, 0);
  ctx.drawImage(char.mouths[mouth], 0, 0);
  char.memo.set(key, c);
  return c;
}

// getImageData is a synchronous GPU->CPU readback — cache per composed canvas
// (composites are memoized and never mutated, so the corner pixel is invariant).
const bgColorCache = new WeakMap();
function topLeftColor(canvas) {
  let color = bgColorCache.get(canvas);
  if (!color) {
    const px = canvas.getContext("2d").getImageData(0, 0, 1, 1).data;
    color = `rgb(${px[0]},${px[1]},${px[2]})`;
    bgColorCache.set(canvas, color);
  }
  return color;
}

// Draw a composed character onto ctx (512x512) with a cheap 2.5D head transform:
// translate for yaw/pitch, rotate for roll, both about the canvas center — matching
// app/sprite_backend.apply_head_transform. BORDER_REPLICATE is approximated by
// pre-filling with the composed top-left pixel color.
export function drawScene(ctx, composed, head, headCfg) {
  const dx = clamp(head.yaw * headCfg.yawGainPx, -headCfg.maxShiftPx, headCfg.maxShiftPx);
  const dy = clamp(head.pitch * headCfg.pitchGainPx, -headCfg.maxShiftPx, headCfg.maxShiftPx);
  const angleDeg = clamp(head.roll * headCfg.rollGain, -headCfg.maxRollDeg, headCfg.maxRollDeg);
  const cx = CANVAS / 2, cy = CANVAS / 2;

  ctx.save();
  ctx.fillStyle = topLeftColor(composed);
  ctx.fillRect(0, 0, CANVAS, CANVAS);
  // Transform = Translate(dx,dy) ∘ RotateAboutCenter(angle); negative angle matches
  // OpenCV getRotationMatrix2D's CCW-positive convention (canvas rotate is CW-positive).
  ctx.translate(cx + dx, cy + dy);
  ctx.rotate((-angleDeg * Math.PI) / 180);
  ctx.translate(-cx, -cy);
  ctx.drawImage(composed, 0, 0);
  ctx.restore();
}
