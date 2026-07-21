// Warp engine — web twin of app/warp_rig.py (box route: every web character
// has onboarding sprites, whose alpha bounds ARE the clicked eye/mouth boxes).
//
// Same design as the desktop rig: synthetic landmarks from the boxes, Delaunay
// mesh over feature points + a pinned border, per-channel displacement fields,
// hybrid layers (eyelid seal, mouth interior) drawn as polygons that follow the
// warped mesh with colors sampled from the drawing. One deliberate difference:
// the ARAP solve only ever moves the 6 free cheek vertices, so it is replaced
// by precomputed inverse-distance weights over the driven vertices — the cheek
// response is baked straight into each field at build time.
import Delaunator from "./delaunator.js";
import { CANVAS } from "./config.js";
import { newCanvas } from "./imageops.js";
import { composeCharacter } from "./compositor.js";

// MediaPipe 478-landmark topology (viewer-left = image-left) — keep in sync
// with app/warp_rig.py.
const L_EYE_TOP = [159, 158, 157, 173, 246, 161, 160];
const L_EYE_BOT = [145, 153, 154, 155, 7, 163, 144];
const R_EYE_TOP = [386, 385, 384, 398, 466, 388, 387];
const R_EYE_BOT = [374, 380, 381, 382, 249, 390, 373];
const L_BROW = [70, 63, 105, 66, 107];
const R_BROW = [300, 293, 334, 296, 336];
const LIP_TOP = [13, 82, 312, 81, 311, 80, 310];
const LIP_BOT = [14, 87, 317, 178, 402, 88, 318];
const MOUTH_CORNERS = [61, 291];
const CHIN = [152, 148, 377, 176, 400];
const FACE_OVAL = [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288,
  397, 365, 379, 378, 152, 148, 176, 149, 150, 136, 172, 58,
  132, 93, 234, 127, 162, 21, 54, 103, 67, 109];
const NOSE = [1, 4, 5, 195, 197, 6];
const CHEEKS = [50, 280, 101, 330, 205, 425];
const EYE_SPAN = [33, 263];
const FEATURE = [...new Set([
  ...L_EYE_TOP, ...L_EYE_BOT, ...R_EYE_TOP, ...R_EYE_BOT, ...L_BROW, ...R_BROW,
  ...LIP_TOP, ...LIP_BOT, ...MOUTH_CORNERS, ...CHIN, ...FACE_OVAL, ...NOSE, ...CHEEKS,
])].sort((a, b) => a - b);

