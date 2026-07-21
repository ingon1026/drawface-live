// Port of scripts/derive_sprites.py: mechanical warps of existing sprites plus
// procedural visemes from a closed-mouth stroke. No new artwork. deriveAll never
// overwrites an existing canvas key (hand-made sprites win). Pixel work is on
// typed arrays; canvas API only for whole-image ops (arc/ellipse draw, resize).
import { CANVAS, DERIVE } from "./config.js";
import { newCanvas, getData, canvasFromData, hexToRgb, median, rad, bankersRound, bboxAlpha } from "./imageops.js";

const N = CANVAS * CANVAS;

/** Port of make_procedural_closed: lower-half ellipse arc from manifest params. */
function makeProceduralClosed(manifest) {
  const [cx, cy] = manifest.mouthCenter;
  const halfW = Math.trunc(manifest.mouthStyle?.width ?? 20);
  const line = manifest.mouthStyle?.line ?? "#2e2e2e";
  const c = newCanvas(CANVAS, CANVAS);
  const ctx = c.getContext("2d");
  ctx.strokeStyle = line;
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.ellipse(cx, cy, halfW, Math.trunc(halfW * 0.55), 0, rad(25), rad(155), false);
  ctx.stroke();
  return c;
}

/** Mark mask=1 where placed lip's raw alpha exceeds thr, clipped to canvas. */
function stampAlpha(mask, lip, xLeft, top, thr) {
  const { data, width: lw, height: lh } = lip;
  for (let ly = 0; ly < lh; ly++) {
    const dy = top + ly;
    if (dy < 0 || dy >= CANVAS) continue;
    for (let lx = 0; lx < lw; lx++) {
      const dx = xLeft + lx;
      if (dx < 0 || dx >= CANVAS) continue;
      if (data[(ly * lw + lx) * 4 + 3] > thr) mask[dy * CANVAS + dx] = 1;
    }
  }
}

/** Src-over lip onto out; blends all 4 channels like python _place. */
function compositeLip(out, lip, xLeft, top) {
  const { data, width: lw, height: lh } = lip;
  for (let ly = 0; ly < lh; ly++) {
    const dy = top + ly;
    if (dy < 0 || dy >= CANVAS) continue;
    for (let lx = 0; lx < lw; lx++) {
      const dx = xLeft + lx;
      if (dx < 0 || dx >= CANVAS) continue;
      const k = (ly * lw + lx) * 4;
      const a = data[k + 3] / 255;
      if (a === 0) continue;
      const i = (dy * CANVAS + dx) * 4;
      for (let ch = 0; ch < 4; ch++) out[i + ch] = data[k + ch] * a + out[i + ch] * (1 - a);
    }
  }
}

/** 3x3 max dilation, `iters` times. */
function dilate(mask, iters) {
  let cur = mask;
  for (let it = 0; it < iters; it++) {
    const next = new Uint8Array(N);
    for (let y = 0; y < CANVAS; y++) {
      for (let x = 0; x < CANVAS; x++) {
        let v = 0;
        for (let dy = -1; dy <= 1 && !v; dy++) {
          const ny = y + dy;
          if (ny < 0 || ny >= CANVAS) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx;
            if (nx >= 0 && nx < CANVAS && cur[ny * CANVAS + nx]) { v = 1; break; }
          }
        }
        next[y * CANVAS + x] = v;
      }
    }
    cur = next;
  }
  return cur;
}

