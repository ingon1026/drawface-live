// Pure signal-processing pipeline ported from app/main.py + app/sprite_backend.py.
// No DOM, no network — safe to unit-test in a browser or Node. Config keys are
// camelCase to match web/js/config.js (Python used snake_case).

// Same channels app/main.py smooths, in the same order.
export const SMOOTH_KEYS = [
  "eyeBlinkLeft", "eyeBlinkRight", "jawOpen",
  "mouthSmileLeft", "mouthSmileRight", "mouthPucker", "mouthFunnel",
  // brow offset (5) + gaze channels (8) — used only when the character enables them.
  "browInnerUp", "browDownLeft", "browDownRight", "browOuterUpLeft", "browOuterUpRight",
  "eyeLookInLeft", "eyeLookInRight", "eyeLookOutLeft", "eyeLookOutRight",
  "eyeLookUpLeft", "eyeLookUpRight", "eyeLookDownLeft", "eyeLookDownRight",
];

// Python's round() is banker's rounding (half-to-even); gaze_to_shift used it, so
// match it here to stay bit-for-bit faithful at exact .5 boundaries.
function pyRound(x) {
  const f = Math.floor(x);
  const diff = x - f;
  if (diff < 0.5) return f;
  if (diff > 0.5) return f + 1;
  return f % 2 === 0 ? f : f + 1; // exactly .5 -> nearest even
}

function median(values) {
  const s = [...values].sort((a, b) => a - b);
  const n = s.length;
  const mid = n >> 1;
  return n % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export class Ema {
  constructor(alpha) {
    this.alpha = alpha;
    this.value = null;
  }
  update(x) {
    this.value = this.value === null ? x : this.alpha * x + (1 - this.alpha) * this.value;
    return this.value;
  }
}

// Two-threshold open/closed switch to prevent blink flicker (closeTh > openTh).
export class Hysteresis {
  constructor(closeTh, openTh) {
    if (!(closeTh > openTh)) throw new Error(`closeTh must exceed openTh (${closeTh} <= ${openTh})`);
    this.closeTh = closeTh;
    this.openTh = openTh;
    this.closed = false;
  }
  update(value) {
    if (!this.closed && value >= this.closeTh) this.closed = true;
    else if (this.closed && value <= this.openTh) this.closed = false;
    return this.closed;
  }
}

// open / half / closed with independent hysteresis bands (no flicker at either edge).
export class TriStateEye {
  constructor(eyesCfg) {
    this.full = new Hysteresis(eyesCfg.closeThreshold, eyesCfg.openThreshold);
    this.half = new Hysteresis(eyesCfg.halfCloseThreshold, eyesCfg.halfOpenThreshold);
  }
  update(value) {
    const fullClosed = this.full.update(value);
    const halfClosed = this.half.update(value);
    return fullClosed ? "closed" : (halfClosed ? "half" : "open");
  }
}

// Neutral-pose baseline: calibrated = max(0, raw - neutral) / max(0.2, 1 - neutral).
export class Calibration {
  constructor(nFrames) {
    this.nFrames = nFrames;
    this.samples = [];
    this.neutral = {};
  }
  get active() {
    return this.samples.length < this.nFrames;
  }
  feed(blend) {
    this.samples.push(blend);
    if (!this.active) {
      for (const k of SMOOTH_KEYS) {
        this.neutral[k] = median(this.samples.map((s) => s[k] ?? 0.0));
      }
    }
  }
  apply(blend) {
    const out = {};
    for (const k of SMOOTH_KEYS) {
      const n = this.neutral[k] ?? 0.0;
      out[k] = Math.max(0.0, (blend[k] ?? 0.0) - n) / Math.max(0.2, 1.0 - n);
    }
    return out;
  }
  restart() {
    this.samples = [];
    this.neutral = {};
  }
}

// Map the USER's anatomical eye ('left'/'right') to a sprite side ('L'/'R').
// mirror=true (default): mirror-like control — user's left eye drives viewer-left.
export function eyeKeyForUserSide(side, mirror) {
  if (side !== "left" && side !== "right") {
    throw new Error(`side must be 'left' or 'right', got ${JSON.stringify(side)}`);
  }
  const same = side === "left" ? "L" : "R";
  const swap = side === "left" ? "R" : "L";
  return mirror ? same : swap;
}

// Map user-perspective gaze (each in [-1, 1]) to a pupil pixel shift [dx, dy].
// Mirror-like: user looks THEIR left -> pupils move viewer-left (-x).
// Vertical travel is naturally shorter than horizontal, hence the 0.6 factor.
export function gazeToShift(gazeLeft, gazeUp, rangePx, mirror) {
  const sign = mirror ? -1 : 1;
  const dx = pyRound(sign * gazeLeft * rangePx);
  const dy = pyRound(-gazeUp * rangePx * 0.6);
  return [
    Math.max(-rangePx, Math.min(rangePx, dx)),
    Math.max(-rangePx, Math.min(rangePx, dy)),
  ];
}

// Select a mouth sprite key from calibrated blendshape values. Ladder mirrors
// app/sprite_backend.pick_mouth; cfg keys are camelCase (config.js CONFIG.mouth).
export function pickMouth(blend, mouthCfg) {
  const jaw = blend.jawOpen ?? 0.0;
  const pucker = blend.mouthPucker ?? 0.0;
  const funnel = blend.mouthFunnel ?? 0.0;
  const smile = ((blend.mouthSmileLeft ?? 0.0) + (blend.mouthSmileRight ?? 0.0)) / 2;

  if (jaw < mouthCfg.jawClosed) {
    if (smile >= mouthCfg.smileThreshold) return "smile"; // resolves to closed overlay if absent
    return "closed";
  }
  if (pucker >= mouthCfg.puckerThreshold) return jaw >= mouthCfg.jawMid ? "O" : "U";
  if (funnel >= mouthCfg.funnelThreshold) return "O";
  if (jaw >= mouthCfg.jawLarge) return "A";
  if (jaw >= mouthCfg.jawMid) return "E";
  return "I";
}
