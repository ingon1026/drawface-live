// Expression-triggered sticker effects — canvas-drawn shapes (no emoji font
// dependency) that spawn on strong smiles / surprise / kiss and float up over
// the character. Drawn on the output canvas after the character, so it never
// touches the sprite pipeline.

const TRIGGERS = [
  // kind -> test on smoothed blendshapes, threshold, spawn cooldown (ms)
  { kind: "star", test: (b) => (b.mouthSmileLeft + b.mouthSmileRight) / 2, on: 0.45, gap: 220 },
  { kind: "burst", test: (b) => b.jawOpen, on: 0.55, gap: 600 },
  { kind: "heart", test: (b) => b.mouthPucker, on: 0.55, gap: 260 },
];

function star(ctx, r) {
  ctx.beginPath();
  for (let i = 0; i < 8; i++) {
    const a = (Math.PI / 4) * i;
    const rad = i % 2 ? r * 0.42 : r;
    ctx[i ? "lineTo" : "moveTo"](Math.cos(a) * rad, Math.sin(a) * rad);
  }
  ctx.closePath();
  ctx.fillStyle = "#ffcf3f";
  ctx.fill();
}

function heart(ctx, r) {
  ctx.beginPath();
  ctx.moveTo(0, r * 0.35);
  ctx.bezierCurveTo(r, -r * 0.5, r * 0.5, -r, 0, -r * 0.35);
  ctx.bezierCurveTo(-r * 0.5, -r, -r, -r * 0.5, 0, r * 0.35);
  ctx.closePath();
  ctx.fillStyle = "#ff5c8a";
  ctx.fill();
}

function burst(ctx, r) {
  ctx.strokeStyle = "#ff8a3d";
  ctx.lineWidth = Math.max(2, r * 0.16);
  ctx.lineCap = "round";
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI / 3) * i;
    ctx.beginPath();
    ctx.moveTo(Math.cos(a) * r * 0.4, Math.sin(a) * r * 0.4);
    ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r);
    ctx.stroke();
  }
}

const SHAPES = { star, heart, burst };

export class StickerFx {
  constructor(canvasSize = 512) {
    this.size = canvasSize;
    this.particles = [];
    this.cooldown = {};
    this.seq = 0;
  }

  /** Spawn/age particles from the current smoothed blendshapes. */
  update(blend, now) {
    for (const t of TRIGGERS) {
      const v = t.test(blend);
      if (v >= t.on && now >= (this.cooldown[t.kind] ?? 0)) {
        this.cooldown[t.kind] = now + t.gap;
        const strength = Math.min(1, (v - t.on) / (1 - t.on));
        const count = 1 + Math.round(strength * 2);
        for (let i = 0; i < count; i++) {
          this.seq++;
          this.particles.push({
            x: this.size * (0.26 + 0.48 * ((this.seq * 0.618) % 1)),
            y: this.size * 0.34, kind: t.kind,
            vx: (((this.seq * 0.37) % 1) - 0.5) * 0.5,
            spin: (((this.seq * 0.29) % 1) - 0.5) * 0.02,
            born: now, life: 1100 + strength * 500, r: 13 + strength * 8,
          });
        }
      }
    }
    this.particles = this.particles.filter((p) => now - p.born < p.life);
  }

  /** Draw active particles onto ctx (rising + fading + spinning). */
  draw(ctx, now) {
    for (const p of this.particles) {
      const age = now - p.born;
      const t = age / p.life;                       // 0..1
      ctx.save();
      ctx.globalAlpha = Math.max(0, t < 0.15 ? t / 0.15 : 1 - (t - 0.15) / 0.85);
      ctx.translate(p.x + p.vx * age * 0.05, p.y - t * this.size * 0.22);
      ctx.rotate(p.spin * age);
      SHAPES[p.kind](ctx, p.r * (0.7 + 0.3 * t));
      ctx.restore();
    }
  }
}
