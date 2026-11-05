// Behaviour checks in a real browser, without the GPU (see harness.mjs).
// Run: node tests/browser/scenes.mjs <output folder> [stability|location|resize|wrap|trees|front ...]
import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { openWallpaper, sleep, WIDTH, HEIGHT } from './harness.mjs';

const out = process.argv[2];
if (!out) throw new Error('Give an output folder');
const which = process.argv.slice(3);
const want = (name) => !which.length || which.includes(name);
mkdirSync(out, { recursive: true });
const profile = path.join(out, 'edge-profile-software');
const COMMON = 'geo=0&life=0&time=10:30&date=2026-11-03&quality=balanced';

let failures = 0;
const check = (ok, text) => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${text}`);
};

// Counts animation-frame requests from before the page's own code runs
const COUNT_RAF = `
window.__raf = 0;
const __origRaf = window.requestAnimationFrame.bind(window);
window.requestAnimationFrame = (fn) => { window.__raf++; return __origRaf(fn); };
`;

async function open(query, beforeLoad = '') {
  const page = await openWallpaper({ query, profile, beforeLoad });
  const secs = await page.ready();
  console.log(`scene ready after ${secs.toFixed(0)} s on ${page.renderer.slice(0, 60)}`);
  return page;
}
const noErrors = (page) => check(page.errors.length === 0, `no console errors${page.errors.length ? ': ' + page.errors.join(' | ') : ''}`);

// ---------------------------------------------------------------- the test panel
if (want('panel')) {
  console.log('--- the test panel moves what it says');
  const page = await open(`${COMMON}&debug=1`);
  try {
    const say = (expr) => page.evaluate(expr);
    await say(`(() => {
      window.__row = (name) => [...document.querySelectorAll('#test-panel .tp-row')].find((n) => n.querySelector('label').textContent === name);
      window.__move = (name, value) => { const i = __row(name).querySelector('input'); i.value = value; i.dispatchEvent(new Event('input')); i.dispatchEvent(new Event('change')); };
      window.__stop = (name, text) => { const i = __row(name).querySelector('input'); for (let s = +i.min; s <= +i.max; s++) { i.value = s; i.dispatchEvent(new Event('input')); i.dispatchEvent(new Event('change')); if (__row(name).querySelector('.tp-value').textContent === text) return true; } throw new Error('no stop ' + text + ' on ' + name); };
      window.__draws = 0;
      const r = __le.renderer, o = r.render;
      r.render = function (...a) { const d = o.apply(r, a); if (d) __draws++; return d; };
    })()`);
    const count = await say(`document.querySelectorAll('#test-panel input[type=range]').length`);
    check(count >= 30, `${count} sliders`);

    await say(`(__move('Time of day', 1320), T.frames(2))`);
    check((await say(`__le.env.state.astro.sunAltDeg`)) < -10, 'time: night at 22:00');
    check(/Preview time/.test(await say(`document.querySelector('[data-k=status]').textContent`)), 'time: the clock and weather panel says so');
    await say(`(__move('Time of day', 780), T.frames(2))`);
    check((await say(`__le.env.state.astro.sunAltDeg`)) > 10, 'time: day at 13:00');
    await say(`(__move('Day of the year', 196), T.frames(2))`);
    const season = await say(`Array.from(__le.env.state.season)`);
    check(season[0] > 0.5, 'day of the year: 15 July is summer');

    await say(`(__stop('Weather', 'Storm'), T.frames(2))`);
    check((await say(`__le.env.w.storm`)) === 1, 'weather: storm at once');
    check((await say(`__row('Thunder').querySelector('.tp-value').textContent`)) === 'On', 'weather: moves the sliders below it');
    await say(`(__stop('Weather', 'Snow'), T.frames(2))`);
    check((await say(`__le.env.w.snow`)) > 0.3, 'weather: snow');
    await say(`(__stop('Weather', 'Clear'), T.frames(2))`);
    await say(`(__move('Cloud cover', 75), T.frames(2))`);
    const cover = await say(`__le.env.w.coverage`);
    check(Math.abs(cover - 0.75) < 0.001, `cloud slider: ${cover}`);
    check(/Clear \+/.test(await say(`__row('Weather').querySelector('.tp-value').textContent`)), 'weather: shows it has been changed');
    await say(`(__stop('Weather', 'No data'), T.frames(2))`);
    check(/No weather data/.test(await say(`document.querySelector('[data-k=cond]').textContent`)), 'weather: no data');

    await say(`(__stop('Weather', 'Clear'), __move('Wind speed', 100), __move('Gusts', 100), T.frames(3))`);
    const kmh = await say(`__le.env.state.treeKmh`);
    check(Math.abs(kmh - 100) < 0.5, `wind: the tree feels ${kmh} km/h`);
    await say(`(__move('Wind from', 90), T.frames(2))`);
    const east = await say(`__le.env.state.treeDir[0]`);
    await say(`(__move('Wind from', 270), T.frames(2))`);
    const west = await say(`__le.env.state.treeDir[0]`);
    check(east * west < 0, `wind from: turns the air around (${east.toFixed(2)}, ${west.toFixed(2)})`);

    await say(`__stop('Quality', 'Ultra')`);
    check((await say(`__le.governor.name()`)) === 'ultra', 'quality: ultra');
    await say(`__stop('Quality', 'Eco')`);
    check((await say(`__le.governor.name()`)) === 'eco', 'quality: eco');
    await say(`__stop('Tree on the rock', 'Off')`);
    check((await say(`__le.renderer.fg.enabled`)) === false, 'tree: off');
    await say(`(__stop('Tree on the rock', 'On'), __stop('Layer', 'Shadow'), T.frames(1))`);
    check((await say(`__le.cfg.debugView`)) === 3, 'layer: shadow');
    await say(`__stop('Layer', 'Picture')`);

    await say(`(__stop('Wallpaper state', 'Paused'), new Promise((r) => setTimeout(r, 2500)))`);
    const stopped = await say(`__draws`);
    await sleep(3000);
    check((await say(`__draws`)) === stopped, 'state: paused draws nothing');
    await say(`__stop('Wallpaper state', 'Rest, you work')`);
    await sleep(3000);
    check((await say(`__le.renderer._rest`)) === true, 'state: rest');
    await say(`__stop('Wallpaper state', 'Live')`);
    await say(`T.frames(2)`);
    check((await say(`__draws`)) > stopped, 'state: live again');

    // every other slider, end to end, then back
    await say(`(() => { for (const n of document.querySelectorAll('#test-panel .tp-row')) { const name = n.querySelector('label').textContent; if (name === 'Picture size' || name === 'Landscape' || name === 'Wallpaper state') continue; const i = n.querySelector('input'); __move(name, i.min); __move(name, i.max); } })()`);
    await say(`T.frames(3)`);
    await say(`[...document.querySelectorAll('#test-panel .tp-buttons button')].filter((b) => b.textContent !== 'Graphics reset').forEach((b) => b.click())`);
    await say(`T.frames(3)`);
    await say(`[...document.querySelectorAll('#test-panel .tp-head button')].find((b) => b.textContent === 'Reset all').click()`);
    await say(`T.frames(2)`);
    check((await say(`LE.clock.isLive()`)) === true, 'reset all: the clock is live');
    check((await say(`__le.cfg.overrides.weather`)) === null, 'reset all: the weather is real');
    check((await say(`[...document.querySelectorAll('#test-panel .tp-reset')].filter((b) => b.style.visibility === 'visible').length`)) === 0, 'reset all: nothing is left changed');
    const gl = await say(`__le.renderer.gl.getError()`);
    check(gl === 0, `no GL error (${gl})`);
    noErrors(page);
  } finally {
    await page.close();
  }
}

// ---------------------------------------------------------------- stability
if (want('stability')) {
  console.log('--- pause, settings, exposure, debug views, context loss');
  const page = await open(`${COMMON}&debug=1&weather=partly`, COUNT_RAF);
  try {
    await page.evaluate(`(() => {
      window.__draws = 0;
      window.__panel = 0;
      window.__resets = 0;
      const r = __le.renderer;
      const o = r.render;
      r.render = function (...a) { const d = o.apply(r, a); if (d) __draws++; return d; };
      const m = r._meterAndAdapt;
      r._meterAndAdapt = function (...a) { if (r._adaptReset) __resets++; return m.apply(r, a); };
      const u = LE.Overlay.prototype.update;
      LE.Overlay.prototype.update = function (...a) { __panel++; return u.apply(this, a); };
    })()`);
    await page.evaluate(`T.frames(3)`);
    check((await page.evaluate(`__draws`)) > 0, 'draws while running');

    await page.evaluate(`window.livelyWallpaperPlaybackChanged(JSON.stringify({ IsPaused: true }))`);
    await sleep(3000); // a frame already under way may still finish
    const d0 = await page.evaluate(`[__draws, __raf, __panel]`);
    await sleep(11000);
    const d1 = await page.evaluate(`[__draws, __raf, __panel]`);
    check(d1[0] === d0[0], `no draws while paused (${d1[0] - d0[0]})`);
    check(d1[1] === d0[1], `no animation frames while paused (${d1[1] - d0[1]})`);
    check(d1[2] > d0[2], `the panel still updates while paused (${d1[2] - d0[2]} updates)`);

    await page.evaluate(`document.dispatchEvent(new Event('visibilitychange'))`);
    await sleep(3000);
    check((await page.evaluate(`__draws`)) === d1[0], 'a visibility change does not wake a wallpaper Lively has paused');

    await page.evaluate(`window.livelyWallpaperPlaybackChanged(JSON.stringify({ IsPaused: false }))`);
    await page.evaluate(`Promise.race([T.frames(2), new Promise((r) => setTimeout(r, 60000))])`);
    check((await page.evaluate(`__draws`)) > d1[0], 'resumes when Lively says so');

    // The brake: however slow the graphics chip is, frames never pile up on it
    const held = await page.evaluate(`(async () => {
      const r = __le.renderer;
      const real = r.frameDone;
      r.frameDone = () => false;
      await new Promise((d) => setTimeout(d, 3000)); // a frame already under way may still finish
      const a = __draws;
      await new Promise((d) => setTimeout(d, 6000));
      const b = __draws;
      r.frameDone = real;
      return b - a;
    })()`);
    check(held === 0, `nothing is drawn while the graphics chip is still busy (${held} draws)`);
    const beforeRelease = await page.evaluate(`__draws`);
    await page.evaluate(`Promise.race([T.frames(2), new Promise((r) => setTimeout(r, 60000))])`);
    check((await page.evaluate(`__draws`)) > beforeRelease, 'drawing resumes when the graphics chip has caught up');

    const probe = await page.evaluate(`(() => { const f = __le.renderer.fg; return { light: Array.from(f.light), gust: f.gust, err: __le.renderer.gl.getError() }; })()`);
    check(probe.err === 0 && probe.light.every(Number.isFinite) && probe.light.some((v) => v > 0) && Math.abs(probe.gust) <= 1, 'the tree gets its light and gust from the probe without waiting for the GPU');

    const debugLine = `document.getElementById('debug').textContent.split('\\n')[0]`;
    const waitFor = async (test) => {
      for (let i = 0; i < 60; i++) {
        const s = await page.evaluate(debugLine);
        if (test(s)) return s;
        await sleep(500);
      }
      return await page.evaluate(debugLine);
    };
    await page.evaluate(`livelyPropertyListener('smartFps', false)`);
    const off = await waitFor((s) => !s.includes('smart'));
    await page.evaluate(`livelyPropertyListener('smartFps', true)`);
    const on = await waitFor((s) => s.includes('smart'));
    check(!off.includes('smart') && on.includes('smart'), 'the smart fps setting reaches the loop');

    await page.evaluate(`livelyPropertyListener('cloudSpeed', 3); livelyPropertyListener('treeWind', 2)`);
    const a = await page.evaluate(`[__le.cfg.atmosphere.cloudSpeed, __le.cfg.atmosphere.treeWind]`);
    await page.evaluate(`livelyPropertyListener('treeWind', 0)`);
    const off0 = await page.evaluate(`__le.cfg.atmosphere.treeWind`);
    check(a[0] === 3 && a[1] === 2 && off0 === 0, 'cloud speed and tree wind settings apply, and tree wind can be set to 0');
    await page.evaluate(`livelyPropertyListener('cloudSpeed', 1); livelyPropertyListener('treeWind', 1)`);

    await page.evaluate(`T.frames(10)`);
    await page.evaluate(`__resets = 0; __le.renderer.setQuality(LE.QUALITY_LEVELS[2])`);
    await page.evaluate(`T.frames(8)`);
    check((await page.evaluate(`__resets`)) === 0, 'a quality change does not reset the exposure');
    await page.evaluate(`__le.renderer.setQuality(LE.QUALITY_LEVELS[1])`);
    await page.evaluate(`T.frames(4)`);

    for (let v = 1; v <= 8; v++) {
      await page.evaluate(`__le.cfg.debugView = ${v}; T.frames(1)`);
    }
    await page.evaluate(`__le.cfg.debugView = 0`);
    const glErr = await page.evaluate(`__le.renderer.gl.getError()`);
    check(glErr === 0, `debug views run with no GL error (${glErr})`);

    const secs = await page.evaluate(`(async () => {
      const r0 = __le.renderer;
      const ext = r0.gl.getExtension('WEBGL_lose_context');
      ext.loseContext();
      await new Promise((r) => setTimeout(r, 1500));
      ext.restoreContext();
      const t0 = performance.now();
      for (;;) {
        await new Promise((r) => setTimeout(r, 500));
        if (__le.renderer !== r0 && __le.renderer.status === 'running') return (performance.now() - t0) / 1000;
        if (performance.now() - t0 > 600000) return -1;
      }
    })()`);
    check(secs > 0, `recovers from a lost graphics context (${secs.toFixed(0)} s)`);
    await sleep(2000);
    check(await page.evaluate(`document.getElementById('veil').classList.contains('hidden')`), 'the loading screen is gone after recovery');
    noErrors(page);
  } finally {
    await page.close();
  }
}

// ---------------------------------------------------------------- slow location result
if (want('location')) {
  console.log('--- a slow location result must not override a later choice');
  const SLOW_GEO = `
    navigator.geolocation.getCurrentPosition = (ok) => setTimeout(() => ok({ coords: { latitude: 51.5, longitude: -0.12 } }), 3000);
  `;
  const page = await open(`${COMMON}&panel=0&weather=clear`, SLOW_GEO);
  try {
    await page.evaluate(`livelyPropertyListener('useGeolocation', true); livelyPropertyListener('useGeolocation', false)`);
    await sleep(5000);
    const lat = await page.evaluate(`__le.weather.lat`);
    check(Math.abs(lat - 23.71) < 0.01, `stays on Dhaka (latitude ${lat})`);
    await page.evaluate(`livelyPropertyListener('useGeolocation', true)`);
    await sleep(5000);
    const lat2 = await page.evaluate(`__le.weather.lat`);
    check(Math.abs(lat2 - 51.5) < 0.01, `but a location that is still wanted does apply (latitude ${lat2})`);
    noErrors(page);
  } finally {
    await page.close();
  }
}

// ---------------------------------------------------------------- resize during the bake
if (want('resize')) {
  console.log('--- resizing during the bake');
  const p = await openWallpaper({ query: `${COMMON}&panel=0&seed=7`, profile });
  try {
    for (let i = 0; i < 1200; i++) {
      const s = await p.evaluate(`window.__le ? __le.renderer.status : ''`).catch(() => '');
      if (s === 'baking') break;
      await sleep(250);
    }
    await sleep(1000);
    const status = await p.evaluate(`__le.renderer.status`);
    await p.cdp.send('Emulation.setDeviceMetricsOverride', { width: WIDTH / 2, height: HEIGHT, deviceScaleFactor: 1, mobile: false });
    await sleep(1500);
    await p.cdp.send('Emulation.setDeviceMetricsOverride', { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false });
    await sleep(1500);
    const secs = await p.ready();
    await sleep(1500);
    const size = await p.evaluate(`[__le.renderer.w, __le.renderer.h, __le.renderer.status]`);
    check(size[0] === WIDTH && size[1] === HEIGHT && size[2] === 'running', `finishes at full size after a resize during "${status}" (${size.join(' ')}, ${secs.toFixed(0)} s)`);
    noErrors(p);
  } finally {
    await p.close();
  }
}

// ---------------------------------------------------------------- cloud wrap
if (want('wrap')) {
  console.log('--- wrap: the same sky with cloud offsets moved by a whole period');
  // No tree: its leaves keep moving, and only the sky should differ between these frames
  const page = await open(`${COMMON}&panel=0&smartfps=0&tree=0`);
  try {
    await page.evaluate(`T.weather({ code: 2, cloud: 45, cloudLow: 40, cloudMid: 20, cloudHigh: 60, humidity: 70, visibility: 25000, temp: 20, windSpeed: 0, gusts: 0, windDir: 0, wind850: 0, dir850: 0, wind700: 0, dir700: 0, wind300: 0, dir300: 0 })`);
    await page.evaluate(`T.frames(2)`);
    const at = async (deck, mist, cirrus) => {
      // shape evolution is frozen too, so only the offsets differ between the frames
      await page.evaluate(`(() => {
        const e = __le.env;
        if (!e.__update) {
          e.__update = e.update;
          e.update = function (now, dt, time) { return e.__update(window.__t0 ||= now, 0, window.__s0 ||= time); };
        }
        e.windOffset = [${deck}, -700, ${deck}];
        e.mistOffset = [${mist}, -900, ${mist}];
        e.cirrusOffset = [${cirrus}, ${cirrus}];
      })()`);
      await page.evaluate(`(async () => { await T.frames(28); window.__f = await T.grab(0, ${HEIGHT}); })()`);
    };
    await at(-1234.5, -2345.5, -3456.5);
    await page.evaluate(`window.__a = __f`);
    await at(-1234.5, -2345.5, -3456.5);
    const same = await page.evaluate(`T.change(__a, __f)`);
    await at(-1234.5 + 5000, -2345.5 + 5000, -3456.5 + 6250);
    const wrapped = await page.evaluate(`T.change(__a, __f)`);
    await at(-1234.5 + 6000, -2345.5 + 6000, -3456.5 + 6000);
    const old = await page.evaluate(`T.change(__a, __f)`);
    console.log(`same offsets (noise level):  mean change ${same.mean.toFixed(3)}, 2+ levels ${(same.share * 100).toFixed(3)}%`);
    console.log(`moved by the new periods:    mean change ${wrapped.mean.toFixed(3)}, 2+ levels ${(wrapped.share * 100).toFixed(3)}%`);
    console.log(`moved by the old 6000 km:    mean change ${old.mean.toFixed(3)}, 2+ levels ${(old.share * 100).toFixed(3)}%`);
    check(wrapped.mean < same.mean * 1.5 + 0.1, 'wrapping at the new periods is within noise');
    // By pixels changed, not the mean: a jump moves the clouds and leaves the land and most of the sky as they are
    check(old.share > wrapped.share * 3, 'the old 6000 km period shows a jump, so this test can see one');
    noErrors(page);
  } finally {
    await page.close();
  }
}

// ---------------------------------------------------------------- wind in the trees
if (want('trees')) {
  console.log('--- wind in the trees');
  const page = await open(`${COMMON}&panel=0&smartfps=0&quality=eco`);
  try {
    const BAND = 60; // rows from the bottom of the screen: the near forest
    await page.evaluate(`(() => {
      T.calm = (v, dir) => T.weather({ code: 0, cloud: 0, cloudLow: 0, cloudMid: 0, cloudHigh: 0, humidity: 45, visibility: 40000, temp: 18, windSpeed: v, gusts: v, windDir: dir });
      T.ratio = (a, base) => {
        const la = T.lum(a), lb = T.lum(base), w = a.w, h = a.h;
        const src = new Float32Array(la.length);
        for (let i = 0; i < la.length; i++) src[i] = lb[i] > 4 ? la[i] / lb[i] - 1 : 0;
        const R = 3, V = 1;
        const tmp = new Float32Array(la.length), out = new Float32Array(la.length);
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
          let s = 0;
          for (let i = -R; i <= R; i++) s += src[y * w + Math.max(0, Math.min(w - 1, x + i))];
          tmp[y * w + x] = s / (2 * R + 1);
        }
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
          let s = 0;
          for (let i = -V; i <= V; i++) s += tmp[Math.max(0, Math.min(h - 1, y + i)) * w + x];
          out[y * w + x] = s / (2 * V + 1);
        }
        return out;
      };
      T.lagX = (a, b, w, x0, x1, y0, y1, maxLag) => {
        let best = 0, bestC = -Infinity, atZero = 0, sa = 0, sb = 0;
        for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
          sa += a[y * w + x] * a[y * w + x];
          sb += b[y * w + x] * b[y * w + x];
        }
        const norm = Math.sqrt(sa * sb) || 1;
        for (let lag = -maxLag; lag <= maxLag; lag++) {
          let c = 0;
          for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) c += a[y * w + x] * b[y * w + x + lag];
          c /= norm;
          if (lag === 0) atZero = c;
          if (c > bestC) { bestC = c; best = lag; }
        }
        return { lag: best, corr: bestC, atZero };
      };
    })()`);

    // A weather jump makes the exposure adjust for several seconds, which changes every pixel. So wait
    // until the picture holds still with the wind off, then measure the wind alone, on forest rows only.
    const FOREST_ROWS = 20;
    const measure = async (v, dir, amount = 1) => {
      await page.evaluate(`__le.cfg.atmosphere.treeWind = 0; T.calm(${v}, ${dir})`);
      let still = 0;
      const seen = [];
      for (let i = 0; i < 40 && still < 2; i++) {
        const c = await page.evaluate(`(async () => {
          const a = await T.grab(0, ${BAND});
          await new Promise((r) => setTimeout(r, 1000));
          return T.change(a, await T.grab(0, ${BAND}));
        })()`);
        seen.push(`${c.mean.toFixed(2)}/${(c.share * 100).toFixed(2)}%`);
        still = c.share < 0.002 ? still + 1 : 0;
      }
      console.log(`  settling at ${v} km/h, mean change/2+ levels per step: ${seen.join(' ')}`);
      if (still < 2) throw new Error('The picture never held still with the wind off');
      await page.evaluate(`__le.cfg.atmosphere.treeWind = ${amount}`);
      await page.evaluate(`T.frames(2)`);
      return page.evaluate(`(async () => {
        const forest = (f) => ({ px: f.px.subarray(0, f.w * ${FOREST_ROWS} * 4), w: f.w, h: ${FOREST_ROWS} });
        let mean = 0, share = 0, secs = 0;
        const PAIRS = 4; // the waves pass in and out of step, so one pair isn't enough
        for (let i = 0; i < PAIRS; i++) {
          const a = await T.grab(0, ${BAND});
          await new Promise((r) => setTimeout(r, 1000));
          const b = await T.grab(0, ${BAND});
          const c = T.change(forest(a), forest(b));
          mean += c.mean / PAIRS; share += c.share / PAIRS; secs += (b.t - a.t) / 1000 / PAIRS;
          window.__a = a; window.__b = b;
          await new Promise((r) => setTimeout(r, 1500));
        }
        return { mean, share, secs };
      })()`);
    };
    const results = { 5: [], 15: [], 40: [] };
    for (const v of [5, 15, 40, 15, 5]) { // up and back down, so an order effect would show
      const r = await measure(v, 320);
      results[v].push(r);
      console.log(`${String(v).padStart(3)} km/h: mean change ${r.mean.toFixed(2)}, 2+ levels ${(r.share * 100).toFixed(1)}% (over ${r.secs.toFixed(1)} s)`);
      await page.savePng(`T.png(__a)`, path.join(out, `forest-${v}kmh.png`));
      await page.savePng(`T.png(__a, __b, 10)`, path.join(out, `forest-change-${v}kmh.png`));
    }
    const avg = (v) => results[v].reduce((s, r) => s + r.share, 0) / results[v].length;
    check(avg(5) > 0.01 && avg(5) < avg(15) && avg(15) < avg(40), `more wind moves the trees more (${[5, 15, 40].map((v) => (avg(v) * 100).toFixed(1) + '%').join(', ')})`);

    const off = await measure(30, 320, 0);
    check(off.share < 0.005, `slider 0 turns it off (2+ levels ${(off.share * 100).toFixed(2)}%)`);
    await page.evaluate(`(async () => { window.__base = await T.grab(0, ${BAND}); })()`);
    await page.evaluate(`__le.cfg.atmosphere.treeWind = 1`);

    const moved = {};
    for (const [dir, name] of [[320, 'right'], [140, 'left']]) {
      await page.evaluate(`T.calm(30, ${dir})`);
      await page.evaluate(`T.frames(2)`);
      const r = await page.evaluate(`(async () => {
        const a = await T.grab(0, ${BAND});
        await new Promise((r) => setTimeout(r, 6000));
        const b = await T.grab(0, ${BAND});
        return { ...T.lagX(T.ratio(a, __base), T.ratio(b, __base), a.w, 75, 500, 1, 38, 25), secs: (b.t - a.t) / 1000 };
      })()`);
      moved[name] = r.lag;
      console.log(`blowing ${name}: pattern moved ${r.lag > 0 ? '+' : ''}${r.lag} px in ${r.secs.toFixed(1)} s (correlation ${r.corr.toFixed(2)}, at no movement ${r.atZero.toFixed(2)})`);
    }
    check(moved.right > 0 && moved.left < 0, 'gusts travel the way the wind blows');
    noErrors(page);
  } finally {
    await page.close();
  }
}

// ---------------------------------------------------------------- a weather front arriving
if (want('front')) {
  console.log('--- a weather front: clear sky, then cloud arriving from the left, at 3× the normal pace');
  const page = await open(`${COMMON}&panel=0&smartfps=0`);
  try {
    const base = { humidity: 55, visibility: 30000, temp: 20, windSpeed: 12, gusts: 18, windDir: 320, wind850: 25, dir850: 320, wind700: 35, dir700: 320, wind300: 90, dir300: 320, cloudHigh: 5 };
    await page.evaluate(`__le.cfg.atmosphere.transitionSeconds = 30; T.weather(${JSON.stringify({ ...base, code: 0, cloud: 0, cloudLow: 0, cloudMid: 0 })})`);
    await page.evaluate(`T.frames(4)`);
    const stamp = `({ cover: __le.env.state.weather.coverage, lean40km: __le.env.state.coverFront[0] * 40, t: performance.now() })`;
    await page.evaluate(`window.__frames = []; window.__snap = async () => { const f = await T.grab(0, ${HEIGHT}); __frames.push(f); return ${stamp}; }; true`);
    const samples = [await page.evaluate(`__snap()`)];
    const t0 = Date.now();
    await page.evaluate(`__le.env.setWeather(${JSON.stringify({ ...base, code: 3, cloud: 95, cloudLow: 85, cloudMid: 60 })}, 'live')`);
    for (const at of [12, 24, 36, 60, 120]) {
      await sleep(Math.max(0, at * 1000 - (Date.now() - t0)));
      samples.push(await page.evaluate(`__snap()`));
    }
    samples.forEach((s, i) => console.log(`frame ${i}: ${i ? ((s.t - samples[0].t) / 1000).toFixed(0).padStart(3) + ' s after' : '   before'}: deck cover ${s.cover.toFixed(2)}, lean at 40 km ${s.lean40km.toFixed(2)}`));
    for (let i = 0; i < samples.length; i++) await page.savePng(`T.png(__frames[${i}])`, path.join(out, `front-${i}.png`));
    // wind blows towards +x (right), so cover must lean to the upwind (−x) side while it builds
    check(samples.slice(1, 4).every((s) => s.lean40km < 0), 'cover builds from the upwind side');
    check(Math.abs(samples[samples.length - 1].lean40km) < 0.03, 'the lean is gone once the change has played out');
    noErrors(page);
  } finally {
    await page.close();
  }
}

console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nall checks passed');
process.exitCode = failures ? 1 : 0;