const UNIT_REF = 135.6;
const BLINK_MAX = 0.62;
const SEAL_RAMP = [0.70, 1.0];
const JAW_RAMP = [0.30, 0.60];
const MOUTH_FILL = [138, 53, 53]; // #8a3535, matches the sprite default style
const PARALLAX_AMP = [10.0, 7.0];
const PARALLAX_DEPTH = new Map();
for (const i of [...LIP_TOP, ...LIP_BOT, ...MOUTH_CORNERS]) PARALLAX_DEPTH.set(i, 0.75);
for (const i of CHIN) PARALLAX_DEPTH.set(i, 0.6);
for (const i of [...L_EYE_TOP, ...L_EYE_BOT, ...R_EYE_TOP, ...R_EYE_BOT, ...L_BROW, ...R_BROW]) {
  PARALLAX_DEPTH.set(i, 0.65);
}
for (const i of NOSE) PARALLAX_DEPTH.set(i, 1.0);
for (const i of FACE_OVAL) { if (!PARALLAX_DEPTH.has(i)) PARALLAX_DEPTH.set(i, 0.15); }

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const smoothstep = (v, [a, b]) => {
  const t = clamp((v - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

function alphaBox(canvas) {
  const { data } = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height);
  let x1 = Infinity, y1 = Infinity, x2 = -1, y2 = -1;
  for (let y = 0; y < canvas.height; y++) {
    for (let x = 0; x < canvas.width; x++) {
      if (data[(y * canvas.width + x) * 4 + 3] > 0) {
        if (x < x1) x1 = x;
        if (x > x2) x2 = x;
        if (y < y1) y1 = y;
        if (y > y2) y2 = y;
      }
    }
  }
  return x2 < 0 ? null : [x1, y1, x2, y2];
}

// Straight port of warp_rig.landmarks_from_boxes.
function landmarksFromBoxes(eyeL, eyeR, mouth, w, h) {
  const lm = Array.from({ length: 478 }, () => [0, 0]);
  const ring = (ids, cx, cy, rx, ry, upper) => {
    ids.forEach((i, k) => {
      const t = ((k + 1) / (ids.length + 1)) * Math.PI;
      lm[i] = [cx - rx * Math.cos(t), upper ? cy - ry * Math.sin(t) : cy + ry * Math.sin(t)];
    });
  };
  const geom = ([x1, y1, x2, y2]) =>
    [(x1 + x2) / 2, (y1 + y2) / 2, Math.max(4, (x2 - x1) / 2), Math.max(3, (y2 - y1) / 2)];

  const [lcx, lcy, lrx, lry] = geom(eyeL);
  const [rcx, rcy, rrx, rry] = geom(eyeR);
  ring(L_EYE_TOP, lcx, lcy, lrx, lry, true);
  ring(L_EYE_BOT, lcx, lcy, lrx, lry, false);
  ring(R_EYE_TOP, rcx, rcy, rrx, rry, true);
  ring(R_EYE_BOT, rcx, rcy, rrx, rry, false);
  lm[EYE_SPAN[0]] = [lcx - lrx * 1.15, lcy];
  lm[EYE_SPAN[1]] = [rcx + rrx * 1.15, rcy];
  L_BROW.forEach((i, k) => { lm[i] = [lcx - lrx + (2 * lrx * k) / (L_BROW.length - 1), lcy - lry * 1.8]; });
  R_BROW.forEach((i, k) => { lm[i] = [rcx - rrx + (2 * rrx * k) / (R_BROW.length - 1), rcy - rry * 1.8]; });

  const [mcx, mcy, mrx, mry] = geom(mouth);
  LIP_TOP.forEach((i, k) => {
    lm[i] = [mcx + mrx * 0.7 * ((2 * k) / (LIP_TOP.length - 1) - 1), mcy - mry * 0.3];
  });
  LIP_BOT.forEach((i, k) => {
    lm[i] = [mcx + mrx * 0.7 * ((2 * k) / (LIP_BOT.length - 1) - 1), mcy + mry * 0.3];
  });
  lm[MOUTH_CORNERS[0]] = [mcx - mrx, mcy];
  lm[MOUTH_CORNERS[1]] = [mcx + mrx, mcy];

  const eyesCy = (lcy + rcy) / 2;
  const faceCx = (lcx + rcx + mcx) / 3;
  const topY = Math.min(lcy - lry, rcy - rry);
  const chinY = mcy + mry + Math.max(8, (mcy - eyesCy) * 0.55);
  const halfW = Math.max(rcx + rrx - faceCx, faceCx - (lcx - lrx), mrx * 1.4) * 1.45;
  const cyMid = (topY + chinY) / 2;
  const halfH = ((chinY - topY) / 2) * 1.3 + mry;
  FACE_OVAL.forEach((i, k) => {
    const a = (2 * Math.PI * k) / FACE_OVAL.length;
    lm[i] = [faceCx + halfW * Math.sin(a), cyMid - halfH * Math.cos(a)];
  });
  CHIN.forEach((i, k) => { // after the oval: shared indices belong to the chin
    const t = (k - (CHIN.length - 1) / 2) / 2;
    lm[i] = [mcx + t * mrx * 1.2, chinY - Math.abs(t) * mry * 0.5];
  });
  const ncx = (lcx + rcx) / 2, ncy = (eyesCy + mcy) / 2;
  NOSE.forEach((i, k) => { lm[i] = [ncx + ((k % 3) - 1) * 4, ncy + Math.floor(k / 3) * 5 - 2.5]; });
  [[(lcx - lrx + mcx - mrx) / 2, (eyesCy + mcy) / 2],
   [(rcx + rrx + mcx + mrx) / 2, (eyesCy + mcy) / 2],
   [(lcx + mcx) / 2, (eyesCy + 2 * mcy) / 3],
   [(rcx + mcx) / 2, (eyesCy + 2 * mcy) / 3],
   [mcx - mrx * 1.3, mcy + mry * 0.4],
   [mcx + mrx * 1.3, mcy + mry * 0.4]].forEach((p, k) => { lm[CHEEKS[k]] = p; });

  // Clamp into the canvas and nudge collisions apart — a duplicated point falls
  // out of the triangulation and loses its influence.
  const seen = new Set();
  for (const i of [...FEATURE, ...EYE_SPAN]) {
    let x = clamp(lm[i][0], 2, w - 3);
    let y = clamp(lm[i][1], 2, h - 3);
    let key = `${x.toFixed(1)},${y.toFixed(1)}`;
    while (seen.has(key)) {
      x = clamp(x + 0.9, 2, w - 3);
      y = clamp(y + 0.7, 2, h - 3);
      key = `${x.toFixed(1)},${y.toFixed(1)}`;
    }
    seen.add(key);
    lm[i] = [x, y];
  }
  return lm;
}

function sampleColors(neutral, lm) {
  const { data } = neutral.getContext("2d").getImageData(0, 0, CANVAS, CANVAS);
  const patch = (x1, y1, x2, y2) => {
    const px = [];
    [x1, x2] = [Math.round(clamp(Math.min(x1, x2), 0, CANVAS - 1)), Math.round(clamp(Math.max(x1, x2), 0, CANVAS - 1))];
    [y1, y2] = [Math.round(clamp(Math.min(y1, y2), 0, CANVAS - 1)), Math.round(clamp(Math.max(y1, y2), 0, CANVAS - 1))];
    for (let y = y1; y <= y2; y++) {
      for (let x = x1; x <= x2; x++) {
        const o = (y * CANVAS + x) * 4;
        px.push([data[o], data[o + 1], data[o + 2]]);
      }
    }
    return px;
  };
  const medianOf = (px) => {
    const mid = (arr) => { const s = [...arr].sort((a, b) => a - b); return s[s.length >> 1]; };
    return [mid(px.map((p) => p[0])), mid(px.map((p) => p[1])), mid(px.map((p) => p[2]))];
  };
  const ink = (px) => {
    const byLuma = [...px].sort((a, b) => (a[0] + a[1] + a[2]) - (b[0] + b[1] + b[2]));
    return medianOf(byLuma.slice(0, Math.max(1, px.length / 20 | 0)));
  };
  const brightMedian = (px) => {
    const byLuma = [...px].sort((a, b) => (a[0] + a[1] + a[2]) - (b[0] + b[1] + b[2]));
    const keep = byLuma.slice(Math.floor(px.length * 0.45));
    return medianOf(keep.length ? keep : px);
  };

  const eyes = {};
  for (const [side, top, bot] of [["L", L_EYE_TOP, L_EYE_BOT], ["R", R_EYE_TOP, R_EYE_BOT]]) {
    const pts = [...top, ...bot].map((i) => lm[i]);
    const x1 = Math.min(...pts.map((p) => p[0])), x2 = Math.max(...pts.map((p) => p[0]));
    const y1 = Math.min(...pts.map((p) => p[1])), y2 = Math.max(...pts.map((p) => p[1]));
    const ry = Math.max(3, (y2 - y1) / 2);
    const band = [...patch(x1, y1 - 1.6 * ry, x2, y1 - 0.4 * ry),
                  ...patch(x1, y2 + 0.3 * ry, x2, y2 + 1.2 * ry)];
    eyes[side] = { lid: brightMedian(band), ink: ink(patch(x1, y1, x2, y2)) };
  }
  const pts = [...LIP_TOP, ...LIP_BOT, ...MOUTH_CORNERS].map((i) => lm[i]);
  const mouthInk = ink(patch(Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1])) - 2,
                             Math.max(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1])) + 2));
  return { eyes, mouthInk };
}

