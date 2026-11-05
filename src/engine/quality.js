/*
 * Quality levels and the automatic governor.
 * "Auto" starts at Balanced and drops a level when frames arrive late for a few seconds.
 * It climbs back when GPU timer queries prove there is headroom. Without a timer it
 * retries the default level after several calm minutes.
 */
(function () {
  'use strict';
  const LE = (window.LE = window.LE || {});

  LE.QUALITY_LEVELS = [
    // cloudSteps search for a cloud, cloudFine march through its visible surface. Clouds move far less
    // than a pixel per frame, so volEvery above 1 saves GPU time without any visible cost.
    // treeHz: how often the tree in the wind is drawn anew. Its leaves move at 1 to 2 cycles a second.
    { name: 'eco', volScale: 0.3, cloudSteps: 10, cloudFine: 5, lightSteps: 2, mistSteps: 3, volEvery: 3, volBlend: 0.25, rainLayers: 2, treeHz: 15 },
    { name: 'balanced', volScale: 0.4, cloudSteps: 14, cloudFine: 7, lightSteps: 2, mistSteps: 4, volEvery: 2, volBlend: 0.2, rainLayers: 3, treeHz: 24 },
    { name: 'high', volScale: 0.5, cloudSteps: 18, cloudFine: 9, lightSteps: 3, mistSteps: 5, volEvery: 2, volBlend: 0.16, rainLayers: 3, treeHz: 30 },
    { name: 'ultra', volScale: 0.5, cloudSteps: 24, cloudFine: 14, lightSteps: 3, mistSteps: 8, volEvery: 1, volBlend: 0.1, rainLayers: 4, treeHz: 60 },
  ];
  const INDEX = { eco: 0, balanced: 1, high: 2, ultra: 3 };
  const RETRY_MS = 5 * 60e3;
  const RETRY_MAX_MS = 40 * 60e3;

  class QualityGovernor {
    constructor(renderer, mode) {
      this.renderer = renderer;
      this.setMode(mode);
    }

    setMode(mode) {
      this.mode = INDEX[mode] !== undefined ? mode : 'auto';
      this.level = this.mode === 'auto' ? 1 : INDEX[this.mode];
      this._late = 0;
      this._good = 0;
      this._lastChange = performance.now();
      this._retryMs = RETRY_MS;
      this._climbedAt = -Infinity;
      this.renderer.setQuality(LE.QUALITY_LEVELS[this.level]);
    }

    /** Called once per rendered frame with the measured interval, the target and, if known, the GPU time. */
    sample(intervalMs, targetMs, gpuMs) {
      if (this.mode !== 'auto') return;
      const now = performance.now();
      if (now - this._lastChange < 4000) return;
      if (intervalMs > targetMs * 1.3) this._late++;
      else this._late = Math.max(0, this._late - 1);
      if (this._late > 45 && this.level > 0) return this._change(-1, now);

      if (gpuMs > 0) {
        if (gpuMs < targetMs * 0.35) this._good++;
        else this._good = 0;
        if (this._good > 600 && this.level < 2 && now - this._lastChange > 60000) this._change(+1, now);
      } else if (this.level < 1 && this._late === 0 && now - this._lastChange > this._retryMs) {
        // No GPU timer here: after a calm spell, try the default level again
        this._change(+1, now);
      }
    }

    _change(d, now) {
      if (d > 0) this._climbedAt = now;
      // a climb that failed quickly means the GPU is really busy, so wait longer before the next try
      else if (now - this._climbedAt < 120000) this._retryMs = Math.min(this._retryMs * 2, RETRY_MAX_MS);
      this.level = Math.max(0, Math.min(3, this.level + d));
      this._late = 0;
      this._good = 0;
      this._lastChange = now;
      this.renderer.setQuality(LE.QUALITY_LEVELS[this.level]);
    }

    name() {
      return LE.QUALITY_LEVELS[this.level].name + (this.mode === 'auto' ? ' (auto)' : '');
    }
  }

  LE.QualityGovernor = QualityGovernor;
})();