function buildViseme(y0, mw, sh, cxf, strokeCanvas, colors, ink, thickness, p) {
  const lipW = Math.max(2, Math.trunc(mw * p.wx));
  const lipCanvas = newCanvas(lipW, sh);
  const lctx = lipCanvas.getContext("2d");
  lctx.imageSmoothingEnabled = true;
  lctx.imageSmoothingQuality = "high";
  lctx.drawImage(strokeCanvas, 0, 0, mw, sh, 0, 0, lipW, sh);
  const lip = lctx.getImageData(0, 0, lipW, sh);
  const drop = Math.trunc(mw * p.drop);
  const xoff = bankersRound(cxf - lipW / 2);

  const out = new Uint8ClampedArray(N * 4);

  // interior: per column, fill between the bottom of the top lip and the top of
  // the bottom lip. Masks threshold raw lip alpha at >123 (python _place squares
  // alpha, so its `>60` on the placed layer equals raw alpha > 123.69).
  const topMask = new Uint8Array(N);
  const botMask = new Uint8Array(N);
  stampAlpha(topMask, lip, xoff, y0, 123);
  stampAlpha(botMask, lip, xoff, y0 + drop, 123);
  for (let x = 0; x < CANVAS; x++) {
    let tcLast = -1;
    for (let y = CANVAS - 1; y >= 0; y--) { if (topMask[y * CANVAS + x]) { tcLast = y; break; } }
    if (tcLast < 0) continue;
    let bcFirst = -1;
    for (let y = 0; y < CANVAS; y++) { if (botMask[y * CANVAS + x]) { bcFirst = y; break; } }
    if (bcFirst < 0 || bcFirst <= tcLast) continue;
    for (let y = tcLast; y <= bcFirst; y++) {
      const i = (y * CANVAS + x) * 4;
      out[i] = colors.fill[0]; out[i + 1] = colors.fill[1]; out[i + 2] = colors.fill[2]; out[i + 3] = 255;
    }
  }

  const inner = new Uint8Array(N);
  let anyInner = false, firstRow = -1, lastRow = -1;
  for (let y = 0; y < CANVAS; y++) {
    let rowHas = false;
    for (let x = 0; x < CANVAS; x++) {
      if (out[(y * CANVAS + x) * 4 + 3] > 0) { inner[y * CANVAS + x] = 1; rowHas = true; anyInner = true; }
    }
    if (rowHas) { if (firstRow < 0) firstRow = y; lastRow = y; }
  }

  if (p.teeth > 0 && anyInner) {
    const bandEnd = Math.min(CANVAS, firstRow + Math.max(2, Math.trunc(drop * p.teeth)));
    for (let y = firstRow; y < bandEnd; y++) {
      for (let x = 0; x < CANVAS; x++) {
        if (inner[y * CANVAS + x]) {
          const i = (y * CANVAS + x) * 4;
          out[i] = colors.teeth[0]; out[i + 1] = colors.teeth[1]; out[i + 2] = colors.teeth[2]; out[i + 3] = 255;
        }
      }
    }
  }

  if (p.tongue > 0 && anyInner) {
    // top half of an ellipse centered at the interior floor (cv2 angles 180..360).
    const tc = newCanvas(CANVAS, CANVAS);
    const tctx = tc.getContext("2d");
    tctx.fillStyle = `rgb(${colors.tongue[0]},${colors.tongue[1]},${colors.tongue[2]})`;
    tctx.beginPath();
    tctx.ellipse(Math.trunc(cxf), lastRow, Math.trunc(mw * 0.28), Math.max(2, Math.trunc(drop * p.tongue)),
      0, Math.PI, 2 * Math.PI, false);
    tctx.fill();
    const td = tctx.getImageData(0, 0, CANVAS, CANVAS).data;
    for (let idx = 0; idx < N; idx++) {
      if (td[idx * 4 + 3] > 127 && inner[idx]) {
        out[idx * 4] = colors.tongue[0]; out[idx * 4 + 1] = colors.tongue[1];
        out[idx * 4 + 2] = colors.tongue[2]; out[idx * 4 + 3] = 255;
      }
    }
  }

  compositeLip(out, lip, xoff, y0);
  compositeLip(out, lip, xoff, y0 + drop);

  // ink outline: dilate the content mask and paint the new ring in ink under the
  // content (contract's equivalent of cv2.drawContours).
  const mask0 = new Uint8Array(N);
  for (let idx = 0; idx < N; idx++) mask0[idx] = out[idx * 4 + 3] > 60 ? 1 : 0;
  const dil = dilate(mask0, Math.round(thickness / 2) + 1);
  for (let idx = 0; idx < N; idx++) {
    if (dil[idx] && !mask0[idx]) {
      const ca = out[idx * 4 + 3] / 255;
      out[idx * 4] = out[idx * 4] * ca + ink[0] * (1 - ca);
      out[idx * 4 + 1] = out[idx * 4 + 1] * ca + ink[1] * (1 - ca);
      out[idx * 4 + 2] = out[idx * 4 + 2] * ca + ink[2] * (1 - ca);
      out[idx * 4 + 3] = 255;
    }
  }
  return canvasFromData(out, CANVAS, CANVAS);
}