export function buildWarpRig(char) {
  const boxes = [char.eyes.L.open, char.eyes.R.open, char.mouths.closed].map(alphaBox);
  if (boxes.some((b) => !b)) throw new Error("onboarding sprites lack alpha bounds");
  const neutral = composeCharacter(char, "open", "open", "closed");
  const lm = landmarksFromBoxes(boxes[0], boxes[1], boxes[2], CANVAS, CANVAS);

  const vid = new Map(FEATURE.map((i, k) => [i, k]));
  const verts = FEATURE.map((i) => [...lm[i]]);
  const borderSeen = new Set();
  for (let k = 0; k < 9; k++) {
    const t = k / 8;
    for (const p of [[t * (CANVAS - 1), 0], [t * (CANVAS - 1), CANVAS - 1],
                     [0, t * (CANVAS - 1)], [CANVAS - 1, t * (CANVAS - 1)]]) {
      const key = `${p[0]},${p[1]}`;
      if (!borderSeen.has(key)) { borderSeen.add(key); verts.push(p); }
    }
  }
  const tris = Delaunator.from(verts).triangles;
  const scale = Math.hypot(lm[EYE_SPAN[0]][0] - lm[EYE_SPAN[1]][0],
                           lm[EYE_SPAN[0]][1] - lm[EYE_SPAN[1]][1]) / UNIT_REF;

  // ---- displacement fields (value at channel = 1), indexed like verts ----
  const nv = verts.length;
  const field = () => new Float32Array(nv * 2);
  const F = { blinkL: field(), blinkR: field(), smile: field(),
              jawBow: field(), jawSplit: field(), yaw: field(), pitch: field() };
  const add = (f, i, dx, dy) => { const v = vid.get(i); f[v * 2] += dx; f[v * 2 + 1] += dy; };
  const s = scale;

  for (const [f, top, bot] of [[F.blinkL, L_EYE_TOP, L_EYE_BOT], [F.blinkR, R_EYE_TOP, R_EYE_BOT]]) {
    const ringPts = [...top, ...bot].map((i) => lm[i]);
    const cx = ringPts.reduce((a, p) => a + p[0], 0) / ringPts.length;
    const halfW = Math.max(1, (Math.max(...ringPts.map((p) => p[0])) - Math.min(...ringPts.map((p) => p[0]))) / 2);
    const targetY = bot.reduce((a, i) => a + lm[i][1], 0) / bot.length - 1 * s;
    const taper = (x) => Math.max(0.1, 1 - Math.min(1, Math.abs(x - cx) / halfW) ** 2);
    for (const i of top) add(f, i, 0, BLINK_MAX * taper(lm[i][0]) * (targetY - lm[i][1]));
    for (const i of bot) add(f, i, 0, -BLINK_MAX * taper(lm[i][0]) * 1.5 * s);
    // no brow follow on box rigs (a synthesized brow spot can sit on any stroke)
  }
  MOUTH_CORNERS.forEach((i, k) => add(F.smile, i, (k ? 1 : -1) * 7 * s, -9 * s));
  for (const i of LIP_TOP) add(F.smile, i, 0, -2 * s);
  for (const i of LIP_BOT) add(F.smile, i, 0, -3 * s);

  const topY = LIP_TOP.reduce((a, i) => a + lm[i][1], 0) / LIP_TOP.length;
  const botY = LIP_BOT.reduce((a, i) => a + lm[i][1], 0) / LIP_BOT.length;
  const gap = botY - topY;
  for (const i of CHIN) { add(F.jawBow, i, 0, 9 * s); add(F.jawSplit, i, 0, 14 * s); }
  for (const i of [...LIP_TOP, ...LIP_BOT]) {
    const frac = gap > 3 * s ? clamp((lm[i][1] - topY) / gap, 0, 1) : 1;
    add(F.jawBow, i, 0, (3 + 5 * frac) * s);
    add(F.jawSplit, i, 0, (LIP_TOP.includes(i) ? 2 : 14) * s);
  }
  for (const i of MOUTH_CORNERS) { add(F.jawBow, i, 0, 4 * s); add(F.jawSplit, i, 0, 4 * s); }
  for (const [i, depth] of PARALLAX_DEPTH) {
    add(F.yaw, i, PARALLAX_AMP[0] * s * depth, 0);
    add(F.pitch, i, 0, PARALLAX_AMP[1] * s * depth);
  }

  // Cheeks are free vertices on the desktop (ARAP interpolates them); here their
  // response is baked into every field as inverse-distance weights over the 8
  // nearest driven vertices.
  const drivenIdx = FEATURE.filter((i) => !CHEEKS.includes(i)).map((i) => vid.get(i));
  for (const c of CHEEKS) {
    const cv = vid.get(c);
    const near = drivenIdx
      .map((v) => [v, Math.hypot(verts[v][0] - verts[cv][0], verts[v][1] - verts[cv][1])])
      .sort((a, b) => a[1] - b[1]).slice(0, 8);
    const wsum = near.reduce((a, [, d]) => a + 1 / (d * d + 1), 0);
    for (const f of Object.values(F)) {
      let dx = 0, dy = 0;
      for (const [v, d] of near) {
        const w = 1 / (d * d + 1) / wsum;
        dx += w * f[v * 2];
        dy += w * f[v * 2 + 1];
      }
      f[cv * 2] = dx;
      f[cv * 2 + 1] = dy;
    }
  }

  const rings = (ids) => ids.map((i) => vid.get(i));
  return {
    neutral, verts, tris, scale,
    fields: F,
    colors: sampleColors(neutral, lm),
    ringIds: {
      sealL: [rings(L_EYE_TOP), rings(L_EYE_BOT)],
      sealR: [rings(R_EYE_TOP), rings(R_EYE_BOT)],
      lipTop: rings([...LIP_TOP, MOUTH_CORNERS[0]]),
      lipBot: rings([...LIP_BOT, MOUTH_CORNERS[1]]),
    },
    out: newCanvas(CANVAS, CANVAS),
    _warped: new Float32Array(verts.length * 2),
  };
}

