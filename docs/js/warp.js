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
import { newCanvas, getData, hexToRgb, bboxAlpha } from "./imageops.js";
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
const MESH_ROLL_RAD = 0.21; // face-only roll: radians (~12 deg) of rigid tilt at channel +-1
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
  const b = bboxAlpha(getData(canvas));
  return b && [b[0], b[1], b[2] - 1, b[3] - 1]; // exclusive max -> inclusive
}

// 원본(src)의 입이 **확실히 다물려 있을 때만** true. hi-res 원본을 warp 기준으로 쓸 수 있는지의
// 게이트다 — 원본에 벌린 입이 박혀 있으면 하이브리드 입 폴리곤과 겹쳐 입이 둘로 보이므로,
// 조금이라도 애매하면 false 를 돌려 입 지운 base 합성으로 안전하게 떨어진다(선명도만 약간 손해).
// 판정: 어두운 행(입 획·입 안 그늘)의 세로 스팬. 다문 입 획은 얇은 가로 띠(스팬 작음),
// 벌린 입은 입술 윤곽선+안쪽 그늘이 세로로 넓게 분포(스팬 큼). 스팬이 작을 때만 "다묾" 확정.
function mouthLooksClosed(src, closedBox512, canvasSize) {
  if (!closedBox512) return false;
  const [bx0, by0, bx1, by1] = closedBox512;
  const cx = (bx0 + bx1) / 2, cy = (by0 + by1) / 2, halfW = Math.max(8, (bx1 - bx0) / 2);
  const sc = src.width / canvasSize;
  const x0 = Math.max(0, Math.round((cx - halfW) * sc)), x1 = Math.min(src.width, Math.round((cx + halfW) * sc));
  const y0 = Math.max(0, Math.round((cy - 0.9 * halfW) * sc)), y1 = Math.min(src.height, Math.round((cy + 0.9 * halfW) * sc));
  const w = x1 - x0, h = y1 - y0;
  if (w < 4 || h < 4) return false;                                       // 판정 불가 → 안전(base)
  const d = src.getContext("2d").getImageData(x0, y0, w, h).data;
  let first = -1, last = -1;
  for (let r = 0; r < h; r++) {
    let rowDark = 0;
    for (let c = 0; c < w; c++) {
      const i = (r * w + c) * 4;
      if (d[i + 3] < 128) continue;                                       // 투명 제외
      if (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2] < 110) rowDark++;
    }
    if (rowDark > w * 0.06) { if (first < 0) first = r; last = r; }       // 유의미하게 어두운 행
  }
  if (first < 0) return true;                                             // 어두운 게 전혀 없음 = 다묾
  return (last - first + 1) / h <= 0.18;                                  // 얇은 띠일 때만 다묾 확정
}

