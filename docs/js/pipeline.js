// Pure signal-processing pipeline ported from app/main.py + app/sprite_backend.py.
// No DOM, no network — safe to unit-test in a browser or Node. Config keys are
// camelCase to match web/js/config.js (Python used snake_case).

// The channels the web loop actually renders (eyes, visemes). The python twin
// additionally smooths 13 brow/gaze channels for brow/pupil sprite overlays —
// web-onboarded characters always have browRange/pupilRange 0, so those
// channels are omitted here rather than smoothed for nothing every frame.
export const SMOOTH_KEYS = [
  "eyeBlinkLeft", "eyeBlinkRight", "jawOpen",
  "mouthSmileLeft", "mouthSmileRight", "mouthPucker", "mouthFunnel",
];

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