// Affine T with T(src_i) = dst_i via Cramer's rule; canvas matrix [a c e; b d f].
function texTriangle(ctx, img, src, dst) {
  const [[u0, v0], [u1, v1], [u2, v2]] = src;
  const [[x0, y0], [x1, y1], [x2, y2]] = dst;
  const den = u0 * (v1 - v2) + u1 * (v2 - v0) + u2 * (v0 - v1);
  if (Math.abs(den) < 1e-6) return;
  const a = (x0 * (v1 - v2) + x1 * (v2 - v0) + x2 * (v0 - v1)) / den;
  const c = (x0 * (u2 - u1) + x1 * (u0 - u2) + x2 * (u1 - u0)) / den;
  const e = (x0 * (u1 * v2 - u2 * v1) + x1 * (u2 * v0 - u0 * v2) + x2 * (u0 * v1 - u1 * v0)) / den;
  const b = (y0 * (v1 - v2) + y1 * (v2 - v0) + y2 * (v0 - v1)) / den;
  const d = (y0 * (u2 - u1) + y1 * (u0 - u2) + y2 * (u1 - u0)) / den;
  const f = (y0 * (u1 * v2 - u2 * v1) + y1 * (u2 * v0 - u0 * v2) + y2 * (u0 * v1 - u1 * v0)) / den;
  // Inflate the clip triangle about its centroid to close antialiasing seams.
  const gx = (x0 + x1 + x2) / 3, gy = (y0 + y1 + y2) / 3;
  const inflate = (x, y) => {
    const len = Math.hypot(x - gx, y - gy) || 1;
    const k = (len + 0.7) / len;
    return [gx + (x - gx) * k, gy + (y - gy) * k];
  };
  ctx.save();
  ctx.beginPath();
  const [ix0, iy0] = inflate(x0, y0);
  ctx.moveTo(ix0, iy0);
  for (const [x, y] of [inflate(x1, y1), inflate(x2, y2)]) ctx.lineTo(x, y);
  ctx.closePath();
  ctx.clip();
  ctx.transform(a, b, c, d, e, f);
  ctx.drawImage(img, 0, 0);
  ctx.restore();
}

