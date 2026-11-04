/*
 * Clock service — the single source of "now" for the scene.
 * Live mode returns the computer's real local time. Preview modes (fixed time,
 * time-lapse) exist only for testing and are clearly labelled in the panel.
 */
(function () {
  'use strict';
  const LE = (window.LE = window.LE || {});

  LE.clock = {
    _live: true,
    _speed: 1,
    _realAnchor: 0,
    _simAnchor: 0,

    configure({ time = null, date = null, timelapse = 0 } = {}) {
      const sim = new Date();
      if (date) {
        const [y, m, d] = String(date).split('-').map(Number);
        if (y && m && d) sim.setFullYear(y, m - 1, d);
      }
      if (time) {
        const [hh, mm] = String(time).split(':').map(Number);
        if (!isNaN(hh)) sim.setHours(hh, isNaN(mm) ? 0 : mm, 0, 0);
      }
      this._realAnchor = performance.now();
      this._simAnchor = sim.getTime();
      this._speed = timelapse > 0 ? timelapse : 1;
      this._live = !time && !date && !(timelapse > 0);
    },

    now() {
      if (this._live) return new Date();
      return new Date(this._simAnchor + (performance.now() - this._realAnchor) * this._speed);
    },

    isLive() {
      return this._live;
    },

    modeLabel() {
      if (this._live) return '';
      return this._speed > 1 ? `Time-lapse ×${Math.round(this._speed)}` : 'Preview time';
    },
  };
})();