// Straight port of warp_rig.landmarks_from_boxes. Exported for tests.
export function landmarksFromBoxes(eyeL, eyeR, mouth, w, h) {
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
  const size = neutral.width;
  const { data } = getData(neutral);
  const patch = (x1, y1, x2, y2) => {
    const px = [];
    [x1, x2] = [Math.round(clamp(Math.min(x1, x2), 0, size - 1)), Math.round(clamp(Math.max(x1, x2), 0, size - 1))];
    [y1, y2] = [Math.round(clamp(Math.min(y1, y2), 0, size - 1)), Math.round(clamp(Math.max(y1, y2), 0, size - 1))];
    for (let y = y1; y <= y2; y++) {
      for (let x = x1; x <= x2; x++) {
        const o = (y * size + x) * 4;
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

// Detection on stylized faces can "succeed" with sloppy geometry (tiny or
// offset eye rings). The user's clicked boxes are ground truth: stored
// landmarks are only trusted when each feature ring actually sits on its box.
function landmarksAgreeWithBoxes(lm, [eyeL, eyeR, mouth]) {
  const centroid = (ids) => ids.reduce(
    (a, i) => [a[0] + lm[i][0] / ids.length, a[1] + lm[i][1] / ids.length], [0, 0]);
  const ringW = (ids) => {
    const xs = ids.map((i) => lm[i][0]);
    return Math.max(...xs) - Math.min(...xs);
  };
  const fits = (ids, box) => {
    const [x, y] = centroid(ids);
    const bw = box[2] - box[0], bh = box[3] - box[1];
    // ring centered on the clicked feature (within a quarter box) and not tiny
    return Math.abs(x - (box[0] + box[2]) / 2) <= Math.max(6, bw * 0.25)
      && Math.abs(y - (box[1] + box[3]) / 2) <= Math.max(6, bh * 0.25)
      && ringW(ids) >= bw * 0.45;
  };
  return fits([...L_EYE_TOP, ...L_EYE_BOT], eyeL)
    && fits([...R_EYE_TOP, ...R_EYE_BOT], eyeR)
    && fits([...LIP_TOP, ...LIP_BOT, ...MOUTH_CORNERS], mouth);
}

export function buildWarpRig(char) {
  // Hi-res route: the original drawing (stored at up to 1024 by onboarding)
  // already contains the eyes/mouth, so it can BE the warp source directly —
  // sharper output than warping the 512 sprite composite. Geometry stays in
  // 512 space (boxes/landmarks live there) and is scaled up at the end.
  const src = char.source ?? null;
  const boxes = [char.eyes.L.open, char.eyes.R.open, char.mouths.closed].map(alphaBox);
  if (boxes.some((b) => !b)) throw new Error("onboarding sprites lack alpha bounds");
  // hi-res 원본은 입이 **확실히 다물린** 그림에서만 기준으로 쓴다 — 애매하면 입 지운 base 합성
  // (3ffaf46 이전의 검증된 기본값). 감지가 틀려도 입이 둘로 겹치는 대신 선명도만 약간 손해.
  const useSrc = src && mouthLooksClosed(src, boxes[2], CANVAS);
  console.info(`warp neutral: ${useSrc ? "hi-res source" : "base composite"}`);
  const neutral = useSrc ? src : composeCharacter(char, "open", "open", "closed");
  const size = useSrc ? src.width : CANVAS;
  const sizeScale = size / CANVAS;
  // Detectable drawings carry their real 478-point geometry from onboarding —
  // finer lid/lip curves than the box-synthesized rings — but only when it
  // agrees with where the user actually placed the features.
  const stored = char.manifest?.landmarks;
  let lm = null;
  if (Array.isArray(stored) && stored.length === 478) {
    const cand = stored.map(([x, y]) => [x * CANVAS, y * CANVAS]);
    if (landmarksAgreeWithBoxes(cand, boxes)) lm = cand;
  }
  const realGeometry = !!lm;
  if (!lm) lm = landmarksFromBoxes(boxes[0], boxes[1], boxes[2], CANVAS, CANVAS);
  if (sizeScale !== 1) lm = lm.map(([x, y]) => [x * sizeScale, y * sizeScale]);

  const vid = new Map(FEATURE.map((i, k) => [i, k]));
  const verts = FEATURE.map((i) => [...lm[i]]);
  const borderSeen = new Set();
  for (let k = 0; k < 9; k++) {
    const t = k / 8;
    for (const p of [[t * (size - 1), 0], [t * (size - 1), size - 1],
                     [0, t * (size - 1)], [size - 1, t * (size - 1)]]) {
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
              jawBow: field(), jawSplit: field(), yaw: field(), pitch: field(),
              roll: field() };
  const add = (f, i, dx, dy) => { const v = vid.get(i); f[v * 2] += dx; f[v * 2 + 1] += dy; };
  const s = scale;

  for (const [f, top, bot, brow] of [[F.blinkL, L_EYE_TOP, L_EYE_BOT, L_BROW],
                                     [F.blinkR, R_EYE_TOP, R_EYE_BOT, R_BROW]]) {
    const ringPts = [...top, ...bot].map((i) => lm[i]);
    const cx = ringPts.reduce((a, p) => a + p[0], 0) / ringPts.length;
    const halfW = Math.max(1, (Math.max(...ringPts.map((p) => p[0])) - Math.min(...ringPts.map((p) => p[0]))) / 2);
    const targetY = bot.reduce((a, i) => a + lm[i][1], 0) / bot.length - 1 * s;
    const taper = (x) => Math.max(0.1, 1 - Math.min(1, Math.abs(x - cx) / halfW) ** 2);
    for (const i of top) add(f, i, 0, BLINK_MAX * taper(lm[i][0]) * (targetY - lm[i][1]));
    for (const i of bot) add(f, i, 0, -BLINK_MAX * taper(lm[i][0]) * 1.5 * s);
    // Brows dip with a blink only when we know where the brows really are —
    // a box rig's synthesized brow spot can sit on any stroke (head outline).
    if (realGeometry) for (const i of brow) add(f, i, 0, 4 * s);
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
  // Face-only roll: rigid small-angle rotation of every driven feature about
  // the oval center. d = theta*(vy, -vx) spins the same way as drawScene's
  // canvas roll (visually CCW for a positive angle).
  const rcx = FACE_OVAL.reduce((a, i) => a + lm[i][0], 0) / FACE_OVAL.length;
  const rcy = FACE_OVAL.reduce((a, i) => a + lm[i][1], 0) / FACE_OVAL.length;
  for (const i of FEATURE) {
    if (CHEEKS.includes(i)) continue; // free on desktop; IDW bake fills them below
    add(F.roll, i, MESH_ROLL_RAD * (lm[i][1] - rcy), -MESH_ROLL_RAD * (lm[i][0] - rcx));
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
  const out = newCanvas(size, size);
  return {
    neutral, verts, tris, scale,
    fields: F,
    colors: sampleColors(neutral, lm),
    // per-character mouth style wins over the engine default (single source of
    // truth shared with the sprite/derive pipeline)
    mouthFill: char.manifest?.mouthStyle?.fill ? hexToRgb(char.manifest.mouthStyle.fill) : MOUTH_FILL,
    ctx: out.getContext("2d"),
    ringIds: {
      sealL: [rings(L_EYE_TOP), rings(L_EYE_BOT)],
      sealR: [rings(R_EYE_TOP), rings(R_EYE_BOT)],
      lipTop: rings([...LIP_TOP, MOUTH_CORNERS[0]]),
      lipBot: rings([...LIP_BOT, MOUTH_CORNERS[1]]),
    },
    out,
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
    roll: clamp(ch.roll ?? 0, -1, 1),
  };
  const { verts, tris, fields, ctx } = rig;
  const wv = rig._warped;
  // Hoist the frame's active channels out of the per-vertex loop.
  const active = [];
  for (const name in fields) { if (k[name]) active.push([k[name], fields[name]]); }
  for (let i = 0; i < verts.length; i++) {
    let dx = 0, dy = 0;
    for (const [kv, f] of active) {
      dx += kv * f[i * 2];
      dy += kv * f[i * 2 + 1];
    }
    wv[i * 2] = verts[i][0] + dx;
    wv[i * 2 + 1] = verts[i][1] + dy;
  }

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.drawImage(rig.neutral, 0, 0);
  if (active.length) {
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
      fillRingPoly(ctx, poly, alphaMouth, rig.mouthFill, [...poly, poly[0]],
                   rig.colors.mouthInk, Math.max(2, 3 * rig.scale));
    }
  }
  return rig.out;
}