function fillRingPoly(ctx, pts, alpha, fill, linePts, line, lineWidth) {
  if (alpha <= 0.02 || pts.length < 3) return;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (const [x, y] of pts.slice(1)) ctx.lineTo(x, y);
  ctx.closePath();
  ctx.fillStyle = `rgb(${fill[0]},${fill[1]},${fill[2]})`;
  ctx.fill();
  if (linePts) {
    ctx.strokeStyle = `rgb(${line[0]},${line[1]},${line[2]})`;
    ctx.lineWidth = lineWidth;
    ctx.lineJoin = "round";
    ctx.beginPath();
    ctx.moveTo(linePts[0][0], linePts[0][1]);
    for (const [x, y] of linePts.slice(1)) ctx.lineTo(x, y);
    ctx.stroke();
  }
  ctx.restore();
}

export function renderWarp(rig, ch) {
  const wOpen = smoothstep(clamp(ch.jaw, 0, 1), JAW_RAMP);
  const k = {
    blinkL: clamp(ch.blinkL, 0, 1), blinkR: clamp(ch.blinkR, 0, 1),
    smile: clamp(ch.smile, 0, 1),
    jawBow: clamp(ch.jaw, 0, 1) * (1 - wOpen), jawSplit: clamp(ch.jaw, 0, 1) * wOpen,
    yaw: clamp(ch.yaw, -1, 1), pitch: clamp(ch.pitch, -1, 1),
  };
  const { verts, tris, fields } = rig;
  const wv = rig._warped;
  let maxDisp = 0;
  for (let i = 0; i < verts.length; i++) {
    let dx = 0, dy = 0;
    for (const name in fields) {
      const kv = k[name];
      if (!kv) continue;
      dx += kv * fields[name][i * 2];
      dy += kv * fields[name][i * 2 + 1];
    }
    wv[i * 2] = verts[i][0] + dx;
    wv[i * 2 + 1] = verts[i][1] + dy;
    const m = Math.max(Math.abs(dx), Math.abs(dy));
    if (m > maxDisp) maxDisp = m;
  }

  const ctx = rig.out.getContext("2d");
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.drawImage(rig.neutral, 0, 0);
  if (maxDisp >= 0.25) {
    for (let t = 0; t < tris.length; t += 3) {
      const ia = tris[t], ib = tris[t + 1], ic = tris[t + 2];
      const src = [verts[ia], verts[ib], verts[ic]];
      const dst = [[wv[ia * 2], wv[ia * 2 + 1]], [wv[ib * 2], wv[ib * 2 + 1]], [wv[ic * 2], wv[ic * 2 + 1]]];
      let moved = 0;
      for (let j = 0; j < 3; j++) {
        moved = Math.max(moved, Math.abs(dst[j][0] - src[j][0]), Math.abs(dst[j][1] - src[j][1]));
      }
      if (moved < 0.25) continue;
      texTriangle(ctx, rig.neutral, src, dst);
    }
  }

  // Hybrid layers on top of the warp (polygons follow the mesh, never boxes).
  const at = (v) => [wv[v * 2], wv[v * 2 + 1]];
  const sortedX = (ids) => ids.map(at).sort((a, b) => a[0] - b[0]);
  for (const [key, amt, colorSide] of [["sealL", k.blinkL, "L"], ["sealR", k.blinkR, "R"]]) {
    const alpha = smoothstep(amt, SEAL_RAMP);
    if (alpha <= 0.02) continue;
    const [topIds, botIds] = rig.ringIds[key];
    const top = sortedX(topIds);
    const poly = [...top, ...sortedX(botIds).reverse()];
    const width = Math.max(2, (Math.max(...poly.map((p) => p[0])) - Math.min(...poly.map((p) => p[0]))) * 0.06);
    const colors = rig.colors.eyes[colorSide];
    fillRingPoly(ctx, poly, alpha, colors.lid, top, colors.ink, width);
  }
  const alphaMouth = wOpen;
  if (alphaMouth > 0.02) {
    const top = sortedX(rig.ringIds.lipTop);
    const poly = [...top, ...sortedX(rig.ringIds.lipBot).reverse()];
    const heights = poly.map((p) => p[1]);
    if (Math.max(...heights) - Math.min(...heights) >= 3 * rig.scale) {
      fillRingPoly(ctx, poly, alphaMouth, MOUTH_FILL, [...poly, poly[0]],
                   rig.colors.mouthInk, Math.max(2, 3 * rig.scale));
    }
  }
  return rig.out;
}
