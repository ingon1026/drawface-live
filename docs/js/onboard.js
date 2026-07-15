// Port of app/onboard.py build_character: turns a fitted 512 drawing + eye/mouth
// coordinates into base + eye sprites and a proceduralMouth manifest. Geometry
// matches the python exactly so a web-onboarded character equals a CLI one.
import { CANVAS, DERIVE } from "./config.js";
import { newCanvas, snapToInk, inpaintRegion, inkColor, rad } from "./imageops.js";

/** Transparent 512 canvas with the closed-eye arc stroke (PIL arc 20..160, width 4). */
function drawClosedEye(cx, cy, eyeHalf, colorHex) {
  const c = newCanvas(CANVAS, CANVAS);
  const ctx = c.getContext("2d");
  ctx.strokeStyle = colorHex;
  ctx.lineWidth = 4;
  ctx.beginPath();
  // PIL bbox (cx-h, cy-0.6h, cx+h, cy+h) -> center (cx, cy+0.2h), radii (h, 0.8h).
  ctx.ellipse(cx, cy + 0.2 * eyeHalf, eyeHalf, 0.8 * eyeHalf, 0, rad(20), rad(160), false);
  ctx.stroke();
  return c;
}

/**
 * eyes = {L:[cx,cy], R:[cx,cy]} in 512-canvas px (snapped to ink here).
 * mouthBox = [x0,y0,x1,y1]. Returns {manifest, canvases} with canvases keyed by
 * sprite file name.
 */
export function buildCharacter(canvas512, name, eyes, eyeHalf, mouthBox) {
  const snapped = {};
  for (const side of Object.keys(eyes)) {
    const [cx, cy] = eyes[side];
    snapped[side] = snapToInk(canvas512, cx, cy, eyeHalf);
  }

  const base = newCanvas(CANVAS, CANVAS);
  const bctx = base.getContext("2d");
  bctx.drawImage(canvas512, 0, 0);

  const canvases = {};
  for (const side of Object.keys(snapped)) {
    const [cx, cy] = snapped[side];
    const box = [cx - eyeHalf, cy - eyeHalf, cx + eyeHalf, cy + eyeHalf];

    // open sprite: transparent 512 with the box region copied in place (crop is
    // [x0,x1) x [y0,y1), i.e. 2*eyeHalf square).
    const open = newCanvas(CANVAS, CANVAS);
    const patch = bctx.getImageData(box[0], box[1], box[2] - box[0], box[3] - box[1]);
    open.getContext("2d").putImageData(patch, box[0], box[1]);
    canvases[`eye_${side}_open.png`] = open;

    canvases[`eye_${side}_closed.png`] = drawClosedEye(cx, cy, eyeHalf, inkColor(base, box));

    // seamless erase (skin-tone fill + feathered edge) — the open sprite above
    // already captured the original pixels, so this only affects the base.
    inpaintRegion(base, box);
  }

  const line = inkColor(base, mouthBox);
  inpaintRegion(base, mouthBox);
  canvases["base.png"] = base;

  const mcx = Math.floor((mouthBox[0] + mouthBox[2]) / 2);
  const mcy = Math.floor((mouthBox[1] + mouthBox[3]) / 2);
  const halfW = Math.max(12, Math.floor((mouthBox[2] - mouthBox[0]) / 2));
  const manifest = {
    name,
    pupilRange: 0,
    browRange: 0,
    jawDrop: 6,
    mouthCenter: [mcx, mcy],
    proceduralMouth: true,
    mouthStyle: { ...DERIVE.defaultStyle, line, width: halfW },
  };

  return { manifest, canvases };
}
