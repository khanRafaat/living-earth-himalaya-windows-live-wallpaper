/*
 * Living Earth Himalaya — application entry.
 * Wires services (clock, location, weather, astronomy) → environment → renderer,
 * runs a frame-capped loop, and integrates with Lively Wallpaper.
 */
(function () {
  'use strict';
  const LE = window.LE;
  const cfg = LE.config;

  const canvas = document.getElementById('scene');
  const veil = document.getElementById('veil');
  const debugEl = document.getElementById('debug');

  LE.clock.configure(cfg.overrides);

  const env = new LE.Environment(cfg);
  const weather = new LE.WeatherService(cfg.weather);
  const overlay = new LE.Overlay(document.getElementById('panel'), cfg);
  const life = new LE.Life();
  const demo = new LE.Demo(); // a year in two minutes (src/services/demo.js)
  let renderer = null;
  let governor = null;
  let location = { lat: cfg.location.lat, lon: cfg.location.lon, name: cfg.location.name, source: 'default' };
  let revealed = false; // the first picture has been shown
  let sceneReady = false;

  // ---------------------------------------------------------------- weather → environment
  let windOverride = null; // the wind test's values (?windtest=1)
  let testWeather; // what the test panel asks for (?debug=1). Undefined: nothing. Null: as if there were no data
  function weatherRecord() {
    if (demo.on && demo.weather()) return { rec: demo.weather(), source: 'preview' };
    if (testWeather !== undefined) return { rec: testWeather, source: testWeather ? 'preview' : 'none' };
    const ov = cfg.overrides.weather;
    if (ov && LE.weatherPresets[ov]) {
      const rec = LE.weatherPresets[ov];
      return { rec: windOverride ? { ...rec, ...windOverride } : rec, source: 'preview' };
    }
    const cur = weather.current(Date.now());
    if (windOverride) return { rec: { ...(cur || LE.weatherPresets.partly), ...windOverride }, source: 'preview' };
    return cur ? { rec: cur, source: cur.source } : { rec: null, source: 'none' };
  }
  const windTest = cfg.windTest
    ? new LE.WindTest(
        () => {
          const cur = weather.current(Date.now());
          return cur && cur.windSpeed != null ? cur : null;
        },
        (v) => {
          windOverride = v && { windSpeed: v.speed, gusts: v.gust, windDir: v.dir };
          const { rec, source } = weatherRecord();
          env.setWeather(rec, source);
          // Straight to these values, not the slow change real weather makes
          env.w = null;
          env.treeAir = null;
        }
      )
    : null;
  function pushWeather() {
    const { rec, source } = weatherRecord();
    env.setWeather(rec, source);
    // Nothing is on screen yet, so start from this weather instead of easing into it. From here on the
    // sky moves only when the data changes.
    if (rec && !revealed) env.w = null;
    if (rec) reveal();
  }
  weather.onUpdate(pushWeather);

  // The start-up screen stays up until the current weather has arrived, so the first sky is the real one.
  function reveal(force) {
    if (revealed || !sceneReady || !(force || weatherRecord().rec)) return;
    revealed = true;
    // Over the still, the scene's own fade from black (2.5 s, while its sky forms) happens under it, so the still
    // dissolves straight into the finished scene, never through dark
    if (cfg.startStill) setTimeout(() => showVeil(false), 3000);
    else showVeil(false);
    window.__leReady = true;
  }

  function statusText() {
    if (demo.on) return 'Demo · a year in two minutes';
    const { source } = weatherRecord();
    const parts = [];
    const mode = LE.clock.modeLabel();
    if (mode) parts.push(mode);
    if (source === 'preview') {
      parts.push(`Weather preview: ${cfg.overrides.weather || 'test values'}`);
    } else if (source === 'none') {
      parts.push(weather.status === 'offline' ? 'Offline · no cached weather' : 'Waiting for weather…');
    } else {
      const mins = Math.round(weather.ageMs() / 60e3);
      const age = mins < 1 ? 'just now' : mins < 60 ? `${mins} min ago` : `${Math.round(mins / 60)} h ago`;
      if (source === 'forecast') parts.push(`Offline · using forecast (${age})`);
      else if (weather.status === 'offline' || weather.status === 'error') parts.push(`Offline · last update ${age}`);
      else parts.push(`Live · updated ${age}`);
    }
    parts.push(`Sky mood synced to ${location.name}`);
    return parts.join(' · ');
  }

  // ---------------------------------------------------------------- sizing
  function targetSize() {
    const dpr = window.devicePixelRatio || 1;
    const s = Math.min(1, Math.max(0.4, cfg.render.renderScale));
    const w = window.innerWidth * dpr * s;
    const h = window.innerHeight * dpr * s;
    const fit = Math.min(1, Math.sqrt(cfg.render.maxPixels / Math.max(1, w * h)));
    return [Math.max(64, Math.round(w * fit)), Math.max(32, Math.round(h * fit))];
  }
  let resizeTimer = 0;
  function onResize() {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      layoutVeil();
      if (!renderer) return;
      const [w, h] = targetSize();
      if (w !== renderer.w || h !== renderer.h) {
        showVeil(true);
        renderer.resize(w, h);
      }
    }, 350);
  }
  window.addEventListener('resize', onResize);

  // ---------------------------------------------------------------- veil
  function showVeil(on) {
    veil.classList.toggle('hidden', !on);
  }
  // Started by the Windows app: the still for this time of day at once, with a small note at the bottom while the
  // scene is made, and then the live scene dissolves in over it
  if (cfg.startStill) {
    veil.style.backgroundImage = `url("host/stills/${cfg.startStill}.jpg")`;
    veil.classList.add('still');
    veil.querySelectorAll('.veil-title').forEach((n) => (n.textContent = 'Making the wallpaper live'));
  }
  // Lively "Span" puts one window across both monitors, so a single centred card would be cut
  // in half by the bezel. When the window is that wide, show a copy of the card on each screen.
  function layoutVeil() {
    const span = window.innerWidth / Math.max(1, window.innerHeight) > 2.5;
    veil.classList.toggle('span', span);
    if (span && veil.querySelectorAll('.veil-inner').length < 2) {
      const copy = veil.querySelector('.veil-inner').cloneNode(true);
      copy.querySelectorAll('[id]').forEach((n) => n.removeAttribute('id'));
      veil.appendChild(copy);
    }
  }
  layoutVeil();
  function setVeilText(text) {
    veil.querySelectorAll('.veil-sub').forEach((n) => (n.textContent = text));
  }
  function onRendererStatus(status, progress) {
    const pct = Math.round(progress * 100);
    veil.querySelectorAll('.veil-bar i').forEach((n) => (n.style.width = `${pct}%`));
    // A number that keeps moving tells a slow first start from a stuck one
    if (status === 'compiling') {
      setVeilText('Preparing the renderer… the first start can take a few minutes');
      showVeil(true);
    } else if (status === 'baking') {
      setVeilText(`Shaping the mountains… ${pct}%`);
      if (progress === 0) showVeil(true); // e.g. a new landscape variation was chosen
    }
    else if (status === 'shadow') setVeilText(`Casting the first light… ${pct}%`);
    else if (status === 'running') {
      sceneReady = true;
      if (revealed) {
        showVeil(false); // back from a resize or a graphics reset
      } else {
        setVeilText('Loading the current weather…');
        reveal();
        // Offline: don't hold the wallpaper back for ever. The panel says weather is missing.
        setTimeout(() => reveal(true), cfg.weather.startWaitMs);
      }
    }
  }
  function fatal(err) {
    console.error(err);
    veil.classList.remove('hidden');
    veil.classList.add('error');
    setVeilText((err && err.message) || String(err));
  }

  // ---------------------------------------------------------------- loop
  let paused = false;
  let pausedByLively = false;
  let pausedByVisibility = false;
  let pausedPanelTimer = 0;
  let rafId = 0;
  let slowMs = 0; // slow mode: milliseconds between scenes (0 = off)
  let restMs = 0; // what the Windows app asked for, when the PC is busy with other work
  let restArea = null; // ...and while you work on another screen, the part of the width that shows the desktop
  let slowTimer = 0;
  let fadeRaf = 0;
  let fadeTimer = 0;
  let nextFade = 0; // when slow mode may send its next frame
  const FADE_FPS = 10; // enough for a slow dissolve. Birds on screen raise it to calmFps
  let lastFrame = 0;
  let lastReal = performance.now();
  let lastPanel = 0;
  // The motion's own time (state.time): real time between frames, but a late frame or a pause never makes a leap
  const sceneClock = new LE.SceneClock(performance.now());
  let lifeAt = 0; // the scene time life was last moved on to
  let fpsCount = 0;
  let fpsAt = performance.now();
  let fps = 0;
  let lifeSeeded = false;
  let lastState = null;
  let lastBusy = -1e9;
  let lastFast = -1e9;
  let targetFps = cfg.render.fpsCap;

  /**
   * Smart frame rate. Full speed while something fast is on screen (birds, rain, snow, lightning,
   * meteors, satellites, the time-lapse demo). Otherwise clouds, mist and light only drift
   * slowly, so calmFps looks the same and costs about a third less GPU. Back to calm after 3 s.
   */
  function pickFps(now) {
    const cap = cfg.render.fpsCap;
    if (!cfg.render.smartFps || !lastState || renderer.status !== 'running') return cap;
    const w = lastState.weather;
    const lifeOn = cfg.life !== false;
    const busy =
      w.rain > 0.003 || w.snow > 0.003 || w.flash > 0.01 || cfg.overrides.timelapse > 0 || demo.on ||
      (lifeOn && (life.raptors.length > 0 || !!life.flock || !!life.geese || life.meteors.length > 0 || life.sats.length > 0));
    if (busy) lastBusy = now;
    return now - lastBusy < 3000 ? cap : Math.min(cap, cfg.render.calmFps);
  }

  /**
   * The land and sky change slowly, so a new scene every half a second, faded from one to the next, looks the same
   * and takes far less of the GPU. The tree, the birds and falling rain or snow keep moving on top at the full rate.
   * Only lightning needs every frame drawn: it lights the whole scene for a moment.
   */
  function calmScene(now) {
    if (!cfg.render.smartFps || !cfg.render.calmSceneMs || !lastState || renderer.status !== 'running') return 0;
    const w = lastState.weather;
    // At the full rate while the picture fades in and just after: the sky forms in those seconds
    if (renderer._fade < 1 || w.flash > 0.01 || cfg.overrides.timelapse > 0 || demo.on) lastFast = now;
    return now - lastFast < 3000 ? 0 : cfg.render.calmSceneMs;
  }

  function stepLife(state) {
    life.update(Math.min(Math.max(state.time - lifeAt, 0), 120), state, renderer.viewInfo());
    lifeAt = state.time;
  }

  // Slow mode between scenes: a fade between two finished pictures, the birds and the tree, which costs a small
  // part of drawing the scene. Clouds drift and the tree moves smoothly while the GPU stays free for other work.
  function fadeFrame(afterScene) {
    stopFade();
    if (!slowMs || paused || !lastState || renderer.status !== 'running') return;
    // While a frame is on the GPU, look again at the next refresh: gpuBusyMs comes from when it is seen to have finished
    let wait = 0;
    if (afterScene === true || renderer.frameDone()) {
      const now = performance.now();
      // Right after a scene it can't wait: that frame has neither birds nor the tree until this one adds them
      if (afterScene === true || now >= nextFade) {
        lastState.time = sceneClock.tick(now);
        stepLife(lastState);
        if (!renderer.drawFade(Math.min((now - renderer.pictureAt) / slowMs, 1), lastState)) return;
        const w = lastState.weather;
        const moving = life.movers > 0 || renderer.foregroundMoving() || w.rain > 0.003 || w.snow > 0.003;
        let rate = moving ? (restMs ? cfg.render.calmFps : cfg.render.fpsCap) : renderer.grassMoving() ? cfg.render.calmFps : FADE_FPS;
        // While you work on the other screen every fade still covers the whole width, so they come at the dissolve's own
        // rate: at 20 a second the free screen cost about as much as the old rest that made the desktop stutter
        if (restMs && restArea) rate = Math.min(rate, FADE_FPS);
        // A slow chip gets fewer frames, and never more than its share of the GPU
        nextFade = now + Math.max(1000 / rate, renderer.gpuBusyMs / cfg.render.maxGpuShare);
      } else {
        wait = nextFade - now - 4;
      }
    }
    fadeTimer = setTimeout(() => {
      fadeRaf = requestAnimationFrame(fadeFrame);
    }, Math.max(wait, 0));
  }
  function stopFade() {
    cancelAnimationFrame(fadeRaf);
    clearTimeout(fadeTimer);
  }

  // Start-up and context-loss work still run at full speed.
  function scheduleFrame() {
    if (slowMs && renderer && renderer.status === 'running') {
      slowTimer = setTimeout(() => {
        rafId = requestAnimationFrame(frame);
      }, slowMs);
    } else {
      rafId = requestAnimationFrame(frame);
    }
  }

  function frame(ts) {
    // Slow mode has few scenes to draw, so it waits for the GPU rather than missing its turn
    if (slowMs && renderer && renderer.status === 'running' && !renderer.frameDone()) {
      rafId = requestAnimationFrame(frame);
      return;
    }
    scheduleFrame();
    if (!renderer) return;
    // The last frame is still on the GPU: add nothing to the queue, however late this one runs (see frameDone)
    if (!renderer.frameDone()) return;
    targetFps = pickFps(ts);
    if (!restMs) {
      const calm = calmScene(ts);
      if (calm !== slowMs) {
        setSlowFrames(calm);
        return;
      }
    }
    // Its last picture isn't finished: the fades draw it, so keep them going (a pause stops them)
    if (slowMs && renderer.status === 'running' && renderer.pictureBusy()) {
      fadeFrame();
      return;
    }
    const interval = 1000 / Math.max(5, targetFps);
    const baking = renderer.status !== 'running';
    // A frame that takes longer than its slot slows the frame rate, instead of taking the whole GPU
    const spaced = Math.max(interval, renderer.gpuBusyMs / cfg.render.maxGpuShare);
    if (!baking && !slowMs && ts - lastFrame < spaced - 1.5) return;
    const measured = ts - lastFrame;
    lastFrame = ts;

    const nowReal = performance.now();
    // Environment.update makes the weather jump after a gap over 30 s, so slow mode stays under that
    const dt = Math.min((nowReal - lastReal) / 1000, slowMs ? 25 : 120);
    lastReal = nowReal;
    const timeSec = sceneClock.tick(nowReal);
    // the demo, on or off as asked, once the scene is up; while it plays it says what time and weather it is
    if (renderer.status === 'running' && !!cfg.demo !== demo.on) setDemo(!!cfg.demo);
    const d = demo.on ? stepDemo(nowReal) : null;
    const now = d ? d.now : LE.clock.now();
    const state = env.update(now, dt, timeSec);
    if (d && d.changed) {
      // a new month begins as wet, or with as much fresh snow, as it should (straight into its weather above)
      env.wet = d.wet;
      env.freshSnow = d.snow;
    }
    lastState = state;
    if (renderer.status === 'running') {
      const view = renderer.viewInfo();
      if (!lifeSeeded) {
        lifeSeeded = true;
        life.setSmokeSources(renderer.smokeSources);
        life.setForestSources(renderer.forestSources);
        life.setRoad(renderer.road);
        if (cfg.testMode && cfg.lifeTest) life.seedForTest(state, view);
      }
      life.enabled = cfg.life !== false;
      life.birds = cfg.birds !== false;
      life.mist = cfg.mist !== false;
      life.villageSmoke = cfg.smoke !== false;
      life.fires = cfg.fires !== false;
      life.shootingStars = cfg.shootingStars !== false;
      life.traffic = demo.on ? 'busy' : cfg.traffic || 'normal'; // the demo shows a busy road, without touching the setting
      stepLife(state);
      if (d) for (const k of d.summons) life.summon(k);
    } else {
      lifeAt = timeSec;
    }
    if (restMs) state.weather.flash = 0; // a lightning flash would stay on screen until the next frame
    renderer.setSlowMode(!!slowMs, !!restMs);
    renderer.setArea(restMs ? restArea : null);
    const drew = renderer.render(state, dt);

    if (drew && slowMs) fadeFrame(true);
    if (drew) {
      if (!slowMs) governor.sample(measured, interval, renderer.gpuFrameMs);
      else if (!restMs) governor.sample(interval, interval, 0); // on time: quality lowered in a storm can come back
      fpsCount++;
    }
    if (nowReal - fpsAt > 1000) {
      fps = (fpsCount * 1000) / (nowReal - fpsAt);
      fpsCount = 0;
      fpsAt = nowReal;
    }
    if (nowReal - lastPanel > 1000) {
      lastPanel = nowReal;
      const { rec } = weatherRecord();
      overlay.update(now, state, rec, { locationName: location.name, status: statusText() });
      if (windTest) windTest.update(state, renderer.fg ? renderer.fg.treeWind.lean[0] : 0);
      if (cfg.debug) {
        debugEl.style.display = 'block';
        const a = state.astro;
        const r = rec || {};
        const wind = (speed, dir) => (speed == null ? '—' : `${Math.round(speed)} km/h ${Math.round(dir ?? 0)}°`);
        const fetched = weather.data ? `${Math.round(weather.ageMs() / 60e3)} min ago` : 'not yet';
        debugEl.textContent =
          `${fps.toFixed(1)} fps (target ${targetFps}${cfg.render.smartFps ? ', smart' : ''}) · gpu ${renderer.gpuBusyMs.toFixed(0)} ms a frame · ${governor.name()} · ${renderer.w}×${renderer.h} · vol ${renderer.vw}×${renderer.vh}\n` +
          `sun ${a.sunAltDeg.toFixed(2)}° az ${a.sunAzDeg.toFixed(1)}° · moon ${a.moonAltDeg.toFixed(1)}° ${Math.round(a.moonFraction * 100)}%\n` +
          `exposure ${state.exposure.toExponential(2)} · deck cover ${state.weather.coverage.toFixed(2)} rain ${state.weather.rain.toFixed(2)} mist ${state.weather.mist.toFixed(2)} fog ${state.weather.fog.toFixed(2)} haze ${state.weather.haze.toFixed(2)}\n` +
          `weather fetched ${fetched} · wind 10 m ${wind(r.windSpeed, r.windDir)} · 850 hPa ${wind(r.wind850, r.dir850)} · 700 hPa ${wind(r.wind700, r.dir700)} · 300 hPa ${wind(r.wind300, r.dir300)}\n` +
          `life: ${life.raptors.length} raptors · flock ${life.flock ? life.flock.birds.length : 0} · geese ${life.geese ? life.geese.birds.length : 0} · smoke ${life.smoke.length}/${life.smokeSources.length} · meteors ${life.meteors.length}${life.activeShower ? ' (' + life.activeShower + ')' : ''}\n` +
          `${renderer.gpuInfo()}`;
      }
    }
  }

  // ---------------------------------------------------------------- the demo
  // A year in two minutes, over and over. While it plays, the weather changes and the land wets and whitens quickly,
  // clouds race as in a time-lapse and the road is busy; turned off, everything is as it was and the real weather and
  // time come back at once.
  const demoDip = document.getElementById('demo-dip');
  const demoCaption = document.getElementById('demo-caption');
  const demoKept = {};
  function setDemo(on) {
    if (on === demo.on) return;
    if (on) {
      demoKept.trans = cfg.atmosphere.transitionSeconds;
      demoKept.clouds = cfg.atmosphere.cloudSpeed;
      cfg.atmosphere.transitionSeconds = 4; // each month's weather forms in its few seconds
      cfg.atmosphere.cloudSpeed = 8;
      env.pace = 120;
      life.pace = 30; // smoke and mist come and go within a month
      demo.start(performance.now());
    } else {
      demo.stop();
      cfg.atmosphere.transitionSeconds = demoKept.trans;
      cfg.atmosphere.cloudSpeed = demoKept.clouds;
      env.pace = 1;
      life.pace = 1;
      env.wet = 0;
      env.freshSnow = 0;
      env.w = null; // straight back to the real weather
      pushWeather();
      demoDip.style.opacity = '0';
      demoCaption.classList.remove('on');
    }
    if (renderer) {
      renderer._adaptReset = true;
      renderer._volWarm = 0;
    }
  }
  function stepDemo(nowReal) {
    const d = demo.step(nowReal);
    if (d.changed || d.weatherChanged) env.setWeather(d.weather, 'preview');
    if (d.changed) {
      env.w = null; // this month's weather at once: the dip hides the change
      renderer._adaptReset = true;
      renderer._volWarm = 0;
      demoCaption.querySelector('.demo-month').textContent = d.caption;
      demoCaption.querySelector('.demo-line').textContent = d.line;
      demoCaption.classList.toggle('low', cfg.ui.panelPosition === 'left-top');
    }
    // the month's name shows for the first part of it
    demoCaption.classList.toggle('on', d.dip < 0.5 && d.share < 0.7);
    const dark = (d.dip * 0.94).toFixed(2);
    if (demoDip.style.opacity !== dark) demoDip.style.opacity = dark;
    return d;
  }

  // Lively and page visibility pause independently, and a resume needs both to agree: otherwise a
  // visibility change could wake a wallpaper Lively has paused. While paused nothing is scheduled
  // for the GPU; a light timer keeps the panel's clock and weather current over the frozen frame.
  function updateIfPaused() {
    if (!lastState || !cfg.ui.showPanel || document.hidden) return;
    overlay.update(LE.clock.now(), lastState, weatherRecord().rec, { locationName: location.name, status: statusText() });
  }
  function applyPause() {
    const p = pausedByLively || pausedByVisibility;
    if (p === paused) return;
    paused = p;
    if (p) {
      cancelAnimationFrame(rafId);
      clearTimeout(slowTimer);
      stopFade();
      pausedPanelTimer = setInterval(updateIfPaused, 5000);
    } else {
      clearInterval(pausedPanelTimer);
      lastReal = performance.now();
      // the birds and leaves go on from where the held picture shows them; the sun and moon from where they are now
      sceneClock.resume(lastReal);
      env.refreshSky();
      if (renderer) {
        renderer.refreshSky();
        renderer.forgetFrame();
        // pictures kept from before the pause are old: the next scene is drawn whole
        renderer.forgetPictures();
      }
      lastFrame = 0;
      rafId = requestAnimationFrame(frame);
    }
  }
  document.addEventListener('visibilitychange', () => {
    pausedByVisibility = document.hidden;
    applyPause();
  });

  // Used by src/services/host.js: draw one frame every `ms` milliseconds, or at the normal rate with 0.
  window.leSetSlowFrames = function (ms) {
    restMs = ms;
    setSlowFrames(ms);
  };
  // Used by src/services/host.js: in rest, draw the scene again only in [x0, x1] of the width (null: all of it)
  window.leSetArea = function (a) {
    restArea = a ? [a[0], a[1]] : null;
  };
  function setSlowFrames(ms) {
    if (ms === slowMs) return;
    slowMs = ms;
    stopFade();
    if (paused) return;
    cancelAnimationFrame(rafId);
    clearTimeout(slowTimer);
    rafId = requestAnimationFrame(frame);
  }

  // ---------------------------------------------------------------- Lively integration
  // Lively calls these globals. Dropdowns send an index, sliders a number, checkboxes a bool.
  const PANEL_POS = ['right-bottom', 'right-top', 'left-bottom', 'left-top'];
  const PANEL_SIZE = ['small', 'medium', 'large'];
  const TRAFFIC = ['light', 'normal', 'busy'];
  const FPS = [24, 30, 45, 60];
  const QUALITY = ['auto', 'eco', 'balanced', 'high', 'ultra'];
  const SCALE = [1, 0.85, 0.75, 0.67];
  const HEADING = [50, 180, 90, 270, 0];
  const WEATHER = [null, 'clear', 'partly', 'overcast', 'rain', 'heavyrain', 'storm', 'fog', 'snow'];

  window.livelyPropertyListener = function (name, val) {
    switch (name) {
      case 'showPanel':
        cfg.ui.showPanel = !!val;
        overlay.apply();
        break;
      case 'panelPosition':
        cfg.ui.panelPosition = PANEL_POS[val] || PANEL_POS[0];
        overlay.apply();
        break;
      case 'panelSize':
        cfg.ui.panelSize = PANEL_SIZE[val] || 'medium';
        overlay.apply();
        break;
      case 'clock24h':
        cfg.ui.clock24h = !!val;
        break;
      case 'tempUnit':
        cfg.ui.tempUnit = val === 1 ? 'F' : 'C';
        break;
      case 'fpsCap':
        cfg.render.fpsCap = FPS[val] || 30;
        break;
      case 'smartFps':
        cfg.render.smartFps = !!val;
        break;
      case 'quality':
        cfg.render.quality = QUALITY[val] || 'auto';
        if (governor) governor.setMode(cfg.render.quality);
        break;
      case 'renderScale':
        cfg.render.renderScale = SCALE[val] || 1;
        onResize();
        break;
      case 'viewDirection':
        cfg.render.heading = HEADING[val] ?? 50;
        break;
      case 'landscapeSeed':
        cfg.render.seed = Math.max(1, Math.round(val));
        break;
      case 'cloudSpeed':
        cfg.atmosphere.cloudSpeed = Number(val) || 1;
        break;
      case 'treeWind':
        cfg.atmosphere.treeWind = Number(val) || 0;
        break;
      case 'weatherMode':
        cfg.overrides.weather = WEATHER[val] || null;
        pushWeather();
        break;
      case 'timelapse':
        cfg.overrides.timelapse = val ? 720 : 0;
        LE.clock.configure(cfg.overrides);
        break;
      case 'demo': // the frame loop starts or ends it
        cfg.demo = !!val;
        break;
      case 'useGeolocation':
        if (cfg.location.useGeolocation !== !!val) {
          cfg.location.useGeolocation = !!val;
          resolveLocation();
        }
        break;
      case 'life':
        cfg.life = !!val;
        break;
      case 'road': // the renderer sees the change and shapes the mountains again
        cfg.road = !!val;
        break;
      case 'birds':
        cfg.birds = !!val;
        break;
      case 'traffic':
        cfg.traffic = TRAFFIC[val] || 'normal';
        break;
      case 'leaves':
        cfg.leaves = !!val;
        break;
      case 'tree':
        cfg.render.tree = !!val;
        break;
      case 'mist':
        cfg.mist = !!val;
        break;
      case 'banners': // the renderer reads it every frame
        cfg.banners = !!val;
        break;
      case 'smoke':
        cfg.smoke = !!val;
        break;
      case 'fires':
        cfg.fires = !!val;
        break;
      case 'lights':
        cfg.lights = !!val;
        break;
      case 'stars':
        cfg.shootingStars = !!val;
        break;
      case 'refreshWeather':
        weather.refreshNow();
        break;
      default:
        break;
    }
  };

  // Lively pauses wallpapers when apps are maximised/fullscreen (if enabled in Lively).
  window.livelyWallpaperPlaybackChanged = function (data) {
    try {
      const obj = typeof data === 'string' ? JSON.parse(data) : data;
      pausedByLively = !!(obj && (obj.IsPaused ?? obj.isPaused));
      applyPause();
    } catch (e) {
      /* ignore malformed messages */
    }
  };

  // ---------------------------------------------------------------- start
  function startRenderer() {
    renderer = new LE.Renderer(canvas, cfg);
    renderer.onStatus = onRendererStatus;
    renderer.onError = fatal; // shader errors surface once background compilation finishes
    renderer.init();
    renderer.life = life;
    lifeSeeded = false;
    governor = new LE.QualityGovernor(renderer, cfg.render.quality);
    const [w, h] = targetSize();
    renderer.resize(w, h);
    window.__le = { renderer, env, weather, cfg, governor, sceneClock };
  }

  canvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    if (renderer) renderer.status = 'lost';
    setVeilText('Graphics device reset — recovering…');
    showVeil(true);
  });
  canvas.addEventListener('webglcontextrestored', () => {
    try {
      startRenderer();
    } catch (err) {
      fatal(err);
    }
  });

  try {
    startRenderer();
  } catch (err) {
    fatal(err);
    return;
  }

  // Weather starts immediately from cache; location (≤ 8 s) may then move it.
  let locationRequest = 0;
  function resolveLocation() {
    const id = ++locationRequest;
    return LE.location.resolve(cfg.location).then((loc) => {
      if (id !== locationRequest) return; // a newer choice replaced this one while it was loading
      const moved = LE.location.distanceKm(loc.lat, loc.lon, location.lat, location.lon) > 10;
      location = loc;
      env.setLocation(loc);
      if (moved) weather.start(loc.lat, loc.lon);
    });
  }
  // Used by src/services/host.js when the place is changed in the Windows app, or found automatically.
  // Applies at once, without reloading the wallpaper.
  window.leSetLocation = function (loc) {
    if (!loc || !isFinite(loc.lat) || !isFinite(loc.lon) || Math.abs(loc.lat) > 90 || Math.abs(loc.lon) > 180) return;
    const name = String(loc.name || 'Your area').slice(0, 60);
    const km = LE.location.distanceKm(loc.lat, loc.lon, location.lat, location.lon);
    if (km < 1 && name === location.name) return;
    locationRequest++; // a geolocation answer still on its way must not undo this choice
    cfg.location.useGeolocation = false;
    location = { lat: loc.lat, lon: loc.lon, name, source: 'host' };
    env.setLocation(location);
    if (km > 10) weather.start(location.lat, location.lon);
  };

  pushWeather();
  weather.start(location.lat, location.lon, true);
  resolveLocation();

  if (cfg.debug) {
    new LE.DebugPanel({
      cfg,
      env,
      life,
      overlay,
      renderer: () => renderer,
      governor: () => governor,
      realWeather: () => weather.current(Date.now()),
      setWeather(rec, atOnce) {
        testWeather = rec;
        const now = weatherRecord();
        env.setWeather(now.rec, now.source);
        if (atOnce) {
          env.w = null; // straight to these values, not the slow change real weather makes
          env.treeAir = null;
          env.wet = 0; // and nothing left of the last weather: wet ground dries and fresh snow melts over hours
          env.freshSnow = 0;
        }
      },
      poke() {
        lastFast = lastBusy = performance.now();
      },
      resize: onResize,
    });
  }

  rafId = requestAnimationFrame(frame);
})();
