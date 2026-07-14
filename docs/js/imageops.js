// Port of the pixel primitives in app/onboard.py (fit_512, _border_median,
// _ink_color, snap_to_ink). Pixel work goes through ImageData typed arrays;
// canvas API is used only for whole-image ops (drawImage scaling), never in
// per-pixel loops. Shared low-level helpers are exported for onboard.js/derive.js.
import { CANVAS } from "./config.js";

export function newCanvas(w, h) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}

export function getData(canvas) {
  return canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height);
}

/** Wrap a Uint8ClampedArray RGBA buffer as a canvas. */
export function canvasFromData(buf, w, h) {
  const c = newCanvas(w, h);
  c.getContext("2d").putImageData(new ImageData(buf, w, h), 0, 0);
  return c;
}

export function hexToRgb(hex) {
  const h = hex.replace(/^#/, "");
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

export function rgbToHex(r, g, b) {
  const h = (v) => v.toString(16).padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}`;
}

export const rad = (deg) => (deg * Math.PI) / 180;

/** Round half-to-even, matching python's built-in round() (Math.round is half-up). */
export function bankersRound(v) {
  const r = Math.round(v);
  return Math.abs(v - Math.trunc(v)) === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

/** Median floored to int — matches python int(statistics.median(...)). */
export function median(arr) {
  const n = arr.length;
  if (!n) return 0;
  const a = [...arr].sort((p, q) => p - q);
  const m = n >> 1;
  const v = n % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
  return Math.floor(v);
}

function edgeMedian(canvas) {
  const { data, width: w, height: h } = getData(canvas);
  const R = [], G = [], B = [];
  const push = (x, y) => { const i = (y * w + x) * 4; R.push(data[i]); G.push(data[i + 1]); B.push(data[i + 2]); };
  for (let x = 0; x < w; x++) for (const y of [0, 1, h - 2, h - 1]) push(x, y);
  for (let y = 0; y < h; y++) for (const x of [0, 1, w - 2, w - 1]) push(x, y);
  return [median(R), median(G), median(B)];
}

/** Port of fit_512: fit + center onto a 512 canvas, padded with the source's border-median color. */
export function fit512(imgSource) {
  const sw = imgSource.naturalWidth || imgSource.width;
  const sh = imgSource.naturalHeight || imgSource.height;
  const src = newCanvas(sw, sh);
  src.getContext("2d").drawImage(imgSource, 0, 0);
  const [br, bg, bb] = edgeMedian(src);
  const s = Math.min(CANVAS / sw, CANVAS / sh);
  const w = Math.floor(sw * s), h = Math.floor(sh * s);
  const out = newCanvas(CANVAS, CANVAS);
  const ctx = out.getContext("2d");
  ctx.fillStyle = `rgb(${br},${bg},${bb})`;
  ctx.fillRect(0, 0, CANVAS, CANVAS);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(src, 0, 0, sw, sh, Math.floor((CANVAS - w) / 2), Math.floor((CANVAS - h) / 2), w, h);
  return out;
}

/** Port of snap_to_ink: centroid of ink pixels (r+g+b < 300) within ±r box. */
export function snapToInk(canvas, cx, cy, r) {
  const { data, width: w, height: h } = getData(canvas);
  const x0 = Math.max(0, cx - r), y0 = Math.max(0, cy - r);
  const x1 = Math.min(w, cx + r), y1 = Math.min(h, cy + r);
  let sx = 0, sy = 0, n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * w + x) * 4;
      if (data[i] + data[i + 1] + data[i + 2] < 300) { sx += x - x0; sy += y - y0; n++; }
    }
  }
  if (!n) return [cx, cy];
  return [x0 + Math.floor(sx / n), y0 + Math.floor(sy / n)];
}

/** Port of _border_median (ring=4): median color of the ring just outside box. */
export function borderMedian(canvas, box, ring = 4) {
  const { data, width: w, height: h } = getData(canvas);
  const [x0, y0, x1, y1] = box;
  const R = [], G = [], B = [];
  const push = (x, y) => { const i = (y * w + x) * 4; R.push(data[i]); G.push(data[i + 1]); B.push(data[i + 2]); };
  for (let x = Math.max(0, x0 - ring); x < Math.min(w, x1 + ring); x++) {
    for (let y = Math.max(0, y0 - ring); y < y0; y++) push(x, y);
    for (let y = y1; y < Math.min(h, y1 + ring); y++) push(x, y);
  }
  for (let y = Math.max(0, y0); y < Math.min(h, y1); y++) {
    for (let x = Math.max(0, x0 - ring); x < x0; x++) push(x, y);
    for (let x = x1; x < Math.min(w, x1 + ring); x++) push(x, y);
  }
  return [median(R), median(G), median(B)];
}

/** Port of _ink_color: median of dark (r+g+b < 300) pixels in box, else #1a1a1a. */
export function inkColor(canvas, box) {
  const { data, width: w, height: h } = getData(canvas);
  const x0 = Math.max(0, box[0]), y0 = Math.max(0, box[1]);
  const x1 = Math.min(w, box[2]), y1 = Math.min(h, box[3]);
  const R = [], G = [], B = [];
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * w + x) * 4;
      if (data[i] + data[i + 1] + data[i + 2] < 300) { R.push(data[i]); G.push(data[i + 1]); B.push(data[i + 2]); }
    }
  }
  if (!R.length) return "#1a1a1a";
  return rgbToHex(median(R), median(G), median(B));
}
