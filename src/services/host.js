/*
 * Running without Lively: host/LivingEarthHost.exe writes host/state.js when the wallpaper should change
 * pace, or when a setting changes in its window. A script tag is the one thing a file:// page can re-read
 * from disk without a server or an open port.
 *
 *   live   full animation (the empty desktop is in front)
 *   rest   the scene every 2 s (you are working), fading smoothly between its pictures with the birds flying
 *   still  no frames at all (locked, or paused from the tray)
 *
 * The second argument carries settings: { quality, place: { lat, lon, name } }. They apply at once.
 *
 * Does nothing unless the page was opened with ?host=1, so Lively and browser testing are unaffected.
 */
(function () {
  'use strict';
  if (new URLSearchParams(window.location.search).get('host') !== '1') return;

  const POLL_MS = 1000;
  const SLOW_FRAME_MS = 2000;
  const SETTLE_MS = 6000; // run at full speed first, or the first picture would hold a half-formed sky
  const QUALITY = ['auto', 'eco', 'balanced', 'high', 'ultra']; // the order livelyPropertyListener expects

  let wanted = 'live';
  let applied = 'live';
  let readyAt = 0;
  let options = null;
  let placeKey = '';

  window.leHostState = function (state, opts) {
    wanted = state;
    options = opts || null;
  };

  function applyOptions() {
    if (!options) return;
    const p = options.place;
    if (p && window.leSetLocation) {
      const key = `${p.lat},${p.lon},${p.name}`;
      if (key !== placeKey) {
        placeKey = key;
        window.leSetLocation(p);
      }
    }
    const q = options.quality;
    const i = QUALITY.indexOf(q);
    if (i >= 0 && window.LE && LE.config.render.quality !== q && window.livelyPropertyListener) {
      window.livelyPropertyListener('quality', i);
    }
  }

  function apply() {
    applyOptions();
    if (!window.__leReady) return;
    const now = performance.now();
    if (!readyAt) readyAt = now;
    if (now - readyAt < SETTLE_MS || wanted === applied) return;
    applied = wanted;
    window.leSetSlowFrames(applied === 'rest' ? SLOW_FRAME_MS : 0);
    window.livelyWallpaperPlaybackChanged({ IsPaused: applied === 'still' });
  }

  function poll() {
    const s = document.createElement('script');
    s.src = `host/state.js?${Date.now()}`;
    s.onload = s.onerror = () => {
      s.remove();
      apply();
    };
    document.head.appendChild(s);
  }

  setInterval(poll, POLL_MS);
})();
