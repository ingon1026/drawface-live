// Runtime performance monitor for the live canvas. It measures the time spent
// in our own frame work (not time while a tab is backgrounded) and uses
// hysteresis, so one GC pause never makes quality visibly flicker.
export class RenderPerformance {
  constructor({ frameBudgetMs, degradeAfterMs, recoverAfterMs }, preference = "auto") {
    this.frameBudgetMs = frameBudgetMs;
    this.degradeAfterMs = degradeAfterMs;
    this.recoverAfterMs = recoverAfterMs;
    this.mode = "full";
    this.workMs = 0;
    this.slowSince = null;
    this.nextProbeAt = null;
    this.probing = false;
    this.setPreference(preference);
  }

  setPreference(preference) {
    this.preference = ["auto", "full", "economy"].includes(preference) ? preference : "auto";
    this.slowSince = null;
    this.nextProbeAt = null;
    this.probing = false;
    // Returning to auto starts a fresh high-quality measurement window. Keeping
    // an earlier forced economy mode here would leave it with no scheduled probe.
    this.mode = this.preference === "economy" ? "economy" : "full";
  }

  // In economy mode, periodically allow exactly one full-quality frame. The
  // result tells us whether CPU headroom really returned; simply measuring the
  // cheap sprite path would otherwise make a slow device oscillate forever.
  useEconomy(now) {
    if (this.preference === "economy") return true;
    if (this.preference === "full") return false;
    if (this.mode !== "economy") return false;
    if (this.nextProbeAt !== null && now >= this.nextProbeAt) {
      this.probing = true;
      return false;
    }
    return true;
  }

  record(now, workMs) {
    this.workMs = this.workMs ? this.workMs * 0.85 + workMs * 0.15 : workMs;
    if (this.preference !== "auto") return;
    // A probe must be judged on its own full-quality frame. The smoothed value
    // includes cheap economy frames and would incorrectly promote a slow device.
    const slow = (this.probing ? workMs : this.workMs) > this.frameBudgetMs;
    if (this.mode === "full") {
      this.slowSince = slow ? (this.slowSince ?? now) : null;
      if (this.slowSince !== null && now - this.slowSince >= this.degradeAfterMs) {
        this.mode = "economy";
        this.slowSince = null;
        this.nextProbeAt = now + this.recoverAfterMs;
      }
    } else if (this.probing) {
      this.probing = false;
      if (!slow) {
        this.mode = "full";
        this.nextProbeAt = null;
      } else {
        this.nextProbeAt = now + this.recoverAfterMs;
      }
    }
  }

  get economical() { return this.mode === "economy"; }

  label() {
    const policy = this.preference === "full" ? "always high quality"
      : this.preference === "economy" ? "always power saving"
        : this.economical ? "auto power saving" : "auto";
    return `${this.workMs.toFixed(0)}ms · ${policy}`;
  }
}
