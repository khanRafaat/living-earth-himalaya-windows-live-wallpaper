/*
 * Running without Lively: host/LivingEarthHost.exe writes host/state.js when the wallpaper should change
 * pace, or when a setting changes in its window. A script tag is the one thing a file:// page can re-read
 * from disk without a server or an open port.
 *
 *   live   full animation (the empty desktop is in front)
 *   rest   the scene every 2 s, fading smoothly between its pictures with the birds flying (the desktop is in front
 *          while the PC is busy, or has just been signed in to). With area: [x0, x1], an app is in front on one screen
 *          while another shows the desktop: only that part of the width (0 to 1) is drawn again, and the rest keeps its
 *          picture, so the free screen moves gently and the graphics chip does as little as it can
 *   still  no frames at all (an app is in front, locked, or paused from the tray)
 *
 * The second argument carries settings: { quality, road, traffic, birds, leaves, tree, mist, banners, demo, smoke, fires, lights, stars,
 * panel, corner, panelSize, place: { lat, lon, name } }.
 * They apply at once. Turning the road on or off shapes the mountains again, which takes a few minutes.
 *
 * Does nothing unless the page was opened with ?host=1, so Lively and browser testing are unaffected.
 */
(function () {
  'use strict';
  if (new URLSearchParams(window.location.search).get('host') !== '1') return;

  const POLL_MS = 250; // an app coming to the front stops the frames within a moment: the file is a few hundred bytes
  const SLOW_FRAME_MS = 2000;
  const SETTLE_MS = 6000; // run at full speed first, or the first picture would hold a half-formed sky
  const QUALITY = ['auto', 'eco', 'balanced', 'high', 'ultra']; // the order livelyPropertyListener expects
  const CORNER = ['right-bottom', 'right-top', 'left-bottom', 'left-top']; // the same
  const PANEL_SIZE = ['small', 'medium', 'large']; // the same
  const TRAFFIC = ['light', 'normal', 'busy']; // the same

  let wanted = 'live';
  let applied = 'live';
  let wantedArea = null; // rest only: [x0, x1]
  let appliedArea = '';
  let readyAt = 0;
  let options = null;
  let placeKey = '';

  window.leHostState = function (state, opts) {
    wanted = state;
    options = opts || null;
    const a = opts && opts.area;
    const ok = state === 'rest' && Array.isArray(a) && a.length === 2 && a.every((v) => typeof v === 'number' && v >= 0 && v <= 1) && a[1] > a[0];
    wantedArea = ok ? [a[0], a[1]] : null;
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
    if (!window.LE || !window.livelyPropertyListener) return;
    const c = LE.config;
    const q = options.quality;
    const i = QUALITY.indexOf(q);
    if (i >= 0 && c.render.quality !== q) window.livelyPropertyListener('quality', i);
    // Only on a change: the road starts the mountains over. Each switch: what it is now, and Lively's name for it.
    const switches = {
      road: [c.road, 'road'],
      birds: [c.birds, 'birds'],
      leaves: [c.leaves, 'leaves'],
      tree: [c.render.tree, 'tree'],
      mist: [c.mist, 'mist'],
      banners: [c.banners, 'banners'],
      demo: [c.demo, 'demo'],
      smoke: [c.smoke, 'smoke'],
      fires: [c.fires, 'fires'],
      lights: [c.lights, 'lights'],
      stars: [c.shootingStars, 'stars'],
      panel: [c.ui.showPanel, 'showPanel'],
    };
    for (const name in switches) {
      const on = options[name];
      const [now, lively] = switches[name];
      if (typeof on === 'boolean' && (now !== false) !== on) window.livelyPropertyListener(lively, on);
    }
    const corner = CORNER.indexOf(options.corner);
    if (corner >= 0 && c.ui.panelPosition !== options.corner) window.livelyPropertyListener('panelPosition', corner);
    const traffic = TRAFFIC.indexOf(options.traffic);
    if (traffic >= 0 && (c.traffic || 'normal') !== options.traffic) window.livelyPropertyListener('traffic', traffic);
    const size = PANEL_SIZE.indexOf(options.panelSize);
    if (size >= 0 && c.ui.panelSize !== options.panelSize) window.livelyPropertyListener('panelSize', size);
  }

  function apply() {
    applyOptions();
    if (!window.__leReady) return;
    const now = performance.now();
    if (!readyAt) readyAt = now;
    const areaKey = wantedArea ? wantedArea.join(',') : '';
    if (now - readyAt < SETTLE_MS || (wanted === applied && areaKey === appliedArea)) return;
    applied = wanted;
    appliedArea = areaKey;
    if (window.leSetArea) window.leSetArea(wantedArea);
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
