// Mirror of configs/app.yaml — keep thresholds in sync when tuning.
export const CONFIG = {
  camera: { width: 640, height: 480 },
  control: { mirror: true },
  smoothing: { blendAlpha: 0.45, blinkAlpha: 0.70, headAlpha: 0.30 },
  eyes: {
    closeThreshold: 0.38, openThreshold: 0.25,
    halfCloseThreshold: 0.20, halfOpenThreshold: 0.12,
  },
  mouth: {
    jawClosed: 0.06, jawMid: 0.16, jawLarge: 0.32,
    puckerThreshold: 0.40, funnelThreshold: 0.35, smileThreshold: 0.30,
  },
  head: { yawGainPx: -1.6, pitchGainPx: 1.2, rollGain: 1.0, maxShiftPx: 48, maxRollDeg: 20 },
  lostFace: { holdMs: 300, decayMs: 600 },
  calibration: { frames: 30 },
  warp: { blinkGain: 2.0, smileGain: 2.0, jawGain: 1.6, headParallax: 1.0 },
};

export const CANVAS = 512;

// Sprite derivation parameters (mirror of scripts/derive_sprites.py)
export const DERIVE = {
  squash: 0.45,        // half-eye: kept fraction of eye height
  smileAmpFrac: 0.10,  // smile corner lift as fraction of mouth width
  fillDarken: 0.72,    // viseme interior darkening
  visemes: {
    A: { drop: 0.62, wx: 0.85, teeth: 0.00, tongue: 0.35 },
    E: { drop: 0.30, wx: 1.10, teeth: 0.22, tongue: 0.00 },
    I: { drop: 0.15, wx: 1.05, teeth: 0.30, tongue: 0.00 },
    O: { drop: 0.45, wx: 0.70, teeth: 0.00, tongue: 0.30 },
    U: { drop: 0.26, wx: 0.55, teeth: 0.00, tongue: 0.00 },
  },
  defaultStyle: { line: "#2b2b2b", fill: "#8a3535", tongue: "#d97b7b", teeth: "#ffffff" },
};
