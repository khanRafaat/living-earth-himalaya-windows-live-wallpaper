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

  /**
   * The clock the motion runs on: birds, falling leaves, the tree, the grass (state.time). Between frames that come
   * as often as they usually do it keeps real time, however far apart they are on a slow chip. A frame that comes
   * late (the PC or the graphics chip busy with other work) moves things on by little more than a usual frame, and a
   * pause by nothing at all. Otherwise everything that flies or falls jumped ahead across the gap, and a gap over 2 s
   * made the falling leaves start over: both looked like birds and leaves vanishing and appearing somewhere else.
   */
  class SceneClock {
    constructor(nowMs) {
      this.t = 0; // seconds of motion so far
      this._at = nowMs;
      this._usual = SceneClock.START_MS; // how far apart frames usually are, from the recent ones
    }

    /** The scene time for a frame drawn at nowMs (performance.now()), in seconds. */
    tick(nowMs) {
      const gap = Math.max(nowMs - this._at, 0);
      this._at = nowMs;
      const step = Math.min(gap, Math.max(SceneClock.MIN_CAP_MS, SceneClock.LATE * this._usual));
      // what was counted, so one stall hardly moves it, while a chip that is slow all the time soon sets it
      this._usual += (step - this._usual) * 0.2;
      this.t += step / 1000;
      return this.t;
    }

    /** Going on after a pause: the time away moves nothing. */
    resume(nowMs) {
      this._at = nowMs;
    }
  }
  SceneClock.START_MS = 50;
  SceneClock.MIN_CAP_MS = 200; // a frame may always move things on this far: a fifth of a second reads as a hitch, not a jump
  SceneClock.LATE = 2.5; // this many usual frames, and the rest of a gap is a hitch rather than a leap
  LE.SceneClock = SceneClock;
})();