/** Port of derive_mouth_set: A/E/I/O/U from the closed-mouth stroke + manifest. */
function deriveMouthSet(canvases, manifest, closed) {
  const closedData = getData(closed);
  const bb = bboxAlpha(closedData);
  if (!bb) return;
  const [x0, y0, x1, y1] = bb;
  const mw = x1 - x0, sh = y1 - y0, cxf = (x0 + x1) / 2;
  const strokeCanvas = newCanvas(mw, sh);
  strokeCanvas.getContext("2d").putImageData(closed.getContext("2d").getImageData(x0, y0, mw, sh), 0, 0);

  const style = manifest.mouthStyle ?? {};
  const colors = {
    fill: hexToRgb(style.fill ?? "#8a3535").map((v) => Math.floor(v * DERIVE.fillDarken)),
    tongue: hexToRgb(style.tongue ?? "#d97b7b"),
    teeth: hexToRgb(style.teeth ?? "#ffffff"),
  };

  // ink color = median of opaque stroke pixels; thickness = mean ink px/col * 0.9.
  const cd = closedData.data;
  const iR = [], iG = [], iB = [];
  for (let idx = 0; idx < N; idx++) {
    if (cd[idx * 4 + 3] > 200) { iR.push(cd[idx * 4]); iG.push(cd[idx * 4 + 1]); iB.push(cd[idx * 4 + 2]); }
  }
  const ink = iR.length ? [median(iR), median(iG), median(iB)] : [43, 43, 43];
  let colSum = 0;
  for (let x = x0; x < x1; x++) {
    let cnt = 0;
    for (let y = 0; y < CANVAS; y++) if (cd[(y * CANVAS + x) * 4 + 3] > 60) cnt++;
    colSum += cnt;
  }
  const thickness = Math.max(2, bankersRound((colSum / (x1 - x0)) * 0.9));

  for (const [name, p] of Object.entries(DERIVE.visemes)) {
    const key = `mouth_${name}.png`;
    if (key in canvases) continue;
    canvases[key] = buildViseme(y0, mw, sh, cxf, strokeCanvas, colors, ink, thickness, p);
  }
}

/** Port of derive_half_eye: vertical squash of the open eye, anchored at its bbox bottom. */
function deriveHalfEye(open) {
  const bb = bboxAlpha(getData(open));
  if (!bb) return canvasFromData(new Uint8ClampedArray(N * 4), CANVAS, CANVAS);
  const [x0, y0, x1, y1] = bb;
  const cw = x1 - x0, chh = y1 - y0;
  const newH = Math.max(2, bankersRound(chh * DERIVE.squash));
  const src = newCanvas(cw, chh);
  src.getContext("2d").putImageData(open.getContext("2d").getImageData(x0, y0, cw, chh), 0, 0);
  const out = newCanvas(CANVAS, CANVAS);
  const octx = out.getContext("2d");
  octx.imageSmoothingEnabled = true;
  octx.imageSmoothingQuality = "high";
  octx.drawImage(src, 0, 0, cw, chh, x0, y1 - newH, cw, newH);
  return out;
}

/** Port of derive_smile: per-column integer lift (corners rise, center still). */
function deriveSmile(closed) {
  const d = getData(closed);
  const data = d.data;
  const bb = bboxAlpha(d);
  if (!bb) return canvasFromData(new Uint8ClampedArray(N * 4), CANVAS, CANVAS);
  const [x0, y0, x1, y1] = bb;
  const cxf = (x0 + x1) / 2, halfW = Math.max(1, (x1 - x0) / 2);
  const amp = (x1 - x0) * DERIVE.smileAmpFrac;
  const out = new Uint8ClampedArray(N * 4);
  for (let x = x0; x < x1; x++) {
    const t = Math.min(1, Math.abs(x - cxf) / halfW);
    const shift = bankersRound(amp * t * t);
    for (let y = 0; y < CANVAS; y++) {
      if (shift > 0 && y >= CANVAS - shift) continue;
      const si = ((y + shift) * CANVAS + x) * 4, di = (y * CANVAS + x) * 4;
      out[di] = data[si]; out[di + 1] = data[si + 1]; out[di + 2] = data[si + 2]; out[di + 3] = data[si + 3];
    }
  }
  return canvasFromData(out, CANVAS, CANVAS);
}

/** Adds derived sprites to `canvases` in place; never overwrites an existing key. */
export function deriveAll(canvases, manifest) {
  if (!("mouth_closed.png" in canvases) && manifest.proceduralMouth) {
    canvases["mouth_closed.png"] = makeProceduralClosed(manifest);
  }
  const closed = canvases["mouth_closed.png"];
  if (closed) {
    deriveMouthSet(canvases, manifest, closed);
    if (!("mouth_smile.png" in canvases)) canvases["mouth_smile.png"] = deriveSmile(closed);
  }
  for (const side of ["L", "R"]) {
    const open = canvases[`eye_${side}_open.png`];
    const key = `eye_${side}_half.png`;
    if (open && !(key in canvases)) canvases[key] = deriveHalfEye(open);
  }
}
