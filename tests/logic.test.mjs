// Logic tests for weather, wind and weather transitions. Run: node tests/logic.test.mjs
// They load the real source files with stubbed browser APIs, so they use no GPU and no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const SRC = new URL('../src/', import.meta.url);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg || 'value'}: got ${a}, expected ${b} ± ${eps}`);

/** Loads the given source files into a fresh fake browser. */
function load(files, { search = '', fetch: fetchStub } = {}) {
  const store = new Map();
  const clock = { offset: 0 };
  class FakeDate extends Date {
    static now() {
      return Date.now() + clock.offset;
    }
  }
  const intervals = new Set();
  const ctx = {
    console,
    URLSearchParams,
    AbortController,
    Date: FakeDate,
    setTimeout,
    clearTimeout,
    setInterval: (fn) => {
      intervals.add(fn);
      return fn;
    },
    clearInterval: (fn) => intervals.delete(fn),
    fetch: fetchStub,
    navigator: { onLine: true },
    document: { hidden: false, addEventListener() {}, removeEventListener() {} },
    location: { search },
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, v),
      removeItem: (k) => store.delete(k),
    },
    addEventListener() {},
    removeEventListener() {},
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  for (const f of files) vm.runInContext(readFileSync(new URL(f, SRC), 'utf8'), ctx, { filename: f });
  return { LE: ctx.LE, ctx, store, clock, tick: () => [...intervals].forEach((fn) => fn()) };
}

/** A minimal Open-Meteo response. */
function apiResponse(cur) {
  const time = Math.floor(Date.now() / 1000);
  return {
    timezone: 'Asia/Dhaka',
    current: { time, weather_code: 1, ...cur },
    hourly: { time: [time], weather_code: [1], cloud_cover_low: [55], wind_speed_700hPa: [99] },
    daily: {},
  };
}
const ok = (cur) => ({ ok: true, status: 200, json: async () => apiResponse(cur) });

function newWeather(fetchStub, overrides = {}) {
  const h = load(['config.js', 'services/storage.js', 'services/weather.js'], { fetch: fetchStub });
  const cfg = Object.assign({}, h.LE.config.weather, { refreshMinutes: 0.0015, retryMinMinutes: 0.0015 }, overrides);
  return { ...h, weather: new h.LE.WeatherService(cfg) };
}

function newEnv(search = '') {
  const h = load(['config.js', 'services/astronomy.js', 'engine/environment.js'], { search });
  const env = new h.LE.Environment(h.LE.config);
  const when = new Date('2026-11-03T06:00:00Z');
  let t = 0;
  const advance = (seconds, dt = 0.5, each) => {
    for (let i = 0; i < seconds / dt; i++) {
      t += dt;
      const s = env.update(when, dt, t);
      if (each) each(s, t);
    }
    return env.state;
  };
  return { ...h, env, advance, cfg: h.LE.config };
}

// ---------------------------------------------------------------- weather service
test('requests and parses upper winds and cloud layers as current values', async () => {
  let url = '';
  const { weather } = newWeather(async (u) => {
    url = u;
    return ok({ cloud_cover_low: 10, cloud_cover_mid: 7, cloud_cover_high: 97, visibility: 9800, wind_speed_850hPa: 5.9, wind_direction_850hPa: 360, wind_speed_700hPa: 21.7, wind_direction_700hPa: 270, wind_speed_300hPa: 78, wind_direction_300hPa: 266 });
  });
  weather.start(23.7, 90.4);
  await sleep(30);
  weather.stop();
  const current = new URL(url).searchParams.get('current').split(',');
  const hourly = new URL(url).searchParams.get('hourly').split(',');
  for (const v of ['wind_speed_850hPa', 'wind_direction_700hPa', 'wind_speed_300hPa']) {
    assert.ok(current.includes(v), `current has ${v}`);
    assert.ok(hourly.includes(v), `hourly has ${v}`);
  }
  for (const v of ['visibility', 'cloud_cover_low', 'cloud_cover_mid', 'cloud_cover_high']) assert.ok(current.includes(v), `current has ${v}`);
  const r = weather.current();
  assert.equal(r.cloudLow, 10);
  assert.equal(r.cloudHigh, 97);
  assert.equal(r.visibility, 9800);
  assert.equal(r.wind700, 21.7);
  assert.equal(r.dir300, 266);
});

test('falls back to the hourly value when a current value is missing', async () => {
  const { weather } = newWeather(async () => ok({}));
  weather.start(23.7, 90.4);
  await sleep(30);
  weather.stop();
  assert.equal(weather.current().cloudLow, 55);
  assert.equal(weather.current().wind700, 99);
});

test('keeps refetching on its interval, and new data reaches listeners', async () => {
  let n = 0;
  const { weather } = newWeather(async () => ok({ cloud_cover_low: ++n * 10 }));
  const seen = [];
  weather.onUpdate((w) => {
    const c = w.current();
    if (c && seen[seen.length - 1] !== c.cloudLow) seen.push(c.cloudLow);
  });
  weather.start(23.7, 90.4);
  await sleep(450);
  weather.stop();
  assert.ok(n >= 3, `fetched ${n} times`);
  assert.deepEqual(seen.slice(0, 3), [10, 20, 30]);
});

test('a fresh start drops the saved forecast and asks the API at once', async () => {
  let calls = 0;
  const { weather } = newWeather(async () => (calls++, ok({ temperature_2m: 30 })), { refreshMinutes: 100 });
  weather.start(23.7, 90.4);
  await sleep(30);
  weather.stop();
  assert.equal(calls, 1);
  weather.start(23.7, 90.4, true);
  assert.equal(weather.current(), null, 'the old forecast is gone');
  await sleep(30);
  weather.stop();
  assert.equal(calls, 2, 'it fetched even though the saved forecast was recent');
  assert.equal(weather.current().temp, 30);
});

test('with the same weather data the sky is the same at dawn and at noon; only the valley mist burns off by day', () => {
  const record = { code: 1, cloud: 20, humidity: 80, visibility: 20000, windSpeed: 8, windDir: 270, precip: 0, temp: 20 };
  const skyAt = (iso) => {
    const { env, LE } = newEnv();
    env.setWeather(record, 'live');
    env.update(new Date(iso), 0.5, 1);
    assert.ok(LE);
    return { ...env.w };
  };
  const dawn = skyAt('2026-11-03T00:05:00Z'); // 06:05 in Dhaka, about sunrise
  const noon = skyAt('2026-11-03T06:30:00Z');
  const byDay = ['mist', 'mistTop', 'fog', 'fogTop']; // (2026-11-18, the user: "too much fog for current time")
  for (const k of Object.keys(noon)) if (!byDay.includes(k)) assert.equal(dawn[k], noon[k], k);
  assert.ok(noon.mist < dawn.mist * 0.3 && noon.mistTop < dawn.mistTop, `the humid air's mist at dawn ${dawn.mist}, at noon ${noon.mist}`);
});

test('clouds keep their true speed when frames are seconds apart', () => {
  const record = { code: 2, cloud: 40, windSpeed: 20, windDir: 270, precip: 0, temp: 20 };
  const moved = (dt) => {
    const { env, advance } = newEnv();
    env.setWeather(record, 'live');
    advance(8, 0.5);
    const before = [...env.windOffset];
    const coverBefore = [...env.coverOffset];
    advance(100, dt);
    return [env.windOffset[0] - before[0], env.coverOffset[0] - coverBefore[0]];
  };
  const smooth = moved(0.5);
  const slow = moved(4);
  assert.ok(Math.abs(smooth[0]) > 0.1, 'the deck moved');
  assert.ok(Math.abs(slow[0] / smooth[0] - 1) < 0.02, `deck: ${smooth[0]} vs ${slow[0]}`);
  assert.ok(Math.abs(smooth[1] / smooth[0] - 0.7) < 0.01, 'cover travels slower than the shapes');
});

test('a location with no matching cache drops the old weather at once', async () => {
  const { weather } = newWeather(async () => ok({ temperature_2m: 30 }));
  weather.start(23.7, 90.4);
  await sleep(30);
  assert.equal(weather.current().temp, 30);
  weather.stop();
  const later = newWeatherAfter(weather);
  assert.equal(later, null);
});
function newWeatherAfter(weather) {
  weather.cfg.refreshMinutes = 100;
  weather.start(51.5, -0.1); // no cache for here; the stubbed fetch has not answered yet
  const r = weather.current();
  weather.stop();
  return r;
}

test('a slow response for the old location is discarded and not cached', async () => {
  const pending = [];
  const { weather, store } = newWeather((u) => new Promise((resolve) => pending.push({ u, resolve })), { refreshMinutes: 100 });
  weather.start(23.7, 90.4);
  await sleep(10);
  weather.start(51.5, -0.1);
  await sleep(10);
  assert.equal(pending.length, 2);
  assert.match(pending[0].u, /latitude=23\.7/);
  pending[1].resolve(ok({ temperature_2m: 11 }));
  await sleep(10);
  pending[0].resolve(ok({ temperature_2m: 99 })); // ignores the abort, like a response already on its way
  await sleep(10);
  weather.stop();
  assert.equal(weather.current().temp, 11);
  const saved = JSON.parse(store.get('le3840.weather.v2'));
  assert.equal(saved.current.temp, 11);
  assert.equal(saved.lat, 51.5);
});

test('never runs two fetches at once', async () => {
  let active = 0;
  let peak = 0;
  let calls = 0;
  const { weather } = newWeather(
    async () => {
      calls++;
      active++;
      peak = Math.max(peak, active);
      await sleep(40);
      active--;
      return ok({});
    },
    { refreshMinutes: 100 }
  );
  weather.start(23.7, 90.4);
  await sleep(5);
  weather.refreshNow();
  weather.refreshNow();
  await sleep(10);
  weather.refreshNow();
  await sleep(70);
  weather.stop();
  assert.equal(peak, 1);
  assert.equal(calls, 1);
});

test('after the PC sleeps, the minute tick refetches overdue data', async () => {
  let calls = 0;
  const { weather, clock, tick } = newWeather(async () => (calls++, ok({})), { refreshMinutes: 15 });
  weather.start(23.7, 90.4);
  await sleep(20);
  assert.equal(calls, 1);
  tick();
  await sleep(20);
  assert.equal(calls, 1, 'not overdue yet');
  clock.offset = 2 * 3600e3; // two hours pass while timers were frozen
  tick();
  await sleep(20);
  weather.stop();
  assert.equal(calls, 2);
});

test('the minute tick respects the retry back-off after a failure', async () => {
  let calls = 0;
  const { weather, tick } = newWeather(async () => (calls++, { ok: false, status: 500 }), { retryMinMinutes: 10, refreshMinutes: 15 });
  weather.start(23.7, 90.4);
  await sleep(20);
  assert.equal(calls, 1);
  tick();
  tick();
  await sleep(20);
  weather.stop();
  assert.equal(calls, 1);
});

test('age stays at zero if the clock moves backwards', async () => {
  const { weather, clock } = newWeather(async () => ok({}), { refreshMinutes: 15 });
  weather.start(23.7, 90.4);
  await sleep(20);
  clock.offset = -3600e3;
  assert.equal(weather.ageMs(), 0);
  assert.equal(weather.current().ageMs, 0);
  weather.stop();
});

// ---------------------------------------------------------------- cloud layers
test('thin high cloud is not drawn as a heavy deck', () => {
  const { env, advance } = newEnv();
  env.setWeather({ code: 3, cloud: 97, cloudLow: 10, cloudMid: 7, cloudHigh: 97 }, 'live');
  const w = advance(0.5).weather;
  near(w.coverage, 1 - 0.9 * 0.93, 0.001, 'deck cover');
  near(w.overcast, 0, 0.001, 'overcast');
  near(w.cirrus, 0.97, 0.001, 'cirrus');
});

test('a real low overcast still draws as overcast', () => {
  const { env, advance } = newEnv();
  env.setWeather({ code: 3, cloud: 100, cloudLow: 95, cloudMid: 40, cloudHigh: 20 }, 'live');
  assert.ok(advance(0.5).weather.coverage >= 0.9);
});

test('high cloud alone does not add deck cloud under the partly cloudy code', () => {
  const { env, advance } = newEnv();
  env.setWeather({ code: 2, cloud: 45, cloudLow: 0, cloudMid: 0, cloudHigh: 45 }, 'live');
  near(advance(0.5).weather.coverage, 0, 0.001, 'deck cover');
});

test('presets and records without layers behave as before', () => {
  const { env, advance, LE } = newEnv();
  env.setWeather(LE.weatherPresets.overcast, 'preview');
  assert.ok(advance(0.5).weather.coverage >= 0.9);
  const b = newEnv();
  b.env.setWeather({ code: 2, cloud: 10 }, 'live');
  near(b.advance(0.5).weather.coverage, 0.3, 0.001, 'code 2 floor');
});

// ---------------------------------------------------------------- real wind on each layer
const WIND = { code: 1, cloudLow: 10, cloudMid: 7, windSpeed: 7, windDir: 90, wind850: 36, dir850: 270, wind700: 36, dir700: 270, wind300: 72, dir300: 180 };

function driftPerSecond(env, advance) {
  advance(1); // settle (first update snaps to the targets)
  const a = { deck: [...env.windOffset], cirrus: [...env.cirrusOffset], mist: [...env.mistOffset] };
  advance(100);
  return {
    deck: [(env.windOffset[0] - a.deck[0]) / 100, (env.windOffset[2] - a.deck[2]) / 100],
    cirrus: [(env.cirrusOffset[0] - a.cirrus[0]) / 100, (env.cirrusOffset[1] - a.cirrus[1]) / 100],
    mist: [(env.mistOffset[0] - a.mist[0]) / 100, (env.mistOffset[2] - a.mist[2]) / 100],
  };
}

test('clouds move at real speed and direction at slider 1', () => {
  const { env, advance, cfg } = newEnv();
  assert.equal(cfg.atmosphere.cloudSpeed, 1);
  cfg.render.heading = 0;
  env.setWeather(WIND, 'live');
  const d = driftPerSecond(env, advance);
  // wind from 270° at 36 km/h blows east (+x) at 0.01 km/s. The noise offset runs the opposite way.
  near(d.deck[0], -0.01, 1e-6, 'deck x');
  near(d.deck[1], 0, 1e-6, 'deck z');
  // cirrus: 72 km/h from 180° blows north (+z)
  near(d.cirrus[0], 0, 1e-6, 'cirrus x');
  near(d.cirrus[1], -0.02, 1e-6, 'cirrus z');
  // mist stays on the 10 m wind: 7 km/h from 90° blows west, at 0.55 of the wind speed
  near(d.mist[0], (7 / 3600) * 0.55, 1e-6, 'mist x');
});

test('directions follow the view heading', () => {
  const { env, advance, cfg } = newEnv();
  cfg.render.heading = 90; // looking east, so a wind blowing east moves away from the viewer (+z)
  env.setWeather(WIND, 'live');
  const d = driftPerSecond(env, advance);
  near(d.deck[0], 0, 1e-6, 'deck x');
  near(d.deck[1], -0.01, 1e-6, 'deck z');
});

test('the slider is a straight time-lapse multiplier', () => {
  const { env, advance, cfg } = newEnv();
  cfg.render.heading = 0;
  cfg.atmosphere.cloudSpeed = 5;
  env.setWeather(WIND, 'live');
  near(driftPerSecond(env, advance).deck[0], -0.05, 1e-6, 'deck x');
});

test('the deck follows the wind of the layer holding the cloud', () => {
  const speedAt = (cloudLow, cloudMid) => {
    const { env, advance, cfg } = newEnv();
    cfg.render.heading = 0;
    env.setWeather({ code: 1, cloudLow, cloudMid, wind850: 36, dir850: 270, wind700: 72, dir700: 270 }, 'live');
    return -driftPerSecond(env, advance).deck[0] * 3600;
  };
  near(speedAt(50, 0), 36, 0.01, 'low cloud only');
  near(speedAt(0, 50), 72, 0.01, 'mid cloud only');
  near(speedAt(0, 0), 72, 0.01, 'no deck: 700 hPa');
  near(speedAt(30, 30), 54, 0.01, 'equal layers');
});

test('without upper winds, the deck uses surface wind × 2.4 and cirrus × 1.7', () => {
  const { env, advance, cfg, LE } = newEnv();
  cfg.render.heading = 0;
  env.setWeather({ code: 1, windSpeed: 20, windDir: 270 }, 'live');
  const d = driftPerSecond(env, advance);
  near(d.deck[0], (-20 * 2.4) / 3600, 1e-6, 'deck x');
  near(d.cirrus[0], (-20 * 2.4 * 1.7) / 3600, 1e-6, 'cirrus x');
  assert.ok(LE.weatherPresets.clear.wind700 === undefined);
});

test('a wind change takes the short way round', () => {
  const { env, advance, cfg } = newEnv();
  cfg.render.heading = 0;
  env.setWeather({ code: 1, wind700: 36, dir700: 350 }, 'live');
  advance(1);
  env.setWeather({ code: 1, wind700: 36, dir700: 10 }, 'live');
  let lowest = Infinity;
  advance(120, 0.5, () => {
    lowest = Math.min(lowest, Math.hypot(env.w.deckE, env.w.deckN));
    // from the north side all the way: blowing south, never north
    assert.ok(env.w.deckN < 0);
  });
  assert.ok(lowest > 30, `speed stayed up, lowest ${lowest}`);
});

test('offsets wrap without resetting to zero', () => {
  const { env, advance, cfg } = newEnv();
  cfg.render.heading = 0;
  env.setWeather(WIND, 'live');
  advance(1);
  env.windOffset[0] = -4999.999;
  env.cirrusOffset[1] = -6249.999;
  advance(1);
  assert.ok(env.windOffset[0] > -1 && env.windOffset[0] < 0, `deck ${env.windOffset[0]}`);
  assert.ok(env.cirrusOffset[1] > -1 && env.cirrusOffset[1] < 0, `cirrus ${env.cirrusOffset[1]}`);
});

test('wrap periods are whole tiles of every noise frequency they feed', () => {
  const whole = (x) => Math.abs(x - Math.round(x)) < 1e-6;
  const deck = [0.0042, 0.1, 0.14, 0.027, 0.5, 0.045, 0.011, 0.004];
  for (const f of deck) assert.ok(whole(5000 * f), `deck ${f}`);
  const mist = [0.3, 1, 0.3 * 2.9, 2.9, 0.6 * 0.45, 0.6 * 1.3];
  for (const f of mist) assert.ok(whole(5000 * f), `mist ${f}`);
  const cirrus = [0.016, 0.016 * 0.33, 0.016 * 3.1];
  for (const f of cirrus) assert.ok(whole(6250 * f), `cirrus ${f}`);
});

// ---------------------------------------------------------------- dynamic weather changes
const CLEAR = { code: 0, cloud: 0, cloudLow: 0, cloudMid: 0, cloudHigh: 0, humidity: 50, windSpeed: 8, windDir: 270, wind850: 20, dir850: 270, wind700: 30, dir700: 270 };
const RAIN = { ...CLEAR, code: 63, cloud: 100, cloudLow: 90, cloudMid: 80, precip: 3 };
const STORM = { ...CLEAR, code: 95, cloud: 100, cloudLow: 95, cloudMid: 90, precip: 6 };

function settledOn(rec, search) {
  const h = newEnv(search);
  h.cfg.render.heading = 0;
  h.env.setWeather(rec, 'live');
  h.advance(1);
  return h;
}

test('a change eases in instead of starting suddenly', () => {
  const { env, advance } = settledOn(CLEAR);
  env.setWeather({ ...CLEAR, code: 3, cloudLow: 95 }, 'live');
  const after5 = advance(5).weather.coverage;
  // a plain blend (the old behaviour) would already be 5.4% of the way there
  assert.ok(after5 < 0.95 * 0.02, `after 5 s: ${after5}`);
  const after120 = advance(115).weather.coverage;
  assert.ok(after120 > 0.5, `after 2 min: ${after120}`);
});

test('rain waits for the clouds, then builds', () => {
  const { env, advance } = settledOn(CLEAR);
  env.setWeather(RAIN, 'live');
  let coverWhenRainStarts = null;
  advance(600, 0.5, (s) => {
    if (coverWhenRainStarts === null && s.weather.rain > 0.02) coverWhenRainStarts = s.weather.coverage;
  });
  assert.ok(coverWhenRainStarts >= 0.4, `cover when rain began: ${coverWhenRainStarts}`);
  near(env.state.weather.rain, 0.6, 0.01, 'final rain');
});

test('lightning waits for dark clouds', () => {
  const { env, advance } = settledOn(CLEAR);
  env.setWeather(STORM, 'live');
  let firstFlash = null;
  advance(600, 0.1, (s) => {
    if (firstFlash === null && s.weather.flash > 0.01) firstFlash = { dark: s.weather.cloudDark, cover: s.weather.coverage };
  });
  assert.ok(firstFlash, 'lightning happened');
  assert.ok(firstFlash.dark >= 0.25, `dark ${firstFlash.dark}`);
});

test('the sky holds until the rain has eased, then clears slowly', () => {
  const { env, advance } = settledOn(RAIN);
  env.setWeather({ ...CLEAR }, 'live');
  let coverWhenRainEnds = null;
  let rainEndedAt = null;
  advance(1500, 0.5, (s, t) => {
    if (coverWhenRainEnds === null && s.weather.rain < 0.05) {
      coverWhenRainEnds = s.weather.coverage;
      rainEndedAt = t;
    }
  });
  assert.ok(coverWhenRainEnds > 0.7, `cover when the rain ended: ${coverWhenRainEnds}`);
  assert.ok(rainEndedAt < 300, `rain ended after ${rainEndedAt} s`);
  near(env.state.weather.coverage, 0, 0.01, 'clear in the end');
});

test('clearing takes longer than building', () => {
  const timeToHalf = (from, to) => {
    const { env, advance } = settledOn(from);
    env.setWeather(to, 'live');
    let at = null;
    const start = env.state.weather.coverage;
    const end = to.cloudLow / 100;
    advance(1500, 0.5, (s, t) => {
      if (at === null && Math.abs(s.weather.coverage - start) >= Math.abs(end - start) / 2) at = t;
    });
    return at;
  };
  const A = { ...CLEAR, code: 2, cloudLow: 0 };
  const B = { ...CLEAR, code: 2, cloudLow: 60 };
  const build = timeToHalf(A, B);
  const clear = timeToHalf(B, A);
  assert.ok(clear > build * 1.4, `build ${build} s, clear ${clear} s`);
});

test('strong wind brings a change sooner than still air', () => {
  const timeToHalf = (wind) => {
    const from = { ...CLEAR, code: 2, wind700: wind, wind850: wind };
    const { env, advance } = settledOn(from);
    env.setWeather({ ...from, cloudLow: 60 }, 'live');
    let at = null;
    advance(1500, 0.5, (s, t) => {
      if (at === null && s.weather.coverage >= 0.3) at = t;
    });
    return at;
  };
  const calm = timeToHalf(5);
  const strong = timeToHalf(80);
  assert.ok(strong < calm * 0.6, `strong ${strong} s, calm ${calm} s`);
});

test('a storm arrives faster than light cloud in the same wind', () => {
  const timeTo = (rec) => {
    const { env, advance } = settledOn(CLEAR);
    env.setWeather(rec, 'live');
    let at = null;
    advance(1500, 0.5, (s, t) => {
      if (at === null && s.weather.coverage >= 0.4) at = t;
    });
    return at;
  };
  const storm = timeTo(STORM);
  const cloud = timeTo({ ...CLEAR, code: 3, cloudLow: 95, cloudMid: 90 });
  assert.ok(storm < cloud * 0.85, `storm ${storm} s, cloud ${cloud} s`);
});

test('a front arrives from upwind, then fades away', () => {
  const { env, advance } = settledOn(CLEAR); // heading 0, wind from 270° blows towards +x: upwind is −x
  near(env.state.coverFront[0], 0, 1e-12, 'no lean in settled weather');
  env.setWeather({ ...CLEAR, code: 3, cloudLow: 95 }, 'live');
  let peak = 0;
  let last = 0;
  let biggestStep = 0;
  advance(1500, 0.5, (s) => {
    const x = s.coverFront[0];
    assert.ok(x <= 1e-9, `more cover on the upwind (−x) side, got ${x}`);
    biggestStep = Math.max(biggestStep, Math.abs(x - last));
    last = x;
    peak = Math.min(peak, x);
  });
  assert.ok(peak * 40 < -0.15, `lean at 40 km peaked at ${peak * 40}`);
  assert.ok(biggestStep * 40 < 0.01, `lean changes gently: ${biggestStep * 40} per 0.5 s`);
  near(env.state.coverFront[0] * 40, 0, 0.001, 'gone once the change is done');
});

test('clearing starts from the upwind side', () => {
  const { env, advance } = settledOn({ ...CLEAR, code: 3, cloudLow: 95 });
  env.setWeather(CLEAR, 'live');
  let peak = 0;
  advance(300, 0.5, (s) => (peak = Math.max(peak, s.coverFront[0])));
  assert.ok(peak * 40 > 0.1, `less cover upwind means a positive x lean: ${peak * 40}`);
});

test('no lean in still air, where the wind direction means nothing', () => {
  const calm = { ...CLEAR, wind850: 0, wind700: 0 };
  const { env, advance } = settledOn(calm);
  env.setWeather({ ...calm, code: 3, cloudLow: 95 }, 'live');
  advance(300, 0.5, (s) => assert.equal(Math.hypot(s.coverFront[0], s.coverFront[1]), 0));
});

// ---------------------------------------------------------------- wind in the trees
function windAmtRange(rec, seconds = 600) {
  const { env, advance, cfg } = settledOn(rec);
  cfg.render.heading = 0;
  let lo = Infinity;
  let hi = 0;
  advance(seconds, 0.5, (s) => {
    lo = Math.min(lo, s.windAmt);
    hi = Math.max(hi, s.windAmt);
  });
  return { lo, hi, env };
}

test('tree response rises with real wind, and still air is nearly still', () => {
  const still = windAmtRange({ code: 1, windSpeed: 0.2, gusts: 0.3, windDir: 270 });
  const light = windAmtRange({ code: 1, windSpeed: 5, gusts: 5, windDir: 270 });
  const fresh = windAmtRange({ code: 1, windSpeed: 15, gusts: 15, windDir: 270 });
  const gale = windAmtRange({ code: 1, windSpeed: 40, gusts: 40, windDir: 270 });
  assert.ok(still.hi < 0.001, `still ${still.hi}`);
  assert.ok(light.hi > 0.1 && light.hi < fresh.hi && fresh.hi < gale.hi, `${light.hi} ${fresh.hi} ${gale.hi}`);
});

test('gusts come from the real gust speed, with lulls between them', () => {
  const r = windAmtRange({ code: 1, windSpeed: 6, gusts: 30, windDir: 270 });
  const steady = windAmtRange({ code: 1, windSpeed: 6, gusts: 6, windDir: 270 });
  assert.ok(r.hi > steady.hi * 1.5, `gust ${r.hi} vs steady ${steady.hi}`);
  assert.ok(r.lo < r.hi * 0.6, `lull ${r.lo} vs gust ${r.hi}`);
});

test('the slider scales the tree response, and 0 turns it off', () => {
  const at = (v) => {
    const { env, advance, cfg } = settledOn({ code: 1, windSpeed: 10, gusts: 10, windDir: 270 });
    cfg.atmosphere.treeWind = v;
    return advance(1).windAmt;
  };
  assert.equal(at(0), 0);
  near(at(2), at(1) * 2, 1e-9, 'twice as strong');
});

test('gust fronts travel downwind at gust speed', () => {
  const { env, advance, cfg } = settledOn({ code: 1, windSpeed: 36, gusts: 36, windDir: 270 });
  cfg.render.heading = 0;
  advance(30);
  near(env.state.gustDir[0], 1, 1e-6, 'wind from 270° blows towards +x');
  near(env.state.gustDir[1], 0, 1e-6, 'z');
  const a = env.gustTravel[0];
  advance(100);
  near(env.gustTravel[0] - a, 0.014 * 100, 1e-6, 'km in 100 s at 36 km/h × 1.4');
});

test('tree wind direction changes slowly, by the short way', () => {
  const { env, advance, cfg } = settledOn({ code: 1, windSpeed: 20, gusts: 20, windDir: 270 });
  cfg.render.heading = 0;
  env.setWeather({ code: 1, windSpeed: 20, gusts: 20, windDir: 350 }, 'live');
  advance(60);
  const early = (Math.atan2(env.state.gustDir[0], env.state.gustDir[1]) * 180) / Math.PI;
  // towards 170° (from 350°), starting from 90°: only a little of the way after a minute
  assert.ok(early > 89 && early < 125, `after 1 min ${early}°`);
  advance(1800);
  const late = (Math.atan2(env.state.gustDir[0], env.state.gustDir[1]) * 180) / Math.PI;
  near(late, 170, 1, 'after 30 min');
});

// ---------------------------------------------------------------- sun and moon
// US Naval Observatory times for Dhaka (23.7104, 90.4074, UTC+6), fetched on 2026-11-03
const USNO_DHAKA = [
  ['2026-11-03', '00:23', '13:34', '06:05', '17:18'],
  ['2026-11-10', '06:57', '17:45', '06:09', '17:15'],
  ['2026-11-17', '12:18', '23:51', '06:14', '17:12'],
  ['2026-11-24', '16:44', '05:46', '06:19', '17:11'],
  ['2026-12-01', null, '12:10', '06:24', '17:11'],
  ['2026-12-15', '10:50', '22:36', '06:33', '17:14'],
  ['2027-01-05', '04:36', '15:12', '06:42', '17:26'],
  ['2027-02-01', '02:31', '13:08', '06:39', '17:45'],
  ['2027-03-20', '16:08', '04:22', '06:03', '18:09'],
  ['2027-04-01', '02:15', '13:18', '05:51', '18:14'],
  ['2027-05-14', '12:53', '00:59', '05:17', '18:33'],
  ['2027-07-01', '01:59', '16:03', '05:15', '18:49'],
  ['2027-08-09', '12:22', '23:19', '05:31', '18:36'],
  ['2027-09-30', '05:47', '17:44', '05:50', '17:47'],
  ['2027-10-25', '01:29', '14:24', '06:00', '17:25'],
];

test('sun and moon times match the Naval Observatory for Dhaka', () => {
  const A = load(['services/astronomy.js']).LE.astronomy;
  const LAT = 23.7104;
  const LON = 90.4074;
  const off = (when, usno) => {
    const t = new Date(when.getTime() + 6 * 3600e3);
    const [h, m] = usno.split(':').map(Number);
    return t.getUTCHours() * 60 + t.getUTCMinutes() + t.getUTCSeconds() / 60 - (h * 60 + m);
  };
  for (const [date, moonRise, moonSet, sunRise, sunSet] of USNO_DHAKA) {
    const midnight = new Date(`${date}T00:00:00+06:00`);
    const moon = A.moonEvents(midnight, LAT, LON);
    const sun = A.sunTimes(new Date(midnight.getTime() + 12 * 3600e3), LAT, LON);
    if (moonRise) assert.ok(Math.abs(off(moon.rise, moonRise)) < 1.5, `${date} moonrise off by ${off(moon.rise, moonRise)} min`);
    assert.ok(Math.abs(off(moon.set, moonSet)) < 1.5, `${date} moonset off by ${off(moon.set, moonSet)} min`);
    assert.ok(Math.abs(off(sun.sunrise, sunRise)) < 0.75, `${date} sunrise off by ${off(sun.sunrise, sunRise)} min`);
    assert.ok(Math.abs(off(sun.sunset, sunSet)) < 0.75, `${date} sunset off by ${off(sun.sunset, sunSet)} min`);
  }
});

// ---------------------------------------------------------------- day into night and back
/** A whole day in Dhaka in steps of `step` seconds: the state after each, with the time it is for. */
function dayOfLight(date, step, each) {
  const h = load(['config.js', 'services/astronomy.js', 'engine/environment.js']);
  const env = new h.LE.Environment(h.LE.config);
  env.setLocation({ lat: 23.8103, lon: 90.4125, name: 'Dhaka' });
  env.setWeather(h.LE.weatherPresets.clear, 'preset');
  const start = new Date(`${date}T00:00:00+06:00`).getTime();
  let t = 0;
  for (let k = 0; k <= 86400 / step; k++) {
    const now = new Date(start + k * step * 1000);
    env.update(now, 0.6, (t += 0.6)); // half a second on: the sun and moon are worked out again
    each(env.state, now);
  }
}
// new moon, first quarter (up at dusk, sets near midnight), full moon (sets at dawn, rises at dusk), last quarter
const MOON_DAYS = ['2026-11-08', '2026-11-17', '2026-11-24', '2026-12-01'];

test('the light changes hands from the sun to the moon only twice a day, where the sun has nothing left to light', () => {
  // the sun drops below the horizon of a point h km up at sqrt(2h/R) radians down; the sky's transmittance then
  // softens that edge by about a quarter of a degree. The highest things in the scene: peaks of about 9 km and the
  // tops of storm clouds at about 11 km.
  const gone = (Math.sqrt((2 * 11) / 6360) * 180) / Math.PI + 0.25;
  for (const date of MOON_DAYS) {
    let prev = null;
    const changes = [];
    dayOfLight(date, 30, (s, now) => {
      assert.deepEqual(Array.from(s.lightMarchDir), Array.from(s.keyDir), 'clouds are lit through along the key light');
      if (prev !== null && s.keyIsSun !== prev) changes.push({ sun: s.astro.sunAltDeg, moon: s.astro.moonAltDeg, now });
      prev = s.keyIsSun;
    });
    assert.equal(changes.length, 2, `${date}: once at dusk and once at dawn, not at moonrise or moonset: ${JSON.stringify(changes)}`);
    for (const c of changes) {
      assert.ok(c.sun < -gone && c.sun > -4.2, `${date} ${c.now.toISOString()}: the sun is ${c.sun.toFixed(2)}° down, past ${gone.toFixed(2)}°`);
    }
  }
});

test('the twilight glow fades in and out with the sun, never all at once', () => {
  // in steps of 5 s: a fade over minutes changes little in each, a cut is as big however small the step
  for (const date of MOON_DAYS.slice(0, 2)) {
    let prev = null;
    let most = 0;
    dayOfLight(date, 5, (s) => {
      // the glow as a share of the light the picture is exposed for, as the eye sees it
      const glow = s.twilightE / s.exposure;
      if (prev !== null) most = Math.max(most, Math.abs(glow - prev));
      prev = glow;
    });
    // it stopped dead at the sun's first degree with 0.015 left, and came on at once at sunset
    assert.ok(most < 0.002, `${date}: the glow changed by ${most.toFixed(4)} of the exposure in 5 s`);
  }
});

test('the light through the clouds changes from the full march to the quick look over a band of overcast, not at one value', () => {
  const vol = readFileSync(new URL('../src/engine/shaders/volume.js', import.meta.url), 'utf8');
  // switched at overcast 0.7, the clouds turned a twentieth darker in one frame (CPU render, 960x270, 10:00)
  assert.ok(!/if \(uOvercast < 0\.7\)/.test(vol), 'no switch at one value');
  assert.ok(vol.includes('float thick = smoothstep(0.6, 0.7, uOvercast);'), 'a band below 0.7, so a thick deck costs no more than before');
  assert.ok(vol.includes('od = mix(od, cloudBulk(p + uLightMarchDir * 0.6) * 1.5, thick)'), 'the two meet in it');
});

test('wet ground shows no single-pixel glints where the surface turns within a pixel', () => {
  const comp = readFileSync(new URL('../src/engine/shaders/composite.js', import.meta.url), 'utf8');
  // In rain the sharp wet highlight lit single pixels along the rim of the rock and the edges of the road, as rows of
  // pale flecks (seen on the desktop 2026-11-09; CPU render 3840x1080, rain, 13:00). The highlight widens by how much
  // the surface normal turns to the next pixel, so the flecks go and flat wet faces keep their gloss.
  const spec = comp.slice(comp.indexOf('// specular: wet rock / snow'), comp.indexOf('float specMask'));
  assert.ok(/if \(wet > 0\.01\) \{/.test(spec), 'only while wet: dry ground and snow are as before');
  assert.ok(spec.includes('texelFetch(uG0, min(ic + ivec2(1, 0), last), 0)') && spec.includes('texelFetch(uG0, min(ic + ivec2(0, 1), last), 0)'), 'the normal of the next pixel across and up, kept inside the picture');
  assert.ok(/a2 \+= min\(0\.5 \* \(dot\(dnx, dnx\) \+ dot\(dny, dny\)\), 0\.18\) \* wet;/.test(spec), 'widened by the turn, with a limit');
  assert.ok(spec.indexOf('a2 +=') < spec.indexOf('float dd'), 'before the highlight is worked out');
});

// ---------------------------------------------------------------- the range across two screens, banner clouds
const RENDER_FILES = ['config.js', 'engine/gl.js', 'engine/quality.js', 'engine/foreground.js', 'engine/renderer.js'];
const readSrc = (f) => readFileSync(new URL('../src/' + f, import.meta.url), 'utf8');

test('across two screens the great range turns so no peak stands on the bezel; a single screen keeps its picture', () => {
  const h = load(RENDER_FILES);
  const r = new h.LE.Renderer({}, h.LE.config);
  // The sharp peak in the middle of the panorama stood exactly on the bezel of the user's two screens (their photo,
  // 2026-11-09). The skyline read from the bake (CPU, 180 degrees wide): that peak tops out at 12.2 degrees at 0 and is
  // about 3 degrees wide each way; 12 degrees to its left the skyline is a low ridge (4.4 to 6 degrees, no summit
  // within 3), and turning the range by that puts the ridge on the bezel and the peak 320 px into the right screen.
  near(r.rangeTurn(3840, 1080), (12 * Math.PI) / 180, 1e-9, 'two 1920x1080 screens side by side');
  assert.equal(r.rangeTurn(1920, 1080), 0, 'one screen: the peak stays in its middle');
  assert.equal(r.rangeTurn(2560, 1080), 0, 'one ultrawide screen has no bezel');
  const off = load(RENDER_FILES, { search: '?spanturn=0' });
  assert.equal(new off.LE.Renderer({}, off.LE.config).rangeTurn(3840, 1080), 0, 'the address can turn it off');
  // only the great range turns: the foothills, the road, the rock and the tree stay where they are
  const chunks = readSrc('engine/shaders/chunks.js');
  assert.ok(chunks.includes('float foot = fbmEroded(q * 0.24, oct);'), 'the foothills are not turned');
  assert.ok(chunks.includes('float angM = atan(pm.x, pm.y);') && chunks.includes('ridged(qm * 0.072') && chunks.includes('noise2(qm * 0.024'), 'the range is');
  assert.ok(chunks.includes('* front;\n  if (m > 0.0005)'), 'and it still rises in front of the eye, not behind');
  // every program that draws the land sets the camera, and with it the turn
  assert.ok(readSrc('engine/renderer.js').includes("prog.set('uRangeTurn', [Math.cos(turn), Math.sin(turn)]);"));
});

test('banner clouds come with moist air and wind at the clouds, not under a closed deck, in rain or in fog', () => {
  const amount = (rec, seconds = 1) => {
    const { env, advance } = newEnv();
    env.setWeather(rec, 'live');
    return advance(seconds).weather.banner;
  };
  const { LE } = newEnv();
  const P = LE.weatherPresets;
  assert.ok(amount({ code: 1, cloud: 20, humidity: 80, windSpeed: 12 }) > 0.9, 'moist and windy: plenty');
  const partly = amount(P.partly);
  assert.ok(partly > 0.3 && partly < 0.7, 'a partly cloudy day: some ' + partly.toFixed(2));
  assert.ok(amount({ code: 1, cloud: 20, humidity: 30, windSpeed: 12 }) < 0.01, 'dry air: none');
  const still = { code: 1, cloud: 20, humidity: 80, cloudLow: 10, cloudMid: 5, wind850: 3, dir850: 270, wind700: 4, dir700: 270 };
  assert.ok(amount(still) < 0.01, 'still air at the clouds: none');
  for (const k of ['overcast', 'rain', 'storm', 'fog', 'snow']) assert.ok(amount(P[k]) < 0.01, k + ': none');
  // they form over minutes, not at once
  const { env, advance } = newEnv();
  env.setWeather({ code: 1, cloud: 20, humidity: 30, windSpeed: 12 }, 'live');
  advance(1);
  env.setWeather({ code: 1, cloud: 20, humidity: 80, windSpeed: 12 }, 'live');
  assert.ok(advance(30).weather.banner < 0.15, 'half a minute later: hardly begun');
  assert.ok(advance(900).weather.banner > 0.8, 'a quarter of an hour later: there');
});

test('banner clouds stream along the wind at the clouds, the way the deck drifts, and turn with it', () => {
  const { env, advance, cfg, LE } = newEnv();
  cfg.render.heading = 0;
  env.setWeather({ ...WIND, humidity: 80 }, 'live');
  const d = driftPerSecond(env, advance);
  const r = new (load(RENDER_FILES).LE.Renderer)({}, cfg);
  r.peaks = [{ x: 0, y: 8, z: 25, sharp: 1, periods: [1e9, 1e9], phases: [Math.PI / 2, 0], seed: 1 }];
  const s = env.state;
  const [b] = r.bannerState(s);
  assert.ok(b && b.strength > 0.5, 'a banner flies');
  // the deck's noise offset runs against the wind, so the clouds themselves drift the other way
  const drift = [-d.deck[0], -d.deck[1]];
  const dl = Math.hypot(drift[0], drift[1]);
  near(b.wx, drift[0] / dl, 1e-6, 'along the drift, x');
  near(b.wz, drift[1] / dl, 1e-6, 'along the drift, z');
  // the wind turns round to come from the north: the banner turns with it, the short way, over minutes
  env.setWeather({ ...WIND, humidity: 80, dir850: 0, dir700: 0 }, 'live');
  advance(5);
  const soon = r.bannerState(s)[0];
  assert.ok(soon.wx > 0.9, 'not at once');
  advance(900);
  const later = r.bannerState(s)[0];
  near(later.wx, 0, 0.05, 'blowing south now, x');
  near(later.wz, -1, 0.05, 'blowing south now, z');
  assert.ok(later.len > 1.6 && later.len < 4.5, 'a few km long: ' + later.len.toFixed(2));
  // and the switch takes them away
  cfg.banners = false;
  assert.equal(r.bannerState(s).length, 0, 'off');
});

test('banner clouds come and go on each summit by itself, not all together', () => {
  const h = load(RENDER_FILES);
  const r = new h.LE.Renderer({}, h.LE.config);
  r.peaks = [0, 1, 2, 3].map((n) => {
    const u = [0.13, 0.42, 0.77, 0.91][n];
    return { x: n, y: 8, z: 25, sharp: 0.9, periods: [1200 + 1500 * u, 1700 + 1300 * ((u * 7.3) % 1)], phases: [u * 40, u * 17 + n], seed: n };
  });
  let some = 0, all = 0, n = 0;
  const each = [0, 0, 0, 0];
  for (let t = 0; t < 86400; t += 60, n++) {
    const list = r.bannerState({ weather: { banner: 0.7, deckX: 20, deckZ: 0 }, time: t });
    if (list.length) some++;
    if (list.length === 4) all++;
    for (const b of list) each[r.peaks.indexOf(b.p)]++;
  }
  assert.ok(some / n > 0.8, 'in moist, windy weather nearly always one somewhere: ' + (some / n).toFixed(2));
  assert.ok(all / n < 0.6, 'not all four the whole time: ' + (all / n).toFixed(2));
  for (const c of each) assert.ok(c / n > 0.3 && c / n < 0.97, 'each comes and goes: ' + (c / n).toFixed(2));
});

test('the summits that fly banners are the tallest, sharpest ones in view, well apart, and never one hidden behind a ridge', () => {
  const h = load(RENDER_FILES);
  const r = new h.LE.Renderer({}, h.LE.config);
  r.w = 3840;
  r.h = 1080;
  r.floatTargets = true;
  r.gl = { FRAMEBUFFER: 0, bindFramebuffer() {} };
  const D = Math.PI / 180;
  const at = (deg, km) => [Math.sin(deg * D) * km, Math.cos(deg * D) * km];
  // a made-up range: cones on a high plain, and a long ridge in front of one of them
  const cones = [
    { p: at(0, 25), top: 8.6, slope: 1.3, name: 'sharp, middle' },
    { p: at(30, 20), top: 8.9, slope: 1.2, name: 'sharp, right' },
    { p: at(4, 30), top: 7.6, slope: 1.2, name: 'too near the middle one' },
    { p: at(-40, 22), top: 8.1, slope: 1.1, name: 'sharp, left' },
    { p: at(-20, 38), top: 7.8, slope: 1.3, name: 'behind the ridge' },
    { p: at(55, 26), top: 6.8, slope: 0.15, name: 'a dome' },
  ];
  const ground = (x, z) => {
    const r0 = Math.hypot(x, z), a = Math.atan2(x, z) / D;
    let y = 3.5;
    if (a > -27 && a < -13 && r0 > 11 && r0 < 21) y = 5.9; // the ridge
    for (const c of cones) y = Math.max(y, c.top - c.slope * Math.hypot(x - c.p[0], z - c.p[1]));
    return y - (r0 * r0) / (2 * 6371);
  };
  r._groundHeights = (pts, w, hh) => Float32Array.from({ length: w * hh }, (_, i) => ground(pts[i * 2], pts[i * 2 + 1]));
  r._findPeaks();
  const got = Array.from(r.peaks, (p) => cones.find((c) => Math.hypot(p.x - c.p[0], p.z - c.p[1]) < 0.06));
  assert.ok(got.every(Boolean), 'each found on a real summit, within 60 m');
  assert.deepEqual(got.map((c) => c.name).sort(), ['sharp, left', 'sharp, middle', 'sharp, right']);
  for (const p of r.peaks) near(p.y, ground(p.x, p.z), 1e-5, 'at the height of the land there');
});

// ---------------------------------------------------------------- snow on the tree, and the demo
const treeSnow = (s, cfg) => {
  const x = (cfg.render.cameraAltitude - (s.snowLine - 0.18)) / 0.46;
  const k = Math.min(1, Math.max(0, x));
  return k * k * (3 - 2 * k); // as foreground.js works out uSnowTree (before its 0.92)
};

test('snow falling here settles on the tree and the rock within a quarter of an hour, in any season', () => {
  for (const date of ['2026-01-15T06:00:00Z', '2026-03-20T06:00:00Z', '2026-10-25T06:00:00Z']) {
    const { env, advance, cfg, LE } = newEnv();
    const when = new Date(date);
    let t = 0;
    const run = (seconds) => {
      for (let i = 0; i < seconds / 5; i++) env.update(when, 5, (t += 5));
      return env.state;
    };
    env.setWeather(LE.weatherPresets.clear, 'live');
    run(5);
    assert.ok(treeSnow(env.state, cfg) < 0.05, date + ': green before');
    env.setWeather(LE.weatherPresets.snow, 'live');
    assert.ok(treeSnow(run(240), cfg) < 0.5, date + ': still settling after 4 minutes');
    assert.ok(treeSnow(run(1200), cfg) > 0.9, date + ': white after 24 minutes (it stayed green in a snowfall outside deep winter)');
    env.setWeather(LE.weatherPresets.clear, 'live');
    assert.ok(treeSnow(run(1800), cfg) > 0.9, date + ': and stays a while after the snow stops');
    void advance;
  }
  const tree = readSrc('engine/shaders/tree.js');
  assert.ok(tree.includes('float lodged = smoothstep(-0.05 + 0.25 * vr, 0.45 + 0.2 * vr, n.y);'), 'on every leaf that faces up at all, more on some');
});

test('snow falls only where it snows: a whole year of Dhaka weather never brings it, and the summits keep theirs', () => {
  const { env, cfg } = newEnv();
  // Dhaka through the year as the weather service gives it: winter fog and rain at 12 to 15 degrees, the monsoon
  const dhaka = [
    ['2026-01-10T01:00:00Z', { code: 45, cloud: 20, humidity: 98, visibility: 400, windSpeed: 4, windDir: 320, precip: 0, temp: 12 }],
    ['2026-01-20T08:00:00Z', { code: 61, cloud: 100, humidity: 90, visibility: 6000, windSpeed: 9, windDir: 320, precip: 0.8, temp: 14 }],
    ['2026-02-05T08:00:00Z', { code: 80, cloud: 85, humidity: 80, visibility: 9000, windSpeed: 12, windDir: 300, precip: 1.2, temp: 15 }],
    ['2026-04-20T10:00:00Z', { code: 95, cloud: 100, humidity: 88, visibility: 4000, windSpeed: 40, windDir: 310, precip: 9, temp: 27 }],
    ['2026-07-15T06:00:00Z', { code: 65, cloud: 100, humidity: 97, visibility: 2500, windSpeed: 20, windDir: 160, precip: 12, temp: 28 }],
    ['2026-12-25T02:00:00Z', { code: 51, cloud: 90, humidity: 96, visibility: 1500, windSpeed: 3, windDir: 330, precip: 0.1, temp: 13 }],
  ];
  let t = 0;
  for (const [date, rec] of dhaka) {
    env.setWeather(rec, 'live');
    for (let i = 0; i < 400; i++) env.update(new Date(date), 5, (t += 5));
    const s = env.state;
    assert.equal(s.weather.snow, 0, date + ': no snow falls');
    assert.ok(env.freshSnow < 1e-6, date + ': none lies');
    assert.ok(treeSnow(s, cfg) < 1e-6, date + ': the tree stays green');
    assert.ok(s.snowLine >= 3.85 && s.snowLine <= 5.05, date + ': the high peaks keep their snow, as the Himalaya does');
  }
  // and the rule itself: snow only from a snow report, or rain below freezing where you are
  const env2 = readSrc('engine/environment.js');
  assert.ok(env2.includes('const isSnow = snowCode || (precipI > 0 && temp < 0.5 && !rainCode);'));
});

test('the demo plays a year in two minutes: every month in order, its own hours racing by, a dip between them', () => {
  const h = load(['services/demo.js']);
  const Demo = h.LE.Demo;
  const d = new Demo();
  assert.ok(Demo.length >= 100 && Demo.length <= 125, 'about two minutes: ' + Demo.length);
  d.start(0, 2027);
  const months = [];
  const summoned = new Set();
  let lastNow = null;
  let dips = 0;
  for (let ms = 0; ms < Demo.length * 1000; ms += 50) {
    const s = d.step(ms);
    if (s.changed) {
      months.push(s.now.getMonth() + 1);
      lastNow = null;
    }
    if (lastNow) assert.ok(s.now >= lastNow, 'the clock only runs forward within a month');
    lastNow = s.now;
    s.summons.forEach((k) => summoned.add(k));
    if (s.dip > 0.99) dips++;
    if (s.share > 0.2 && s.share < 0.8) assert.equal(s.dip, 0, 'clear in the middle of a month');
  }
  assert.deepEqual(months, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  assert.ok(dips >= 11, 'dark at the change of each month');
  // October's night runs through midnight into the next morning
  const oct = new Demo();
  oct.start(0, 2027);
  const end = oct.step((9 * Demo.CHAPTER_S + Demo.CHAPTER_S * 0.99) * 1000).now;
  assert.equal(end.getMonth(), 9);
  assert.equal(end.getDate(), 22);
  assert.ok(end.getHours() === 4, 'just before half past four: ' + end.getHours());
  // all that goes on in the year, called up once each time round
  for (const k of ['geese', 'flock', 'meteor', 'satellite', 'raptor', 'mist', 'fire', 'smoke', 'bus']) assert.ok(summoned.has(k), 'calls up ' + k);
  // and every kind of weather, by day and by night
  const codes = new Set(Demo.CHAPTERS.flatMap((c) => [c.weather.code, c.then && c.then[1].code]).filter((c) => c != null));
  for (const [what, code] of [['snow', 73], ['clear', 0], ['fog', 45], ['thunderstorm', 95], ['rain', 63], ['partly cloudy', 2]]) assert.ok(codes.has(code), what);
  const hours = Demo.CHAPTERS.map((c) => +c.from.split(':')[0]);
  assert.ok(hours.some((x) => x < 7) && hours.some((x) => x >= 18), 'sunrises and nights');
  // round again after December
  const again = d.step(Demo.length * 1000 + 100);
  assert.ok(again.changed && again.pass === 1 && again.now.getMonth() === 0, 'and over again');
});

test('in the demo the land wets, whitens and thaws within a month, and banner clouds fly in its windy months', () => {
  const h = load(['config.js', 'services/astronomy.js', 'engine/environment.js', 'services/demo.js']);
  const env = new h.LE.Environment(h.LE.config);
  const cfg = h.LE.config;
  cfg.atmosphere.transitionSeconds = 4; // as main.js sets them for the demo
  env.pace = 120;
  const demo = new h.LE.Demo();
  demo.start(0, 2027);
  const seen = {};
  let t = 0;
  for (let ms = 0; ms < h.LE.Demo.length * 1000; ms += 100) {
    const s = demo.step(ms);
    if (s.changed || s.weatherChanged) env.setWeather(s.weather, 'preview');
    if (s.changed) env.w = null;
    const st = env.update(s.now, 0.1, (t += 0.1));
    if (s.changed) {
      env.wet = s.wet;
      env.freshSnow = s.snow;
    }
    const m = s.now.getMonth() + 1;
    const k = `${m}@${s.share < 0.1 ? 'start' : s.share > 0.9 ? 'end' : 'mid'}`;
    seen[k] = { tree: treeSnow(st, cfg), wet: st.weather.wet, banner: st.weather.banner, flash: Math.max(seen[k] ? seen[k].flash : 0, st.weather.flash) };
  }
  assert.ok(seen['1@start'].tree < 0.2 && seen['1@end'].tree > 0.9, 'January: the tree goes white as the snow settles');
  assert.ok(seen['2@mid'].tree > 0.9, 'February: still white with fresh snow');
  assert.ok(seen['3@mid'].tree < 0.05 && seen['3@mid'].banner > 0.8, 'March: green again, banner clouds');
  assert.ok(seen['6@mid'].flash > 0 || seen['6@end'].flash > 0, 'June: lightning');
  assert.ok(seen['7@mid'].wet > 0.9, 'July: wet');
  assert.ok(seen['8@mid'].banner > 0.8, 'August: banner clouds');
  assert.ok(seen['12@end'].tree > 0.6, 'December: snow settling at dusk');
});

test('the demo can be played from the app, from Lively and from the address, and is never saved', () => {
  assert.equal(load(['config.js']).LE.config.demo, false, 'off to start with');
  assert.equal(load(['config.js'], { search: '?demo=1' }).LE.config.demo, true, 'on from the address');
  const lively = JSON.parse(readFileSync(new URL('../LivelyProperties.json', import.meta.url), 'utf8'));
  assert.equal(lively.demo.type, 'checkbox');
  assert.equal(lively.demo.value, false);
  const main = readSrc('main.js');
  assert.ok(main.includes("case 'demo':") && main.includes('setDemo(!!cfg.demo)'), 'the page follows it');
  assert.ok(readSrc('services/host.js').includes("demo: [c.demo, 'demo'],"), 'the app passes it on');
  const cs = readFileSync(new URL('../host/LivingEarthHost.cs', import.meta.url), 'utf8');
  assert.ok(cs.includes('js.Append(", demo: ").Append(demo ? "true" : "false");'), 'in state.js');
  assert.ok(cs.includes('"Play the demo: a year in two minutes"') && cs.includes('Text = "Watch the demo"'), 'in the tray menu and the setup window');
  assert.ok(!cs.includes('"demo="'), 'not saved: the next start is the real time and weather');
  assert.ok(readFileSync(new URL('../index.html', import.meta.url), 'utf8').includes('src/services/demo.js'), 'on the page');
});

test('banner clouds are drawn in the volume pass between the mist and the deck, in front of cloud beyond them', () => {
  const vol = readSrc('engine/shaders/volume.js');
  const main = vol.slice(vol.indexOf('void main()'));
  const banner = main.indexOf('// ---------------- banner clouds on the high summits');
  assert.ok(main.indexOf('// ---------------- mist & fog') < banner && banner < main.indexOf('// ---------------- clouds ----'), 'after the mist, before the deck');
  // laid into the deck where the ray meets them, or after it when no deck cloud lies in front
  assert.ok(/if \(s > sB\) \{[^}]*L \+= T \* Lb;\s*T \*= Tb;\s*sB = 1e9;/.test(main), 'into the deck at their distance');
  assert.ok(/if \(sB < 1e8\) \{[^}]*L \+= T \* Lb;\s*T \*= Tb;/.test(main), 'or after it');
  // the cloud stays at the summit while the air flows through it, drawn out along the wind in its own frame; the flow
  // wraps at 2 km, where its noise repeats along the wind (0.5 and 1.0 per km), so the wrap never shows
  assert.ok(vol.includes('vec3 q = vec3((l.x - uBannerFlow.x) * 0.5, (l.y + uBannerFlow.y) * 2.2, l.z * 1.6) + B.w;'), 'lumps drawn out along the wind, flowing through and turning over');
  assert.ok(vol.includes('q * vec3(2.0, 3.2, 3.2) + 0.37'), 'its wisps too');
  for (const k of [0.5, 0.5 * 2.0]) assert.ok(Math.abs(2 * k - Math.round(2 * k)) < 1e-9, 'the flow wraps unseen: ' + k);
  const R = readSrc('engine/renderer.js');
  assert.ok(vol.includes('float st = textureLod(uNoise3D, vec3(l.z * 2.4 + B.w, (l.y + uBannerFlow.y) * 3.0, fc * 0.35 + B.w * 0.7), 0.0).b;'), 'streaks along the wind');
  for (const k of [3.0, 2.2, 2.2 * 3.2]) assert.ok(Math.abs(25 * k - Math.round(25 * k)) < 1e-9, 'the turning over wraps unseen: ' + k);
  // They move at the wind's speed however seldom a scene is drawn: at rest that is every 2 s, and with only 1 s
  // counted of each they crept and looked stuck
  const cfgB = load(['config.js']).LE.config;
  const rb = new (load(RENDER_FILES).LE.Renderer)({}, cfgB);
  const sent = {};
  const prog = { set: (k, v) => (sent[k] = v) };
  const flowAfter = (step, seconds, kmh = 36) => {
    rb._bannerT = null;
    rb._bannerFlow = rb._bannerChurn = 0;
    for (let t = 0; t <= seconds + 1e-9; t += step) rb._bannerUniforms(prog, { time: t, weather: { banner: 0, deckX: kmh, deckZ: 0 } });
    return Array.from(sent.uBannerFlow);
  };
  const smooth = flowAfter(0.05, 60);
  const rest = flowAfter(2, 60);
  near(smooth[0], 0.6, 1e-6, '36 km/h: 600 m in a minute');
  near(rest[0], smooth[0], 1e-6, 'the same with a scene every 2 s');
  near(rest[1], 60 * 0.004, 1e-6, 'and it has turned over as far');
  // its outline moves too: a wave a whole number of times per 2 km of flow runs down it, so the wrap does not show
  assert.ok(vol.includes('float wave = sin(6.2831853 * (l.x - uBannerFlow.x) + B.w * 6.2831853);') && vol.includes('float wave2 = sin(6.2831853 * 1.5 * (l.x - uBannerFlow.x) + B.w * 17.0 + 1.3);'), 'it waves like a flag');
  assert.ok(flowAfter(0.05, 60, 0)[1] > 0.1 && flowAfter(0.05, 60, 0)[0] === 0, 'in still air it does not stream, but still turns over');
  assert.ok(flowAfter(300, 300)[0] <= 0.3 + 1e-9, 'a long gap moves it on by 30 s at most');
  cfgB.atmosphere.cloudSpeed = 4;
  near(flowAfter(2, 60)[0], (0.6 * 4) % 2, 1e-6, 'four times as fast with the cloud speed at 4, as the deck');
});

// ---------------------------------------------------------------- quality governor
function newGovernor() {
  const h = load(['engine/quality.js']);
  let now = 0;
  h.ctx.performance = { now: () => now };
  const set = [];
  const g = new h.LE.QualityGovernor({ setQuality: (q) => set.push(q.name) }, 'auto');
  const run = (seconds, intervalMs, targetMs, gpuMs) => {
    for (let i = 0; i < (seconds * 1000) / intervalMs; i++) {
      now += intervalMs;
      g.sample(intervalMs, targetMs, gpuMs);
    }
  };
  return { g, run, set };
}

test('quality climbs back after a slow patch when the GPU has headroom', () => {
  const { g, run } = newGovernor();
  run(10, 100, 50, 40); // late frames
  assert.equal(g.level, 0, 'dropped to eco');
  run(120, 50, 50, 10); // calm and cheap
  assert.equal(g.level, 2, 'climbed back up, as far as high');
});

test('quality stays down while the GPU has no headroom', () => {
  const { g, run } = newGovernor();
  run(10, 100, 50, 40);
  run(300, 50, 50, 30);
  assert.equal(g.level, 0);
});

test('without a GPU timer it retries the default level, then waits longer after a failed try', () => {
  const { g, run } = newGovernor();
  run(10, 100, 50, 0);
  assert.equal(g.level, 0);
  run(200, 50, 50, 0);
  assert.equal(g.level, 0, 'not yet');
  run(150, 50, 50, 0);
  assert.equal(g.level, 1, 'tried again after about 5 minutes');
  run(10, 100, 50, 0); // the try failed
  assert.equal(g.level, 0);
  run(400, 50, 50, 0);
  assert.equal(g.level, 0, 'now waits about 10 minutes');
  run(250, 50, 50, 0);
  assert.equal(g.level, 1);
  run(3600, 50, 50, 0);
  assert.equal(g.level, 1, 'never climbs above the default without a timer');
});

test('after a long sleep the scene jumps straight to the current weather', () => {
  const { env } = settledOn(CLEAR);
  env.setWeather(RAIN, 'live');
  env.update(new Date('2026-11-03T06:00:00Z'), 60, 100);
  near(env.state.weather.rain, 0.6, 0.001, 'rain');
  assert.ok(env.state.weather.coverage > 0.9);
});

// ---------------------------------------------------------------- the tree and the falling leaves
function newForeground() {
  const h = load(['engine/gl.js', 'engine/foreground.js']);
  // a WebGL stand-in: every call is a no-op (nothing here draws)
  const gl = new Proxy({}, { get: (o, k) => (k in o ? o[k] : () => ({})) });
  const hfov = (140 * Math.PI) / 180;
  const view = { w: 3840, h: 1080, hfov, pxAng: hfov / 3840, horizonY: 0.34, camY: 2.8 };
  const a = (-0.88 * hfov) / 2;
  const renderer = {
    gl,
    vao: {},
    cfg: { render: { tree: true, seed: 1, cameraAltitude: 2.8 } },
    treeSite: () => [Math.sin(a) * 13.5, -2.15, Math.cos(a) * 13.5, 2.4],
    viewInfo: () => view,
  };
  const fg = new h.LE.Foreground(renderer);
  fg.resize(view.w, view.h);
  const run = (seconds, kmh, dir, season = [0, 1, 0, 0], doy = 310) => {
    const st = { time: 0, treeKmh: kmh, gustDir: dir, season, astro: { dayOfYear: doy } };
    for (let t = 0; t <= seconds; t += 1 / 30) {
      st.time = t;
      fg.update(st);
    }
    return fg;
  };
  return { ...h, fg, run };
}

test('the tree grows the same from the same seed, and differently from another', () => {
  const { LE } = load(['engine/gl.js', 'engine/foreground.js']);
  const a = LE.growTree(7936, [-0.8, 0, 0.6]);
  const b = LE.growTree(7936, [-0.8, 0, 0.6]);
  const c = LE.growTree(42, [-0.8, 0, 0.6]);
  assert.deepEqual(a.leaves, b.leaves);
  assert.deepEqual(a.bark, b.bark);
  assert.notDeepEqual(a.leaves.subarray(0, 50), c.leaves.subarray(0, 50));
});

// A run of the tree's wind: its top's movement downwind, and each limb swing, sampled 30 times a second
function windRun(LE, kmh, seconds = 300, dt = 1 / 30) {
  const tw = new LE.TreeWind();
  const str = Math.min(Math.pow(kmh / 30, 0.8), 2.4);
  const lean = [];
  const limbs = [[], [], [], []];
  for (let t = 0; t < seconds; t += dt) {
    tw.step(dt, str, kmh, 0, 8);
    lean.push(tw.lean[0]);
    for (let i = 0; i < 4; i++) limbs[i].push(tw.limbs[i * 2 + 1]);
  }
  return { tw, lean, limbs };
}
const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
const spread = (a) => Math.sqrt(mean(a.map((v) => (v - mean(a)) ** 2)));
function correlation(a, b) {
  const ma = mean(a);
  const mb = mean(b);
  let ab = 0;
  let aa = 0;
  let bb = 0;
  for (let i = 0; i < a.length; i++) {
    ab += (a[i] - ma) * (b[i] - mb);
    aa += (a[i] - ma) ** 2;
    bb += (b[i] - mb) ** 2;
  }
  return ab / Math.sqrt(aa * bb);
}

test('still air leaves the tree still, and stronger wind moves it more', () => {
  const { LE } = load(['engine/gl.js', 'engine/foreground.js']);
  const still = windRun(LE, 0, 60);
  assert.ok(Math.max(...still.lean.map(Math.abs)) < 1e-6, 'no movement in still air');
  const light = windRun(LE, 7);
  const strong = windRun(LE, 35);
  assert.ok(spread(light.lean) > 0.005, `a light breeze shows (${spread(light.lean)})`);
  assert.ok(mean(strong.lean) > mean(light.lean) * 2, 'it leans further in a stronger wind');
  assert.ok(spread(strong.lean) > spread(light.lean) * 2, 'and swings more');
});

test('each limb of the tree swings in its own way, follows the trunk, and the setting for wind in the trees moves this tree too', () => {
  const { LE } = load(['engine/gl.js', 'engine/foreground.js']);
  const T = LE.growTree(7936, [-0.8, 0, 0.6]);
  // the 16 limbs: each its own mix of the four swings and side (they went in three groups, one to a leader)
  const phases = new Set(T.branches.filter((b) => b.level === 2 && !b.snag).map((b) => b.nodes[0].w[1].toFixed(4)));
  assert.ok(phases.size >= 16, 'limbs with a swing of their own: ' + phases.size);
  const move = LE.Foreground.windMoved;
  const limbs = new Float32Array([0.05, 0.02, -0.03, 0.04, 0.02, -0.05, 0.04, 0.01]);
  const moved = new Set([...phases].map((ph) => move([0, 4, 0], [1, +ph, 0, 0], [1, 0, 0], [0, 0], limbs, 6).map((x) => x.toFixed(3)).join(',')));
  assert.ok(moved.size >= 14, 'and they are moved differently by the same wind: ' + moved.size + ' ways');
  // the limbs are left behind when the trunk starts to move: a sudden wind swings them more than a steady one, and
  // nothing goes past its limit
  const run = (follow) => {
    const w = new LE.TreeWind();
    let most = 0;
    for (let k = 0; k < 600; k++) {
      w.step(1 / 30, k < 300 ? 0.1 : 2.2, k < 300 ? 3 : 70, 0, 6);
      if (k >= 300 && k < 360) for (let i = 0; i < 8; i++) most = Math.max(most, Math.abs(w.limbs[i]));
      assert.ok(Math.abs(w.lean[0]) <= 0.6 + 1e-9 && w.limbs.every((x) => Math.abs(x) <= 0.12 + 1e-9), 'within its limits');
    }
    return most;
  };
  assert.ok(run() > 0.01, 'the limbs swing when a gust arrives');
  assert.ok(readSrc('engine/foreground.js').includes('- LIMB_FOLLOW * trunkA[0]) * h;'), 'and feel the trunk under them');
  // the setting
  const fg = Object.create(LE.Foreground.prototype);
  const st = (scale) => fg._wind({ treeKmh: 20, treeDir: [1, 0], treeScale: scale }).str;
  assert.ok(st(0) === 0 && st(2) > st(1) * 1.9 && st(3) <= 2.4 && st(undefined) === st(1), 'off, natural, doubled, and never past a storm');
  assert.ok(readSrc('engine/environment.js').includes('s.treeScale = trees;'));
  // the leaf shadow on the rock sways the way the tree itself leans now
  assert.ok(readSrc('engine/shaders/composite.js').includes('vec3(uTreeDir.x, 0.0, uTreeDir.y) * uTreeSwayT'));
  assert.ok(readSrc('engine/renderer.js').includes("p.set('uTreeDir', state.treeDir || state.gustDir);"));
});

test('the waves of swaying crowns on the hills run at the speed of the gusts', () => {
  const { LE } = load(['config.js', 'services/astronomy.js', 'engine/environment.js']);
  const rate = LE.Environment.swayRate;
  // 100 and 70 rad per km in the picture: a wave moves at rate / that
  const speed = (kmh) => (rate(kmh)[0] / 100) * 1000; // m/s
  near(speed(36), (36 * 1.4) / 3.6, 1e-6, 'at 36 km/h the wave runs at 14 m/s, the speed of the gusts');
  near(speed(60), (60 * 1.4) / 3.6, 1e-6, 'and faster in more wind');
  assert.ok(rate(0)[0] >= 2 * Math.PI * 0.12 - 1e-9 && rate(200)[0] <= 2 * Math.PI * 0.6 + 1e-9, 'never slower than a tree swings by itself, never a blur');
  assert.ok(rate(36)[1] < rate(36)[0], 'the second wave slower than the first');
  const sh = readSrc('engine/shaders/composite.js');
  assert.ok(sh.includes('sin(uTreeSway.x - wc.x * 100.0 + id * 0.6)') && sh.includes('sin(uTreeSway.y - wc.x * 70.0 + id * 1.4)'), 'the picture still spaces them so');
  assert.ok(readSrc('engine/environment.js').includes('const swayRate = LE.Environment.swayRate(treeKmh);'));
});

test('the outlines of the trees on the near hills move with the wind: edge pixels only, by as much as a crown really moves', () => {
  const sh = readSrc('engine/shaders/composite.js');
  const main = sh.slice(sh.lastIndexOf('void main() {'));
  assert.ok(main.includes('if (uWindAmt > 0.001 && uMeter == 0 && uGrassOnly == 0 && uDebugView == 0) col = swayEdge(col, ic, rd, g0);'), 'not in still air, nor when metering');
  const fn = sh.slice(sh.indexOf('vec3 swayEdge('), sh.lastIndexOf('void main() {'));
  assert.ok(fn.includes('if (t > LEDGE_T_KM && t < 3.5 && texelFetch(uG1, ic, 0).a > 0.5) {'), 'crowns within 3.5 km');
  assert.ok(fn.includes('if (gn.z > 0.0 && gn.z < t * 1.2 + 0.03) return col;') && fn.includes('if (t > 0.0 && t < tn * 1.2 + 0.03) continue;'), 'only against something much further off');
  assert.equal(fn.split('landOrSky(').length - 1, 2, 'a second look only on those edges');
  assert.ok(fn.includes('float perKm = proj * 0.0008 / pixelAngle();'), '0.8 m at a full swing');
  // on a 3840 px picture 110 degrees wide: under a pixel from a kilometre in a strong wind, never more than one
  const pa = (110 * Math.PI / 180) / 3840;
  const px = (swing, km) => Math.abs(swing * 0.0008 / pa / km);
  assert.ok(px(1, 1) > 1 && px(1, 1) < 2 && px(1, 3.4) > 0.3 && px(1, 3.4) < 0.6 && px(0.01, 1.6) < 0.03, 'a pixel or so: ' + px(1, 1).toFixed(2) + ' at 1 km');
  assert.equal(fn.split('min(abs(d), 1.0)').length - 1, 2, 'and the blend never goes further than the pixel beside it');
  // it leans where the light on it says it leans: the same sums as shadeTerrain
  const swing = sh.slice(sh.indexOf('float crownSwing('), sh.indexOf('vec3 swayEdge('));
  for (const line of ['textureLod(uNoise2D, a * vec2(1.6, 0.4), 2.0).r * 0.65 + textureLod(uNoise2D, b * vec2(1.0, 0.3) + 0.37, 2.0).g * 0.35', 'sin(uTreeSway.x - wc.x * 100.0 + id * 0.6) * 0.6 + sin(uTreeSway.y - wc.x * 70.0 + id * 1.4) * 0.4', '(0.15 + 0.6 * max(gust, 0.0))']) {
    assert.ok(swing.includes(line) && sh.slice(sh.indexOf('vec3 shadeTerrain('), sh.indexOf('vec3 aerial(')).includes(line), line);
  }
});

test('early and late the valley mist lies in the shade of the ridges, and its thin edges do not glow', () => {
  const vol = readSrc('engine/shaders/volume.js');
  assert.ok(vol.includes('float shadeLine = 3.2 - 5.0 * uSunDir.y / max(sqrt(1.0 - uSunDir.y * uSunDir.y), 0.05);'));
  assert.ok(vol.includes('shS *= smoothstep(-0.35, 0.35, p.y - shadeLine);') && vol.includes('shS *= mix(1.0, smoothstep(0.0, 0.3, sig), lowSun * 0.75);'));
  // the line: how high the shade of ridges 3.2 km high and 5 km off reaches with the sun at this height
  const line = (deg) => 3.2 - 5 * Math.tan((deg * Math.PI) / 180);
  const lit = (y, deg) => { const t = Math.min(Math.max((y - line(deg) + 0.35) / 0.7, 0), 1); return t * t * (3 - 2 * t); };
  // the mist lies between 0.5 and about 2.3 km
  assert.ok(lit(2.3, 5) < 0.02 && lit(1.0, 5) === 0, 'just after sunrise all of it is in shade');
  assert.ok(lit(2.3, 15) > 0.9 && lit(1.0, 15) === 0, 'at 15 degrees the sun is on its top, not in the valley floor');
  assert.ok(lit(0.6, 30) > 0.8 && lit(0.5, 40) === 1, 'by mid-morning on all of it');
});

test('a wet road is dark and glossy: the sky shows in it by day, and the lamps of what drives on it by night', () => {
  const sh = readSrc('engine/shaders/composite.js');
  assert.ok(sh.includes('float road = wet > 0.01 && !ledge && t < 9.0 ? onRoad(pos.xz) * (1.0 - canopy) * wet : 0.0;'), 'only when wet, on the road, not under trees');
  assert.ok(sh.includes('alb *= 1.0 - 0.35 * road;') && sh.includes('float rough = mix(mix(mix(0.7, 0.25, wet), 0.12, road), 0.42, snow);'), 'darker and smoother than wet ground; snow covers it');
  assert.ok(sh.includes('spec += mix(skyLUT(normalize(up2)), cloudAmb / PI, uOvercast) * fr * road * 0.7;'), 'the sky in it');
  const sp = readSrc('engine/shaders/sprites.js');
  assert.ok(sp.includes('if (uWet > 0.01 && cone > -1.5) {') && sp.includes('float glint = pow(max(dot(N, hv), 0.0), 120.0) * smoothstep(0.0, 0.3, ax);'), 'a headlight shows in it as a streak; a flashing lamp does not');
  for (const s2 of [sh, sp]) assert.ok(s2.includes('return 1.0 - smoothstep(0.0025, 0.004, length(textureLod(uRoadMap, uv, 0.0).xy));'), 'the road is 3.5 m to its edge, as in the bake');
  assert.ok(readSrc('engine/shaders/bake.js').includes('float halfW = 0.0035;'));
  const R = readSrc('engine/renderer.js');
  assert.ok(R.includes('...this._roadUniforms(p), // the wet road shines') && R.includes('...this._roadUniforms(p), // lamps show in a wet road') && R.includes("p.set('uWet', w.wet);"));
});

test('prayer flags hang on a line from the trunk to a stake, in the five colours in their order, and move with the wind', () => {
  const { LE } = load(['engine/gl.js', 'engine/foreground.js']);
  const T = LE.growTree(7936, [-0.8, 0, 0.6]);
  const F = LE.buildFlags(T, [-1, 0, 0], [0, 0, -1]);
  assert.ok(F.count >= 8 && F.count <= 14, F.count + ' flags');
  const V = 13;
  const rows = [];
  for (let i = 0; i < F.verts; i++) rows.push(Array.from(F.data.subarray(i * V, i * V + V)));
  const cloth = rows.filter((r) => r[6] === 5);
  const wood = rows.filter((r) => r[6] === 0);
  assert.equal(cloth.length, F.count * 5 * 6 * 6, 'each flag 5 by 6 squares, so waves can run down it and its top edge bends with the line');
  // blue, white, red, green, yellow, and round again
  const colourOf = (r) => r.slice(7, 10).map((x) => x.toFixed(2)).join(',');
  const order = [];
  for (const r of cloth) if (order[order.length - 1] !== colourOf(r)) order.push(colourOf(r));
  assert.equal(order.length, F.count, 'one colour to a flag');
  for (let i = 5; i < order.length; i++) assert.equal(order[i], order[i - 5], 'the same five in the same order');
  const [blue, white, red, green, yellow] = order.slice(0, 5).map((c) => c.split(',').map(Number));
  assert.ok(blue[2] > blue[0] * 3 && white[0] > 0.6 && red[0] > red[1] * 5 && green[1] > green[0] * 3 && yellow[0] > yellow[2] * 5 && yellow[1] > 0.3, order.slice(0, 5).join(' | '));
  // the line: tied to the trunk's own wood about 2.5 m up, down to a stake 3.7 m off that starts under the ground
  const trunk = T.branches.find((b) => b.level === 0);
  const tie = trunk.nodes.reduce((a, b) => (Math.abs(b.p[1] - 2.5) < Math.abs(a.p[1] - 2.5) ? b : a));
  near(Math.hypot(F.from[0] - tie.p[0], F.from[2] - tie.p[2]), tie.r, 1e-6, 'on the bark');
  assert.ok(Math.abs(F.from[1] - 2.5) < 0.5 && F.top[1] > 1.5 && F.top[1] < F.from[1], 'sloping down from the tree');
  near(Math.hypot(F.top[0], F.top[2]), Math.hypot(3.6, 0.8), 1e-6, 'the stake 3.7 m from the foot of the tree');
  assert.ok(Math.min(...wood.map((r) => r[1])) < -0.5, 'the stake goes into the ground');
  // every flag hangs from the line, between the trunk and the stake, and none reaches the ground hanging straight
  const along = (p) => ((p[0] - F.from[0]) * (F.top[0] - F.from[0]) + (p[2] - F.from[2]) * (F.top[2] - F.from[2])) / ((F.top[0] - F.from[0]) ** 2 + (F.top[2] - F.from[2]) ** 2);
  for (const r of cloth) {
    const t = along(r);
    assert.ok(t > 0.03 && t < 0.97, 'between the two');
    const straight = F.from[1] + (F.top[1] - F.from[1]) * t;
    assert.ok(r[1] <= straight + 1e-6 && r[1] > straight - 0.41, 'on the sagging line');
    assert.ok(r[1] - 0.36 > 0.9, 'clear of the ground');
    assert.ok(Math.abs(r[3]) <= 0.135 + 1e-6 && r[4] >= 0 && r[4] <= 0.36 + 1e-6);
  }
  assert.ok(F.lo[0] <= Math.min(...rows.map((r) => r[0])) - 0.36 + 1e-5 && F.hi[1] >= Math.max(...rows.map((r) => r[1])), 'the tree picture has room for them blown out');
  // the cloth, worked out as the shader does: hanging straight in still air, lifted by the wind across the line,
  // dragged by the wind along it, and its waves running downwind
  const sh = readSrc('engine/shaders/tree.js');
  assert.ok(sh.includes('float lift = blow * abs(across);') && sh.includes('float run = x * along + d * sqrt(max(1.0 - along * along, 0.0));') &&
    sh.includes('float wave = sin(uFlutter * 9.0 + phase - run * 14.0) * 0.6 + sin(uFlutter * 15.0 + phase * 1.7 - run * 23.0) * 0.3;') &&
    sh.includes('float rock = 0.22 * min(uWindStr, 1.5) * abs(along) * osc(1.3, phase);') &&
    sh.includes('float a = lift + ropeSwing * sign(across) + rock + wave * 0.45 * min(uWindStr * 2.0, 1.0) * (1.0 + 0.6 * abs(along)) * (d / 0.36);') &&
    sh.includes('return (out1 * sin(a) - vec3(0.0, 1.0, 0.0) * cos(a) + T * (along * 0.35 * min(blow, 1.0))) * d;') &&
    sh.includes('return rope(t) + cloth(T, x, d, phase, gust);'));
  // the shader's clock: whole cycles in 2400 s (tree.js osc)
  const osc = (w, ph, clock) => Math.sin(Math.floor((w * 2400) / (2 * Math.PI) + 0.5) * ((2 * Math.PI) / 2400) * clock + ph);
  // [along the line, level across it, up]; the wind blows at the angle dir to the line (0 = along it)
  const waveAt = (x, d, clock, dir) => {
    const along = Math.cos(dir);
    const run = x * along + d * Math.sqrt(Math.max(1 - along * along, 0));
    return Math.sin(clock * 9 - run * 14) * 0.6 + Math.sin(clock * 15 - run * 23) * 0.3;
  };
  const clothAt = (x, d, str, gust, clock, dir) => {
    const along = Math.cos(dir);
    const across = Math.sin(dir);
    const blow = Math.min(Math.max(str * (0.55 + 0.35 * gust), 0), 1.35);
    const rock = 0.22 * Math.min(str, 1.5) * Math.abs(along) * osc(1.3, 0, clock);
    const a = blow * Math.abs(across) + rock + waveAt(x, d, clock, dir) * 0.45 * Math.min(str * 2, 1) * (1 + 0.6 * Math.abs(along)) * (d / 0.36);
    return [x + along * 0.35 * Math.min(blow, 1) * d, (across < 0 ? -1 : 1) * Math.sin(a) * d, -Math.cos(a) * d];
  };
  const Q = Math.PI / 2;
  assert.deepEqual(clothAt(0, 0.36, 0, 0, 1.7, Q).map((v) => +v.toFixed(12)), [0, 0, -0.36], 'still air: straight down, whatever the clock says');
  assert.ok(clothAt(0, 0.36, 1, 0, 0, Q)[1] > 0.1 && clothAt(0, 0.36, 2.4, 1, 0, Q)[1] > clothAt(0, 0.36, 1, 0, 0, Q)[1], 'blown downwind, further in a gale');
  assert.ok(clothAt(0, 0.36, 1, 0, 0, -Q)[1] < -0.1, 'and to the other side when the wind turns round');
  assert.ok(Math.abs(clothAt(0, 0.36, 1, 0, 0.1, Q)[1] - clothAt(0, 0.36, 1, 0, 0.3, Q)[1]) > 0.01, 'and waving');
  near(Math.hypot(...clothAt(0, 0.2, 1.3, 0.5, 2, Q)), 0.2, 1e-9, 'the cloth does not stretch');
  // a wind along the line cannot lift a flag held along its top: the hem trails downwind
  const hem = clothAt(0, 0.36, 1, 0, 0, 0);
  assert.ok(hem[0] > 0.05 && clothAt(0, 0.36, 1, 0, 0, Math.PI)[0] < -0.05, 'the hem trails the way the wind goes');
  assert.ok(Math.hypot(...hem) < 0.36 * 1.07, 'hardly stretched by it');
  // the waves run downwind through the cloth: what is at one point now is a step further downwind a moment later
  // (the slower wave moves 9 / 14 m a second), and across the wind the cloth moves as one
  const h = 0.005;
  for (const dir of [0, 0.7, Q, 2.4, Math.PI]) {
    const al = Math.cos(dir);
    const k = [al, Math.sqrt(1 - al * al)];
    const slow = (x, d, clock) => Math.sin(clock * 9 - (x * k[0] + d * k[1]) * 14);
    near(slow(0.03 + k[0] * h, 0.2 + k[1] * h, 0.4 + (14 * h) / 9), slow(0.03, 0.2, 0.4), 1e-9, 'downwind, at ' + dir);
    near(waveAt(0.03 - k[1] * h, 0.2 + k[0] * h, 0.4, dir), waveAt(0.03, 0.2, 0.4, dir), 1e-9, 'one crest across the wind, at ' + dir);
  }
  assert.ok(Math.abs(waveAt(0.1, 0.2, 0.4, 0) - waveAt(-0.1, 0.2, 0.4, 0)) > 0.05, 'in a wind along the line the waves cross the flag');
  near(waveAt(0.1, 0.2, 0.4, Q), waveAt(-0.1, 0.2, 0.4, Q), 1e-9, 'in a wind across it they run down it');
  // 2026-11-24 the user: "prayer flag rope is not moving based on wind direction its looks like flags are bindings on
  // rod or stick". The line, worked out as the shader does (tree.js rope()): it hangs between its two ends and the
  // wind across it swings it over downwind like a skipping rope
  assert.ok(sh.includes('float tilt = atan(0.55 * pow(uWindStr, 1.3) * (1.0 + 0.35 * gR) * acrossR);') &&
    sh.includes('ropeSwing = (osc(3.45, 0.0) * 0.7 + osc(5.65, 1.7) * 0.3) * 0.12 * min(uWindStr, 1.5) * abs(acrossR) * (1.0 + 0.4 * gR);') &&
    sh.includes('float ph = tilt + ropeSwing;') && sh.includes('ropeHang = vec3(0.0, -cos(ph), 0.0) + ropeC * sin(ph);') &&
    sh.includes('float ripple = 0.02 * min(uWindStr, 1.5) * osc(4.4, -9.4 * t);') &&
    sh.includes('return mix(uRopeFrom, uRopeTo, t) + ropeHang * (uRopeSag * b + ripple * b) + ropeTie * (1.0 - t);'), 'the line in the shader');
  const fg = readSrc('engine/foreground.js');
  assert.ok(fg.includes("p.set('uRopeFrom', this.flagLine.from);") && fg.includes("p.set('uRopeTo', this.flagLine.top);") && fg.includes("p.set('uRopeSag', this.flagLine.sag);"));
  const chord = [F.top[0] - F.from[0], F.top[1] - F.from[1], F.top[2] - F.from[2]];
  const cLen = Math.hypot(chord[0], chord[2]);
  const C = [-chord[2] / cLen, 0, chord[0] / cLen]; // level, across the line
  const A = [chord[0] / cLen, 0, chord[2] / cLen]; // level, along it
  const ropeAt = (t, W, str, gust, clock) => {
    const across = W[0] * C[0] + W[2] * C[2];
    const tilt = Math.atan(0.55 * Math.pow(str, 1.3) * (1 + 0.35 * gust) * across);
    const swing = (osc(3.45, 0, clock) * 0.7 + osc(5.65, 1.7, clock) * 0.3) * 0.12 * Math.min(str, 1.5) * Math.abs(across) * (1 + 0.4 * gust);
    const ph = tilt + swing;
    const hang = [C[0] * Math.sin(ph), -Math.cos(ph), C[2] * Math.sin(ph)];
    const b = 4 * t * (1 - t);
    const ripple = 0.02 * Math.min(str, 1.5) * osc(4.4, -9.4 * t, clock);
    return [0, 1, 2].map((k) => F.from[k] + chord[k] * t + hang[k] * (F.sag * b + ripple * b));
  };
  const offAt = (p, t) => [0, 1, 2].map((k) => p[k] - (F.from[k] + chord[k] * t)); // from the straight line
  const sideOf = (p, t) => { const o = offAt(p, t); return o[0] * C[0] + o[2] * C[2]; };
  const lengthOf = (W, str, gust, clock) => {
    let l = 0;
    for (let i = 0; i < 64; i++) { const a = ropeAt(i / 64, W, str, gust, clock); const b = ropeAt((i + 1) / 64, W, str, gust, clock); l += Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]); }
    return l;
  };
  const still = lengthOf(C, 0, 0, 0);
  near(F.sag, 0.4, 1e-9, 'a sag of about a tenth of the line');
  // the line as built is the line in still air, whatever the clock
  const line = rows.filter((r) => r[6] === 0 && r[3] === 1);
  assert.equal(line.length, 16 * 6, 'the line: 16 pieces, each knowing where it is along the line');
  for (const clock of [0, 3.3, 517]) {
    for (const r of line) {
      const p = ropeAt(r[5], C, 0, 0, clock);
      near(Math.hypot(p[0] - r[0], p[1] + r[4] - r[1], p[2] - r[2]), 0, 1e-5, 'still air: where it was built');
      near(sideOf(p, r[5]), 0, 1e-9, 'still air: in the upright plane through its ends');
    }
  }
  // the wind across the line pushes its middle over downwind, further in a gale, and the other way round when the
  // wind turns; it swings about that
  const tiltAt = (W, str, gust, clock) => { const o = offAt(ropeAt(0.5, W, str, gust, clock), 0.5); return Math.atan2(o[0] * C[0] + o[2] * C[2], -o[1]) / (Math.PI / 180); };
  for (const clock of [0, 1.1, 2.6, 40]) {
    const breeze = tiltAt(C, 1, 0, clock);
    const gale = tiltAt(C, 2.4, 0.5, clock);
    assert.ok(breeze > 15 && breeze < 42, `a strong breeze across it: ${breeze.toFixed(0)}° over`);
    assert.ok(gale > 45 && gale < 78 && gale > breeze, `a storm: ${gale.toFixed(0)}° over`);
    const back = [-C[0], 0, -C[2]];
    assert.ok(tiltAt(back, 1, 0, clock) < -15 && tiltAt(back, 2.4, 0.5, clock) < -45, 'and over the other way when the wind turns round');
  }
  assert.ok(Math.abs(tiltAt(C, 1, 0, 0.4) - tiltAt(C, 1, 0, 1.3)) > 2, 'it swings');
  // a wind along the line can't swing it, from either end
  for (const W of [A, [-A[0], 0, -A[2]]]) for (const clock of [0, 0.7, 9]) for (let t = 0; t <= 1; t += 0.125) near(sideOf(ropeAt(t, W, 2.4, 1, clock), t), 0, 1e-9, 'a wind along the line');
  // the ends stay tied (the shader's tree end moves only with the trunk), and the line hardly stretches
  for (const [W, str] of [[C, 1], [C, 2.4], [A, 2.4], [[0.6, 0, 0.8], 1.7]]) {
    for (const clock of [0, 2.2]) {
      near(Math.hypot(...offAt(ropeAt(0, W, str, 1, clock), 0)), 0, 1e-12, 'tied at the tree');
      near(Math.hypot(...offAt(ropeAt(1, W, str, 1, clock), 1)), 0, 1e-12, 'tied at the stake');
      near(lengthOf(W, str, 1, clock) / still, 1, 0.03, 'its length');
    }
  }
  assert.ok(sh.includes('ropeTie = windOffset(uRopeFrom, vec4(0.0), gustAt(uRopeFrom));'), 'the tree end goes with the trunk');
  // every flag knows its place on the line from where it was built, so its top edge is on the line where it is now
  for (const r of cloth) {
    const t0 = ((r[0] - F.from[0]) * chord[0] + (r[2] - F.from[2]) * chord[2]) / (chord[0] ** 2 + chord[2] ** 2);
    const rest = ropeAt(t0, C, 0, 0, 0);
    near(Math.hypot(rest[0] - r[0], rest[1] - r[1], rest[2] - r[2]), 0, 1e-5, 'a flag on the line');
  }
  // the tree's picture has room for the line swung out in a storm with its flags blown out level from it
  const SWAY_ROOM = 1.2; // foreground.js: room above the tree's box for the crown, the line and the flags blown up
  for (const W of [C, [-C[0], 0, -C[2]]]) {
    for (const clock of [0, 0.5, 1.1, 2.9]) {
      for (let t = 0; t <= 1; t += 0.05) {
        const p = ropeAt(t, W, 2.4, 1, clock);
        for (const k of [0, 2]) assert.ok(p[k] - 0.36 >= F.lo[k] - 1e-6 && p[k] + 0.36 <= F.hi[k] + 1e-6, 'room across');
        assert.ok(p[1] - 0.36 >= F.lo[1] - 1e-6 && p[1] + 0.36 <= F.hi[1] + SWAY_ROOM, 'room up and down');
      }
    }
  }
  assert.ok(sh.includes('} else if (kind == 5) {') && sh.includes('alb = vSide * (0.82 + 0.18 * smoothstep(1.0, 0.75, vUV.y)) * (0.9 + 0.2 * vr);'), 'drawn as cloth in its colour');
  // the switch: on unless turned off, from the address, the app and Lively; the foreground follows it
  assert.equal(load(['config.js']).LE.config.flags, true);
  assert.equal(load(['config.js'], { search: '?flags=0' }).LE.config.flags, false);
  assert.ok(readSrc('main.js').includes("case 'flags': // the foreground reads it every frame"));
  assert.ok(readSrc('services/host.js').includes("flags: [c.flags, 'flags'],"));
  assert.ok(readSrc('engine/foreground.js').includes('const flagsOn = R.cfg.flags !== false;'));
  assert.ok(readSrc('ui/debugpanel.js').includes("['Prayer flags', 'flags',"));
});

test('the wind in the tree never settles into a repeating loop', () => {
  const { LE } = load(['engine/gl.js', 'engine/foreground.js']);
  const { lean, limbs } = windRun(LE, 20, 300);
  // compared with itself at any delay from 5 s to 2 minutes, the movement is not a copy
  let worst = 0;
  for (let lag = 150; lag <= 3600; lag += 15) {
    const n = lean.length - lag;
    worst = Math.max(worst, correlation(lean.slice(0, n), lean.slice(lag, lag + n)));
  }
  assert.ok(worst < 0.75, `repeats too closely, correlation ${worst.toFixed(2)}`);
  // gusts come and go: the sway over one half minute differs from the next
  const parts = [];
  for (let i = 0; i < 10; i++) parts.push(spread(lean.slice(i * 900, (i + 1) * 900)));
  assert.ok(Math.max(...parts) > Math.min(...parts) * 1.4, `the same swing all the time: ${parts.map((v) => v.toFixed(3))}`);
  // limbs swing separately
  for (let i = 0; i < 4; i++)
    for (let j = i + 1; j < 4; j++) {
      const c = Math.abs(correlation(limbs[i], limbs[j]));
      assert.ok(c < 0.6, `swings ${i} and ${j} move together, correlation ${c.toFixed(2)}`);
    }
});

test('a gust reaches the upwind side of the crown first, sooner in a stronger wind', () => {
  const { LE } = load(['engine/gl.js', 'engine/foreground.js']);
  const frontDelay = (kmh) => {
    const str = Math.min(Math.pow(kmh / 30, 0.8), 2.4);
    const tw = new LE.TreeWind();
    const up = [];
    const down = [];
    for (let t = 0; t < 120; t += 1 / 30) {
      tw.step(1 / 30, str, kmh, 0, 8);
      up.push(tw.front[0]);
      down.push(tw.front[3]);
    }
    let best = 0;
    let bestC = -2;
    for (let lag = 0; lag <= 120; lag++) {
      const n = up.length - lag;
      const c = correlation(up.slice(0, n), down.slice(lag, lag + n));
      if (c > bestC) {
        bestC = c;
        best = lag;
      }
    }
    return best / 30;
  };
  const light = frontDelay(10);
  const storm = frontDelay(60);
  assert.ok(light > 1.5 && light <= 3.1, `light wind crosses in ${light} s`);
  assert.ok(storm < light / 2, `a storm crosses in ${storm} s, light wind in ${light} s`);
});

test('the tree bends with a gust and swings back when it has passed', () => {
  const { LE } = load(['engine/gl.js', 'engine/foreground.js']);
  const tw = new LE.TreeWind();
  // only the strength changes here, for a clear start and end to the push
  for (let t = 0; t < 5; t += 1 / 30) tw.step(1 / 30, 1.5, 45, 0, 8);
  const pushed = tw.lean[0];
  assert.ok(pushed > 0.05, `bends downwind (${pushed})`);
  let lowest = Infinity;
  const after = [];
  for (let t = 0; t < 6; t += 1 / 30) {
    tw.step(1 / 30, 0, 0, 0, 8);
    lowest = Math.min(lowest, tw.lean[0]);
    after.push(tw.lean[0]);
  }
  assert.ok(lowest < 0, `swings past upright (${lowest})`);
  const end = after.slice(-30);
  assert.ok(Math.max(...end.map(Math.abs)) < pushed, 'and the swinging dies away');
});

test('in a storm the tree is still moving, not pinned at its limit', () => {
  const { LE } = load(['engine/gl.js', 'engine/foreground.js']);
  const { lean, limbs } = windRun(LE, 100, 120);
  assert.ok(spread(lean) > 0.02, `the tree still swings (${spread(lean)})`);
  const pinned = limbs[0].filter((v) => Math.abs(v) >= 0.1199).length / limbs[0].length;
  assert.ok(pinned < 0.05, `limbs stuck at the limit ${(pinned * 100).toFixed(0)}% of the time`);
});

test('the tree turns to a new wind direction long before the forest gust pattern does', () => {
  const { env, advance } = newEnv();
  const wind = (windDir) => ({ code: 2, cloud: 40, windSpeed: 20, gusts: 30, windDir, precip: 0, temp: 20 });
  env.setWeather(wind(270), 'live');
  advance(10, 0.5);
  const was = [...env.state.treeDir];
  const forest = [...env.state.gustDir];
  env.setWeather(wind(0), 'live'); // a quarter turn
  advance(240, 0.5);
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
  assert.ok(dot(env.state.treeDir, was) < 0.25, `the tree turned: ${dot(env.state.treeDir, was)}`);
  assert.ok(dot(env.state.gustDir, forest) > dot(env.state.treeDir, was) + 0.2, 'the forest pattern turns more slowly');
  assert.ok(Math.abs(Math.hypot(...env.state.treeDir) - 1) < 1e-3, 'a direction, not a speed');
});

test('the wind in the tree stays stable and in range at any frame rate, and after a pause', () => {
  const { LE } = load(['engine/gl.js', 'engine/foreground.js']);
  for (const dt of [1 / 60, 1 / 6, 0.5, 1.9, 30]) {
    const { tw, lean, limbs } = windRun(LE, 90, 90 * Math.max(dt, 1), dt);
    assert.ok(lean.every((v) => Number.isFinite(v) && Math.abs(v) <= 0.6), `lean at dt ${dt}`);
    for (const l of limbs) assert.ok(l.every((v) => Number.isFinite(v) && Math.abs(v) <= 0.1201), `limbs at dt ${dt}`);
    assert.ok(tw.front.every(Number.isFinite) && tw.flutter >= 0 && tw.flutter < 2400, `other values at dt ${dt}`);
  }
  const tw = new LE.TreeWind();
  tw.flutter = 2399.99;
  tw.step(1, 1, 30, 0, 8);
  assert.ok(tw.flutter < 2400, 'the flutter clock wraps');
});

test('the tree is a full, tree-sized crown with valid geometry', () => {
  const { LE } = load(['engine/gl.js', 'engine/foreground.js']);
  const T = LE.growTree(7936, [-0.8, 0, 0.6]);
  assert.ok(T.height > 4.5 && T.height < 8, `height ${T.height}`);
  assert.ok(Math.max(...T.crownR) < 4.5, `crown radius ${T.crownR}`);
  assert.ok(T.leafCount > 8000, `leaves ${T.leafCount}`);
  assert.ok(T.clumps > 20, `foliage masses ${T.clumps}`);
  assert.ok(T.leaves.every(Number.isFinite) && T.bark.every(Number.isFinite), 'no NaN or Infinity');
  const verts = T.bark.length / 14;
  assert.ok(T.index.every((i) => i < verts), 'indices in range');
  // wind weights never pull a leaf against the wood it grows on: they only grow along a shoot
  for (let i = 0; i < T.leafCount; i++) assert.ok(T.leaves[i * 21 + 9] >= 0 && T.leaves[i * 21 + 11] >= 0);
});

// Where a leaf's blade falls, in the same angular cells shellOfTree works in
function bladeCells(T, site, i, cell) {
  const o = i * 21;
  const L = T.leaves;
  const cells = new Set();
  for (let a = 0.1; a <= 0.9; a += 0.1) {
    const x = L[o] + L[o + 3] * a + site[0];
    const y = L[o + 1] + L[o + 4] * a + site[1];
    const z = L[o + 2] + L[o + 5] * a + site[2];
    cells.add(`${Math.floor(Math.atan2(x, z) / cell)},${Math.floor(y / Math.hypot(x, z) / cell)}`);
  }
  return cells;
}

test('the crown keeps only what the fixed camera can see, and its outline stays the same', () => {
  const { LE } = load(['engine/gl.js', 'engine/foreground.js']);
  const a = (-0.672 * ((140 * Math.PI) / 180)) / 2;
  const site = [Math.sin(a) * 28, -3.6, Math.cos(a) * 28];
  const away = [Math.sin(a), 0, Math.cos(a)];
  const all = LE.growTree(7936, away);
  const shell = LE.shellOfTree(all, site, away);
  const leavesAll = all.leafCount - all.flowerCount;
  const leavesKept = shell.leafCount - shell.flowerCount;
  assert.ok(leavesKept < leavesAll * 0.8, `hidden leaves are dropped (${leavesKept} of ${leavesAll})`);
  assert.ok(leavesKept > leavesAll * 0.15, `but the crown stays full (${leavesKept} of ${leavesAll})`);
  assert.equal(shell.flowerCount, all.flowerCount, 'every flower stays: they sit at the tips, in front');
  assert.ok(shell.index.length < all.index.length, 'twigs hidden inside the crown go too');

  // every part of the screen the full crown covers is still covered: the outline can't change
  const CELL = 0.004;
  const seen = (T, n) => {
    const s = new Set();
    for (let i = 0; i < n; i++) for (const c of bladeCells(T, site, i, CELL)) s.add(c);
    return s;
  };
  const before = seen(all, leavesAll);
  const after = seen(shell, leavesKept);
  let lost = 0;
  for (const c of before) if (!after.has(c)) lost++;
  assert.ok(lost / before.size < 0.002, `outline kept: ${lost} of ${before.size} cells lost`);

  // nearest first, so the GPU can reject what is behind without shading it
  const dist = (i) => {
    const o = i * 21;
    const L = shell.leaves;
    return Math.hypot(L[o] + L[o + 3] * 0.5 + site[0], L[o + 1] + L[o + 4] * 0.5 + site[1], L[o + 2] + L[o + 5] * 0.5 + site[2]);
  };
  for (let i = 1; i < leavesKept; i += 37) assert.ok(dist(i) >= dist(i - 1) - 1e-3, 'sorted near to far');

  const verts = shell.bark.length / 14;
  assert.ok(shell.index.every((i) => i < verts), 'indices in range');
  assert.ok(shell.leaves.every(Number.isFinite) && shell.bark.every(Number.isFinite), 'no NaN or Infinity');
  assert.deepEqual([...shell.crownC], [...all.crownC], 'the light on the crown is worked out as before');
});

test('the tree redraws only as often as something on it changes', () => {
  const { fg } = newForeground();
  const dry = { rain: 0, snow: 0, flash: 0 };
  const due = (time, treeKmh, weather = dry) => fg._treeDue({ time, treeKmh, weather, gustDir: [1, 0] });
  fg.r.quality = { treeHz: 15 };
  fg.r._fade = 1;
  fg.r._rest = false;
  assert.equal(due(10, 20), true, 'the first frame always draws it');
  fg._treeT = 10;
  assert.equal(due(10 + 1 / 30, 20), false, 'at 30 fps, windy: every second frame');
  assert.equal(due(10 + 2 / 30, 20), true);
  assert.equal(due(10 + 1 / 20, 20), true, 'at 20 fps, windy: every frame');
  assert.equal(due(10 + 0.05, 1), false, 'in still air it waits, because nothing on it moves');
  assert.equal(due(10 + 0.1, 1), true);
  assert.equal(due(10 + 1 / 30, 20, { rain: 0.5, snow: 0, flash: 0 }), true, 'rain is drawn over it, so it keeps up with the rain');
  assert.equal(due(10 + 1 / 30, 1, { rain: 0, snow: 0, flash: 0.5 }), true, 'a flash lights it at once');
  fg.r._fade = 0.5;
  assert.equal(due(10 + 1 / 30, 1), true, 'it follows the fade-in');
  fg.r._fade = 1;
  fg.r._slow = true;
  assert.equal(due(10 + 1 / 30, 20), false, 'at 30 fps in a calm scene: 15 Hz here too');
  assert.equal(due(10 + 2 / 30, 20), true, 'a calm scene keeps the full rate');
  fg.r._rest = true;
  assert.equal(due(10 + 0.05, 20), false, 'rest mode keeps it light');
  assert.equal(due(10 + 0.05, 20, { rain: 0.5, snow: 0, flash: 0 }), false, 'even in the rain');
  assert.equal(due(10 + 0.2, 20), true, 'but it still moves in the wind');
  fg.resize(3840, 1080);
  assert.equal(due(10.01, 20), true, 'a new target has to be drawn at once');
});

// ---------------------------------------------------------------- never letting frames pile up on the GPU
function newRendererWithFence() {
  const h = load(['engine/gl.js', 'engine/quality.js', 'engine/foreground.js', 'engine/renderer.js']);
  let now = 1000;
  h.ctx.performance = { now: () => now };
  const fences = [];
  let signaled = false;
  const gl = {
    SIGNALED: 1,
    SYNC_STATUS: 2,
    SYNC_GPU_COMMANDS_COMPLETE: 3,
    lost: false,
    isContextLost() {
      return this.lost;
    },
    fenceSync() {
      fences.push('live');
      return fences.length - 1;
    },
    deleteSync(f) {
      fences[f] = 'deleted';
    },
    getSyncParameter() {
      return signaled ? 1 : 0;
    },
    flush() {},
  };
  const r = new h.LE.Renderer({}, {});
  r.gl = gl;
  return { r, gl, fences, advance: (ms) => (now += ms), signal: (v) => (signaled = v) };
}

test('a new frame waits until the GPU has finished the last one', () => {
  const { r, fences, advance, signal } = newRendererWithFence();
  assert.equal(r.frameDone(), true, 'nothing in flight at the start');
  r._fenceFrame();
  assert.equal(r.frameDone(), false, 'still on the GPU');
  advance(40);
  assert.equal(r.frameDone(), false);
  signal(true);
  advance(10);
  assert.equal(r.frameDone(), true, 'finished');
  assert.equal(fences[0], 'deleted', 'the fence is released');
  assert.equal(r.frameDone(), true, 'stays free until the next frame');
  near(r.gpuBusyMs, 42, 0.01, 'the time on the GPU, less half a screen refresh for when it was noticed');
});

test('a calm scene is drawn a few bands at a time, and shows only when it is whole and the last fade has ended', () => {
  const { r, gl, advance } = newRendererWithFence();
  gl.useProgram = () => {};
  const bands = [];
  const seen = {};
  const times = [];
  r.status = 'running';
  r.w = 100;
  r.h = 80;
  r.pictureBands = 4;
  r._pictureReady = true;
  r.pictureA = { tex: ['A'] };
  r.pictureB = { tex: ['B'] };
  r.pictureNext = { tex: ['C'] };
  r.prog = { fade: { p: 1, set: (k, v) => (seen[k] = v) } };
  r._target = () => {};
  r._bind = (p, t) => Object.assign(seen, t);
  r._draw = () => {};
  r._spritePass = () => {};
  r.fg = { draw() {} };
  r.goats = { draw() {} };
  const state = { time: 5, treeDir: [1, 0], treeKmh: 0, windAmt: 0, weather: { rain: 0, snow: 0 } };
  r._compositePass = (s, meter, band) => {
    bands.push([band.y, band.h]);
    times.push(s.time);
  };

  r._pictureJob = { state, time: 5, y: 0, fresh: true };
  assert.equal(r.pictureBusy(), true);
  r.drawFade(0.2, state);
  assert.equal(bands.length, 0, 'the frame that drew the clouds has enough to do');
  state.time = 6; // the fades move the clock on
  for (let i = 0; i < 4; i++) r.drawFade(0.5, state);
  assert.deepEqual(bands, [[0, 20], [20, 20], [40, 20], [60, 20]], 'the bands fill the picture, each in its own frame');
  assert.deepEqual(times, [5, 5, 5, 5], 'and all show one moment');
  assert.equal(state.time, 6);
  assert.equal(seen.uTo, 'B', 'whole, but the last fade has not ended: taking over now would jump');
  assert.equal(r.pictureBusy(), true);
  r.drawFade(0.9, state);
  assert.equal(bands.length, 4, 'no more bands');
  advance(100);
  r.drawFade(1, state);
  assert.equal(seen.uFrom, 'B', 'the fade starts from what is on the screen');
  assert.equal(seen.uTo, 'C');
  assert.equal(seen.uMix, 0);
  assert.equal(r.pictureBusy(), false);
  assert.equal(r.pictureAt, 1100, 'the next fade is timed from now');
  assert.equal(r.pictureNext.tex[0], 'A', 'the oldest picture is drawn over next');
});

test('in rain or snow the calm scene goes on, and the drops fall over every fade at its own time', () => {
  const { r, gl } = newRendererWithFence();
  gl.useProgram = () => {};
  r.status = 'running';
  r.w = 100;
  r.h = 80;
  r._pictureReady = true;
  r.pictureA = { tex: ['A'] };
  r.pictureB = { tex: ['B'] };
  r.pictureNext = { tex: ['C'] };
  r.skyLUT = { tex: ['sky'] };
  r.quality = { rainLayers: 3 };
  r._fade = 1;
  const used = [];
  const seen = {};
  const prog = (name) => ({ p: name, set: (k, v) => (seen[k] = v) });
  r.prog = { fade: prog('fade'), fadeRain: prog('fadeRain') };
  gl.useProgram = (p) => used.push(p);
  r._target = () => {};
  let bound = {};
  r._bind = (p, t) => (bound = t);
  r._draw = () => {};
  r._spritePass = () => {};
  r.fg = { draw() {} };
  r.goats = { draw() {} };
  const weather = { rain: 0, snow: 0, rainSlant: 0.1, flash: 0 };
  const state = { time: 2405, treeDir: [1, 0], treeKmh: 0, windAmt: 0, night: 0.3, weather };
  r.drawFade(0.5, state);
  assert.deepEqual(used, ['fade'], 'dry: the plain fade');
  assert.equal(bound.uSkyLUT, undefined);
  weather.rain = 0.12; // the light drizzle that kept the whole scene at the full rate before
  r.drawFade(0.5, state);
  assert.equal(used[1], 'fadeRain', 'rain: the fade that puts the drops in front');
  assert.equal(seen.uRain, 0.12);
  assert.equal(seen.uTime, 5, 'the same wrapped clock as the scene, so the drops line up with the tree\'s');
  assert.equal(seen.uNight, 0.3);
  assert.equal(seen.uRainLayers, 3);
  assert.deepEqual([bound.uFrom, bound.uTo, bound.uSkyLUT], ['A', 'B', 'sky']);
  weather.rain = 0;
  weather.snow = 0.4;
  r.drawFade(0.5, state);
  assert.equal(used[2], 'fadeRain', 'snow too');
  assert.equal(seen.uSnow, 0.4);
});

test('the kept pictures have no falling drops, and the scene\'s own frames and the grass between them do', () => {
  const src = readFileSync(new URL('engine/renderer.js', SRC), 'utf8');
  assert.ok(
    src.includes("p.set('uPrecipOff', this._slow && !meter && !(band && band.grass) ? 1 : 0)"),
    'slow mode keeps its pictures without them; the grass is drawn on the screen after the fade, so with them'
  );
  const comp = readFileSync(new URL('engine/shaders/composite.js', SRC), 'utf8');
  assert.ok(comp.includes('if (uPrecipOff > 0.5 || (uRain <= 0.003 && uSnow <= 0.003)) return col;'));
  assert.ok(comp.includes('return gradeColor(precipitation(col, fc), fc);'), 'finishColor: the drops, then the grading');
  const main = readFileSync(new URL('main.js', SRC), 'utf8');
  const calm = main.slice(main.indexOf('function calmScene'), main.indexOf('function stepLife'));
  assert.ok(!/rain|snow/.test(calm), 'rain and snow no longer stop the calm scene');
  assert.ok(main.includes('renderer.foregroundMoving() || w.rain > 0.003 || w.snow > 0.003'), 'and the fades run at the full rate while they fall');
});

test('the wind in the grass runs the way the real wind blows, at its speed, and never jumps', () => {
  const { r } = newRendererWithFence();
  const air = (time, x, z, kmh = 36, windAmt = 0.5) => ({ time, treeDir: [x, z], treeKmh: kmh, windAmt });
  r._grassStep(air(10, 1, 0));
  assert.deepEqual([...r._grassWind], [0, 0, 0, 0], 'the first frame only starts the clock');
  r._grassStep(air(10.1, 1, 0));
  near(r._grassWind[0], 0.6, 1e-9, 'air going right at 36 km/h: gusts go right at 6 m/s');
  assert.equal(r._grassWind[1], 0);
  assert.ok(r._grassWind[2] > 0, 'the blades lean right');
  const { r: left } = newRendererWithFence();
  left._grassStep(air(10, -1, 0));
  left._grassStep(air(10.1, -1, 0));
  assert.ok(left._grassWind[0] < 0 && left._grassWind[2] < 0, 'air going left: both go left');
  const { r: away } = newRendererWithFence();
  away._grassStep(air(10, 0, 1));
  away._grassStep(air(10.1, 0, 1));
  assert.equal(away._grassWind[0], 0, 'air going straight away from us: nothing sideways');
  near(away._grassWind[1], 0.18, 1e-9, 'it runs up the picture, foreshortened');
  near(away._grassWind[2], 0, 1e-9, 'and the blades lean neither way');
  const before = r._grassWind[0];
  r._grassStep(air(100000, 1, 0));
  assert.ok(r._grassWind[0] - before <= 1.5 + 1e-9, 'a long gap, such as a pause, moves it on by one frame at most');
  const { r: light } = newRendererWithFence();
  light._grassStep(air(10, 1, 0, 3, 0.05));
  light._grassStep(air(10.25, 1, 0, 3, 0.05));
  near(light._grassWind[0], 0.15, 1e-9, 'light air still moves through it at a walking pace');
  for (let i = 1; i < 60; i++) light._grassStep(air(10.25 + i * 0.25, 1, 0, 3, 0.05));
  assert.ok(light._grassWind[3] > 0.28, 'and can be seen, in 3 km/h that hardly moves a tree: ' + light._grassWind[3]);
  for (let i = 1; i <= 2000; i++) r._grassStep(air(100000 + i * 0.25, 1, 0));
  assert.ok(r._grassWind[0] < 50, 'it wraps on a whole number of noise tiles');
  near(0.08 * 50, 4, 1e-9);
  near(0.16 * 1.25 * 50, 10, 1e-9);
  const { r: still } = newRendererWithFence();
  still._grassStep(air(10, 1, 0, 0, 0));
  still._grassStep(air(10.25, 1, 0, 0, 0));
  assert.deepEqual([...still._grassWind], [0, 0, 0, 0], 'no wind: no movement at all');
});

test('between scenes the grass alone is drawn again, in the place it really is, and only while there is wind', () => {
  const { r } = newRendererWithFence();
  r.cfg = { render: { horizonY: 0.4, maxHFovDeg: 140 } };
  r.w = 1827;
  r.h = 935;
  const box = r._grassBox();
  assert.equal(box.grass, true);
  assert.equal(box.x, 0, 'the rock runs off the left of the picture');
  assert.ok(box.w > 400 && box.w < 560, 'to just past its tip, around pixel 480: ' + box.w);
  assert.ok(box.y < 155 && box.y >= 0, 'from below its near edge, about 155 up: ' + box.y);
  assert.ok(box.y + box.h > 246 && box.y + box.h < 320, 'to above its far edge, about 246 up: ' + (box.y + box.h));
  assert.ok((box.w * box.h) / (r.w * r.h) < 0.08, 'a small part of the picture');
  r.w = 320;
  r.h = 90;
  const small = r._grassBox();
  assert.ok(small.y >= 0 && small.y + small.h <= 90 && small.w <= 320, 'stays inside any picture');

  const calls = [];
  r._compositePass = (s, meter, band) => calls.push(band);
  r._grassBox = () => 'the box';
  r._grassWind[3] = 0.3;
  assert.equal(r.grassMoving(), true);
  r._grassPass({});
  assert.deepEqual(calls, ['the box']);
  r._rest = true;
  r._grassPass({});
  assert.equal(calls.length, 1, 'not in the Windows app\'s rest mode, while you work');
  r._rest = false;
  r._grassWind[3] = 0;
  r._grassPass({});
  assert.equal(calls.length, 1, 'not in still air');
  assert.equal(r.grassMoving(), false, 'so the fades can slow down');
});

test('a slow GPU draws a calm scene in more, thinner bands, so no frame holds it up for long', () => {
  const { r } = newRendererWithFence();
  r.pictureBands = 8;
  r.gpuBusyMs = 30;
  r._tunePictureBands();
  assert.equal(r.pictureBands, 10);
  for (let i = 0; i < 40; i++) r._tunePictureBands();
  assert.equal(r.pictureBands, 32, 'up to a limit, or a new scene would come too rarely');
  r.gpuBusyMs = 12;
  r._tunePictureBands();
  assert.equal(r.pictureBands, 32, 'it settles rather than hunting');
  r.gpuBusyMs = 8.7;
  for (let i = 0; i < 40; i++) r._tunePictureBands();
  assert.equal(r.pictureBands, 4, 'a quick GPU gets fewer');
});

test('the Windows app\'s rest mode and a calm scene ask different things of the renderer', () => {
  const { r } = newRendererWithFence();
  r._bgPacer = {};
  r.setSlowMode(true, false);
  assert.equal(r._slow, true);
  assert.equal(r._rest, false, 'a calm scene keeps the tree at the full rate');
  assert.equal(r._bgPacer.targetMs, 12, 'and a smaller shadow chunk, because scenes come often');
  r.setSlowMode(true);
  assert.equal(r._rest, true, 'the app only says on or off');
  assert.equal(r._bgPacer.targetMs, 25);
  r._pictureReady = true;
  r._pictureJob = {};
  r.setSlowMode(false);
  assert.equal(r._rest, false);
  assert.equal(r._pictureReady, false);
  assert.equal(r.pictureBusy(), false, 'back to full frames, no picture is left half drawn');
});

test('the time a frame takes on the GPU is smoothed, so one slow frame does not halve the frame rate', () => {
  const { r, advance, signal } = newRendererWithFence();
  signal(true);
  const frame = (ms) => {
    r._fenceFrame();
    advance(ms);
    r.frameDone();
  };
  for (let i = 0; i < 40; i++) frame(30);
  near(r.gpuBusyMs, 22, 0.1, 'settles on the real cost');
  frame(300);
  assert.ok(r.gpuBusyMs < 90, `one spike moves it only part of the way (${r.gpuBusyMs})`);
  for (let i = 0; i < 40; i++) frame(30);
  near(r.gpuBusyMs, 22, 0.5, 'and it comes back');
});

test('a fence that never signals can not freeze the wallpaper for good', () => {
  const { r, advance } = newRendererWithFence();
  r._fenceFrame();
  advance(1000);
  assert.equal(r.frameDone(), false, 'a slow frame is waited for');
  advance(5000);
  assert.equal(r.frameDone(), true, 'but not for ever');
});

test('a lost graphics context does not leave the loop waiting on its fence', () => {
  const { r, gl } = newRendererWithFence();
  r._fenceFrame();
  gl.lost = true;
  assert.equal(r.frameDone(), true);
});

test('drawing again in one go keeps one fence, timed from the first draw', () => {
  const { r, fences, advance, signal } = newRendererWithFence();
  r._fenceFrame();
  advance(5);
  r._fenceFrame(); // rest mode: the scene and its first fade frame are one piece of work
  assert.deepEqual(fences, ['deleted', 'live']);
  advance(25);
  signal(true);
  assert.equal(r.frameDone(), true);
  near(r.gpuBusyMs, 22, 0.01);
});

test('falling leaves travel with the wind, at about its speed', () => {
  const { fg, run } = newForeground();
  run(12, 36, [1, 0]); // 10 m/s toward +x
  assert.ok(fg.drift.length > 5, `leaves in the air: ${fg.drift.length}`);
  const vx = fg.drift.reduce((s, L) => s + L.v[0], 0) / fg.drift.length;
  const vz = fg.drift.reduce((s, L) => s + L.v[2], 0) / fg.drift.length;
  assert.ok(vx > 6 && vx < 14, `downwind speed ${vx}`);
  assert.ok(Math.abs(vz) < 2.5, `across the wind ${vz}`);
  assert.ok(fg.drift.every((L) => L.v[1] < 1.5), 'they do not fly up and away');
});

test('the wind direction turns the leaves with it', () => {
  const { fg, run } = newForeground();
  run(12, 36, [0, -1]); // toward the eye
  const vz = fg.drift.reduce((s, L) => s + L.v[2], 0) / fg.drift.length;
  assert.ok(vz < -6, `toward the eye ${vz}`);
});

test('in still air only a few leaves let go, and they fall nearly straight', () => {
  const { fg, run } = newForeground();
  run(30, 0.5, [1, 0]);
  assert.ok(fg.drift.length <= 4, `leaves in the air: ${fg.drift.length}`);
  for (const L of fg.drift) assert.ok(Math.hypot(L.v[0], L.v[2]) < 1.2, 'drifting gently');
  const windy = newForeground().run(30, 40, [1, 0]);
  assert.ok(windy.drift.length > fg.drift.length + 10, 'many more in a strong wind');
});

// ---------------------------------------------------------------- the nearest airport's report (the exe reads it)
// 2026-11-18, 09:30 Dhaka: the forecast the app used, and what Dhaka airport (VGHS) reported at the same time
const FORECAST_1118 = { code: 3, cloud: 91, cloudLow: 0, cloudMid: 0, cloudHigh: 91, humidity: 79, visibility: 7140, windSpeed: 5.6, windDir: 330, precip: 0, temp: 23.4, source: 'live' };
const VGHS_1118 = (now, over = {}) => ({ id: 'VGHS', name: 'Dhaka/Shahjalal Intl, 32, BD', km: 2.3, t: now - 10 * 60e3, temp: 21, dewp: 19, vis: 1000, wx: 'BR', ...over });

function airport() {
  const h = load(['config.js', 'services/astronomy.js', 'services/storage.js', 'services/weather.js', 'engine/environment.js']);
  const targets = (rec) => {
    const env = new h.LE.Environment(h.LE.config);
    env.setWeather(rec, 'live');
    env.update(new Date('2026-11-18T03:30:00Z'), 1, 1);
    return env.state.weather;
  };
  return { LE: h.LE, merge: (rec, obs, now = Date.now()) => h.LE.withObservation(rec, obs, now), targets };
}

test("the airport's report is laid over the forecast: this morning's mist and 1 km, with humidity from the dew point", () => {
  const { LE, merge } = airport();
  const now = Date.now();
  const r = merge(FORECAST_1118, VGHS_1118(now), now);
  assert.equal(r.visibility, 1000);
  assert.equal(r.temp, 21);
  near(r.humidity, 88, 0.6, 'humidity from 21 / 19 °C');
  assert.equal(r.obscured, 'mist');
  assert.equal(r.code, 3, 'mist is not fog: the code stays');
  assert.equal(r.cloudHigh, 91, 'cloud stays with the forecast');
  assert.equal(r.windSpeed, 5.6, 'and the wind');
  assert.equal(r.source, 'live');
  assert.deepEqual({ ...r.obs }, { id: 'VGHS', t: now - 10 * 60e3 });
  assert.equal(FORECAST_1118.visibility, 7140, 'the forecast itself is not changed');
  assert.equal(LE.weatherLabel(r), 'Mist');
  assert.equal(LE.weatherLabel(FORECAST_1118), 'High cloud', 'without the report: high cloud, not "Overcast"');
  assert.equal(LE.weatherLabel({ ...FORECAST_1118, cloudLow: 80 }), 'Overcast');
  assert.equal(LE.weatherLabel({ code: 3, cloud: 95 }), 'Overcast', 'no layers known: as the code says');
  assert.equal(LE.weatherLabel(null), 'Unknown');
});

test('only a recent report from near by counts, and "10 km or more" keeps a clearer forecast', () => {
  const { merge } = airport();
  const now = Date.now();
  assert.equal(merge(FORECAST_1118, VGHS_1118(now, { t: now - 101 * 60e3 }), now), FORECAST_1118, 'over 100 minutes old');
  assert.equal(merge(FORECAST_1118, VGHS_1118(now, { t: now + 20 * 60e3 }), now), FORECAST_1118, 'from the future');
  assert.equal(merge(FORECAST_1118, VGHS_1118(now, { km: 61 }), now), FORECAST_1118, 'over 60 km away');
  assert.equal(merge(FORECAST_1118, null, now), FORECAST_1118, 'none');
  assert.equal(merge(null, VGHS_1118(now), now), null, 'nothing to lay it over');
  assert.equal(merge({ ...FORECAST_1118, visibility: 24000 }, VGHS_1118(now, { vis: 9999, wx: '' }), now).visibility, 24000);
  assert.equal(merge(FORECAST_1118, VGHS_1118(now, { vis: 9999, wx: '' }), now).visibility, 10000);
  const blank = merge(FORECAST_1118, VGHS_1118(now, { vis: null, temp: null, dewp: null, wx: '' }), now);
  assert.equal(blank.visibility, 7140, 'numbers the report lacks stay with the forecast');
  assert.equal(blank.temp, 23.4);
  assert.equal(blank.humidity, 79);
  assert.equal(blank.obscured, undefined);
});

test("the report's weather groups: fog, mist, haze, smoke, dust; near by or shallow fog is not fog here; rain stays the forecast's", () => {
  const { LE, merge } = airport();
  const now = Date.now();
  const wx = (w, base = FORECAST_1118) => merge(base, VGHS_1118(now, { wx: w }), now);
  assert.equal(wx('FG').code, 45);
  assert.equal(wx('FG').obscured, 'fog');
  assert.equal(LE.weatherLabel(wx('FG')), 'Fog');
  assert.equal(wx('FZFG').code, 45, 'freezing fog is fog');
  for (const w of ['MIFG', 'BCFG', 'PRFG']) {
    assert.equal(wx(w).code, 3, w + ' is not a fog that covers the place');
    assert.equal(wx(w).obscured, 'mist', w);
  }
  assert.equal(wx('VCFG').obscured, undefined, 'fog in the vicinity: not here');
  assert.equal(wx('HZ').obscured, 'haze');
  assert.equal(LE.weatherLabel(wx('HZ')), 'Haze');
  assert.equal(wx('FU').obscured, 'smoke');
  assert.equal(wx('DU').obscured, 'dust');
  assert.equal(wx('FU HZ').obscured, 'smoke');
  const rain = { ...FORECAST_1118, code: 61, precip: 0.6 };
  assert.equal(wx('-RA BR', rain).code, 61);
  assert.equal(wx('-RA BR', rain).precip, 0.6);
  assert.equal(LE.weatherLabel(wx('-RA BR', rain)), 'Light rain', 'rain is named before the mist');
  assert.equal(wx('-RA FG', rain).code, 61, 'fog does not replace rain');
  assert.equal(wx('FG', rain).code, 45, 'fog and nothing falling at the airport: fog, no rain');
  assert.equal(wx('').obscured, undefined);
  assert.equal(wx(undefined).obscured, undefined);
});

test('a close airport that sees nothing falling stops the rain: 2026-11-22, 14:30 Uttara', () => {
  const { LE, merge, targets } = airport();
  const now = Date.now();
  // what the wallpaper had: WeatherAPI "Patchy rain nearby" with 0.08 mm, Dhaka airport 2.3 km away haze
  const wapi = { t: now - 18 * 60e3, code: 1063, text: 'Patchy rain nearby', cloud: 70, vis: 10000, temp: 28.6, dewp: 20.9, hum: 63, wind: 7.9, dir: 242, gust: 16.2, precip: 0.08, pm25: 14.9, pm10: 15.7, aqi: 1 };
  const vghs = VGHS_1118(now, { t: now - 18 * 60e3, temp: 28, dewp: 22, vis: 3490, wx: 'HZ' });
  const alone = LE.withWeatherApi(FORECAST_1118, wapi, now);
  assert.equal(alone.precip, 0, 'a trace under 0.1 mm "nearby" is not rain here');
  assert.equal(alone.code, 2, '70% cloud: partly cloudy');
  assert.equal(targets(alone).rain, 0);
  const today = merge(alone, vghs, now);
  assert.equal(today.code, 2);
  assert.equal(LE.weatherLabel(today), 'Haze', 'what the airport saw');
  assert.equal(targets(today).rain, 0);
  // the forecast's rain (or WeatherAPI's) gives way to a close, fresh report that saw none fall
  const rain = { ...FORECAST_1118, code: 63, cloud: 100, precip: 1.2, rain: 1.2 };
  const dry = merge(rain, vghs, now);
  assert.equal(dry.code, 3, 'overcast, not rain');
  assert.equal(dry.precip, 0);
  assert.equal(dry.rain, 0);
  assert.equal(targets(dry).rain, 0);
  const said = merge(LE.withWeatherApi(FORECAST_1118, { ...wapi, code: 1183, text: 'Patchy light rain', precip: 0.3 }, now), { ...vghs, wx: '' }, now);
  assert.equal(said.precip, 0);
  assert.notEqual(LE.weatherLabel(said), 'Patchy light rain', 'its words for rain go with the rain');
  assert.equal(merge(rain, { ...vghs, wx: 'VCSH HZ' }, now).precip, 0, 'showers in the vicinity are not here');
  assert.equal(merge({ ...rain, code: 71, snowfall: 0.8 }, { ...vghs, wx: '' }, now).snowfall, 0, 'nor snow');
  // it rains on where the airport says so, is far, is old, or hears thunder
  for (const [why, o] of [
    ['rain at the airport', { wx: '-RA' }],
    ['drizzle', { wx: 'DZ BR' }],
    ['showers', { wx: 'SHRA' }],
    ['snow', { wx: '-SN' }],
    ['16 km away', { km: 16 }],
    ['61 minutes old', { t: now - 61 * 60e3 }],
    ['thunder', { wx: 'TS HZ' }],
  ]) {
    const r = merge(rain, { ...vghs, ...o }, now);
    assert.equal(r.code, 63, why);
    assert.equal(r.precip, 1.2, why);
  }
  // more than a trace from WeatherAPI is still rain
  assert.equal(LE.withWeatherApi(FORECAST_1118, { ...wapi, precip: 0.1 }, now).code, 61);
  assert.equal(LE.withWeatherApi(FORECAST_1118, { ...wapi, code: 1183, precip: 0.02 }, now).precip, 0.02, 'its words say rain: even a trace');
});

test("the weather service keeps the exe's report, and the scene fills the valleys with fog below the viewpoint", async () => {
  const { weather } = newWeather(async () => ok({}));
  const now = Date.now();
  assert.equal(weather.setObservation(VGHS_1118(now)), true);
  assert.equal(weather.setObservation(VGHS_1118(now)), false, 'the same report again: no change');
  assert.equal(weather.setObservation(null), true);
  assert.equal(weather.setObservation({ id: 'X' }), false, 'not a report: as none');
  assert.equal(weather.obs, null);
  weather.setObservation(VGHS_1118(now));
  weather.start(23.87, 90.4);
  await sleep(30);
  weather.stop();
  assert.equal(weather.current().obscured, 'mist');
  assert.equal(weather.current().visibility, 1000);

  const { merge, targets, LE } = airport();
  const plain = targets(FORECAST_1118);
  const seen = targets(merge(FORECAST_1118, VGHS_1118(now), now));
  assert.equal(plain.fog, 0, 'the forecast alone: no fog');
  assert.ok(seen.fog > 0.65 && seen.mist >= 0.85, `with the airport's 1 km and mist: fog ${seen.fog}, mist ${seen.mist}`);
  assert.ok(seen.fogTop < LE.config.render.cameraAltitude - 0.3, `the fog stays below the viewpoint: top ${seen.fogTop} km`);
  const hazy = targets(merge(FORECAST_1118, VGHS_1118(now, { wx: 'HZ', vis: 2500 }), now));
  assert.equal(hazy.fog, 0, 'haze is not fog');
  assert.ok(hazy.haze > plain.haze + 0.5, `haze thickens the air: ${hazy.haze} against ${plain.haze}`);
  // fog from visibility has no steps
  let last = targets({ ...FORECAST_1118, visibility: 6000 }).fog;
  for (let vis = 5950; vis >= 300; vis -= 50) {
    const f = targets({ ...FORECAST_1118, visibility: vis }).fog;
    assert.ok(f >= last - 1e-9 && f - last < 0.03, `fog ${last} to ${f} at ${vis} m`);
    last = f;
  }
});

test("the airport's mist fills the valleys through the morning, burns off by midday and settles again at dusk; fog reported as fog stays", () => {
  // 2026-11-18 in Dhaka (sunrise 06:12, sunset 17:12): the user wanted the fog sea at 09:12 ("today in this area also
  // foggy") and found it too much at 12:14 ("it should not show that much fog")
  const { merge, LE } = airport();
  const at = (iso, over = {}, rec = null) => {
    const now = Date.parse(iso);
    const env = new LE.Environment(LE.config);
    env.setWeather(rec || merge(FORECAST_1118, VGHS_1118(now, over), now), 'live');
    env.update(new Date(now), 1, 1);
    return env.state.weather;
  };
  const night = at('2026-11-17T21:00:00Z'); // 03:00
  const morning = at('2026-11-18T03:12:00Z'); // 09:12
  const noon = at('2026-11-18T06:15:00Z');
  const afternoon = at('2026-11-18T09:30:00Z'); // 15:30
  const dusk = at('2026-11-18T11:40:00Z'); // 17:40
  for (const [name, w] of [['at night', night], ['at 09:12', morning], ['at dusk', dusk]]) {
    assert.ok(w.fog > 0.6 && w.mist > 0.8, `${name} the valleys stand full: fog ${w.fog}, mist ${w.mist}`);
  }
  for (const [name, w] of [['at noon', noon], ['at 15:30', afternoon]]) {
    assert.ok(w.fog < 0.2 && w.mist < 0.25, `${name} only a thin mist is left: fog ${w.fog}, mist ${w.mist}`);
    assert.ok(w.fogTop < morning.fogTop - 0.3, `${name} it lies lower: ${w.fogTop} against ${morning.fogTop}`);
    near(w.haze, morning.haze, 1e-9, `${name} the air does not turn hazy in its place`);
    near(w.valleyHaze, morning.valleyHaze, 1e-9, `${name} nor the valleys`);
  }
  // it thins over hours, never all at once
  let last = at('2026-11-18T03:30:00Z').fog;
  for (let m = 35; m <= 6 * 60 + 30; m += 5) {
    const f = at(new Date(Date.parse('2026-11-18T03:00:00Z') + m * 60e3).toISOString()).fog;
    assert.ok(Math.abs(f - last) < 0.03, `fog ${last} to ${f} at 09:00 + ${m} min`);
    last = f;
  }
  // fog the airport calls fog, or a forecast's fog, stays all day
  assert.ok(at('2026-11-18T06:15:00Z', { wx: 'FG', vis: 400 }).fog >= 0.8, 'FG at noon');
  assert.equal(at('2026-11-18T06:15:00Z', {}, { ...FORECAST_1118, code: 45 }).fog, 0.9, 'code 45 at noon');
  const src = readFileSync(new URL('engine/environment.js', SRC), 'utf8');
  assert.ok(src.includes('const goal = weatherTargets(rec, mistLift(a, now));'));
});

test('the exe hands the report to the page, and the panel says where it came from', () => {
  const host = readFileSync(new URL('services/host.js', SRC), 'utf8');
  assert.ok(host.includes('if (window.leSetObservation) window.leSetObservation(options.obs || null);'));
  const main = readFileSync(new URL('main.js', SRC), 'utf8');
  assert.ok(main.includes('window.leSetObservation = function (obs) {'));
  assert.ok(main.includes('if (weather.setObservation(obs)) pushWeather();'));
  assert.ok(main.includes('parts.push(`airport ${ob.obs.id} '));
  const overlay = readFileSync(new URL('ui/overlay.js', SRC), 'utf8');
  assert.ok(overlay.includes("e.cond.textContent = LE.weatherLabel(weather) + (air ? ' · ' + air : '');"));
  // the exe asks for it every 10 minutes and with every WeatherAPI fetch (it asked every 30 minutes: up to 40 late)
  const cs = readFileSync(new URL('../host/LivingEarthHost.cs', import.meta.url), 'utf8');
  assert.ok(cs.includes('private const int ObserveEveryMinutes = 10, ObserveRetryMinutes = 5;'));
  const wapiTick = cs.slice(cs.indexOf('private void WeatherApiTick('), cs.indexOf('private void WeatherApiFetched('));
  assert.ok(wapiTick.includes('if (!observing) nextObserve = DateTime.MinValue;'), 'with each weather update');
});

// ---------------------------------------------------------------- WeatherAPI.com, when chosen in the exe
// 2026-11-18, 10:15 Dhaka: what WeatherAPI.com said for Uttara (the exe hands it over without the key)
const WAPI_1118 = (now, over = {}) => ({ t: now - 10 * 60e3, code: 1036, text: 'Smoky haze', cloud: 70, vis: 7000, temp: 24.7, dewp: 17, hum: 62, wind: 7.6, dir: 10, gust: 14.1, precip: 0, pm25: 97.6, pm10: 108, aqi: 4, ...over });

test("WeatherAPI's ground weather is laid over the forecast, and its cloud keeps the forecast's heights", () => {
  const { LE } = airport();
  const now = Date.now();
  const r = LE.withWeatherApi(FORECAST_1118, WAPI_1118(now), now);
  assert.equal(r.temp, 24.7);
  assert.equal(r.humidity, 62);
  assert.equal(r.windSpeed, 7.6);
  assert.equal(r.windDir, 10);
  assert.equal(r.gusts, 14.1);
  assert.equal(r.precip, 0);
  assert.equal(r.visibility, 7000);
  assert.equal(r.obscured, 'haze');
  assert.equal(r.code, 2, '70% cloud and haze: partly cloudy');
  assert.equal(LE.weatherLabel(r), 'Smoky haze', 'in its own words');
  assert.equal(LE.weatherLabel({ ...r, wapiText: undefined }), 'Haze');
  assert.equal(r.pm25, 97.6);
  assert.equal(r.aqi, 4);
  assert.equal(LE.airText(r), 'air unhealthy');
  assert.equal(LE.airText(FORECAST_1118), '', 'none without WeatherAPI');
  assert.equal(r.cloud, 70);
  near(r.cloudHigh, 70, 1e-9, 'all of it high, as the forecast had it');
  assert.equal(r.cloudLow, 0);
  assert.equal(r.cloudMid, 0);
  assert.equal(r.source, 'live');
  assert.deepEqual({ ...r.wapi }, { t: now - 10 * 60e3 });
  assert.equal(FORECAST_1118.temp, 23.4, 'the forecast itself is not changed');
  // layers in proportion
  const layered = LE.withWeatherApi({ ...FORECAST_1118, cloud: 60, cloudLow: 40, cloudMid: 20, cloudHigh: 10 }, WAPI_1118(now, { cloud: 90, code: 1009 }), now);
  near(layered.cloudLow, 60, 1e-9, 'low');
  near(layered.cloudMid, 30, 1e-9, 'mid');
  near(layered.cloudHigh, 15, 1e-9, 'high');
  assert.equal(layered.code, 3);
  const flat = LE.withWeatherApi({ ...FORECAST_1118, cloud: 0, cloudHigh: 0 }, WAPI_1118(now, { cloud: 50, code: 1003 }), now);
  assert.equal(flat.cloudLow, null, 'no layers to share it out by: the total alone');
  assert.equal(flat.cloud, 50);
  const alone = LE.withWeatherApi(null, WAPI_1118(now), now);
  assert.equal(alone.temp, 24.7, 'with no forecast at all it stands alone');
  assert.equal(alone.source, 'live');
  // 10 km means 10 km or more
  assert.equal(LE.withWeatherApi({ ...FORECAST_1118, visibility: 24000 }, WAPI_1118(now, { vis: 10000 }), now).visibility, 24000);
  // only while fresh
  assert.equal(LE.withWeatherApi(FORECAST_1118, WAPI_1118(now, { t: now - 61 * 60e3 }), now), FORECAST_1118, 'over an hour old');
  assert.equal(LE.withWeatherApi(FORECAST_1118, null, now), FORECAST_1118, 'none');
  const blank = LE.withWeatherApi(FORECAST_1118, WAPI_1118(now, { temp: null, hum: null, vis: null, cloud: null, wind: null }), now);
  assert.equal(blank.temp, 23.4, 'numbers it lacks stay with the forecast');
  assert.equal(blank.visibility, 7140);
  assert.equal(blank.cloudHigh, 91);
});

test("WeatherAPI's conditions become the scene's weather codes; 'possible' is not rain", () => {
  const { LE } = airport();
  const now = Date.now();
  const code = (c, over = {}) => LE.withWeatherApi(FORECAST_1118, WAPI_1118(now, { code: c, ...over }), now);
  assert.equal(code(1000, { cloud: 0 }).code, 0);
  assert.equal(code(1135).code, 45);
  assert.equal(code(1135).obscured, undefined);
  assert.equal(code(1147).code, 48);
  assert.equal(code(1030).obscured, 'mist');
  assert.equal(LE.weatherLabel(code(1030, { text: '' })), 'Mist');
  assert.equal(code(1183).code, 61);
  assert.equal(code(1195).code, 65);
  assert.equal(code(1243).code, 81);
  assert.equal(code(1276).code, 95);
  assert.equal(code(1225).code, 75);
  assert.equal(code(1063, { precip: 0, cloud: 95 }).code, 3, 'rain possible, none falling: overcast');
  assert.equal(code(1063, { precip: 0.4 }).code, 61, 'some falling all the same: light rain');
  assert.equal(code(1087, { cloud: 60 }).code, 2, 'thunder nearby is not thunder here');
  assert.equal(code(1999).code, 3, "a code it added since: the forecast's");
  for (const [k, v] of Object.entries(LE.WAPI_CODES)) {
    if (typeof v === 'number') assert.notEqual(LE.weatherText(v), 'Unknown', `${k} → ${v} is a code the scene knows`);
  }
});

test("WeatherAPI's air quality lays smog in the valleys, thicker the dirtier the air, and none without it", () => {
  const { LE, targets } = airport();
  const now = Date.now();
  const clean = targets(LE.withWeatherApi(FORECAST_1118, WAPI_1118(now, { pm25: 5 }), now));
  const dhaka = targets(LE.withWeatherApi(FORECAST_1118, WAPI_1118(now), now));
  const worse = targets(LE.withWeatherApi(FORECAST_1118, WAPI_1118(now, { pm25: 250 }), now));
  const none = targets(FORECAST_1118);
  assert.equal(none.smog, 0, 'Open-Meteo alone: no smog');
  assert.ok(clean.smog < 0.01, `clean air: ${clean.smog}`);
  assert.ok(dhaka.smog > 0.5 && dhaka.smog < 0.8, `this morning in Dhaka: ${dhaka.smog}`);
  assert.equal(worse.smog, 1);
  assert.ok(dhaka.valleyHaze > clean.valleyHaze + 3, `thicker in the valleys: ${dhaka.valleyHaze} against ${clean.valleyHaze}`);
  assert.ok(dhaka.haze - clean.haze < 0.6, 'the sky above stays much as it was');
  const shader = readFileSync(new URL('engine/shaders/composite.js', SRC), 'utf8');
  assert.ok(shader.includes('hazeS *= mix(vec3(1.0), vec3(0.8, 0.71, 0.56), uSmog * odV / max(odM, 1e-5));'));
  const renderer = readFileSync(new URL('engine/renderer.js', SRC), 'utf8');
  assert.ok(renderer.includes("p.set('uSmog', w.smog || 0);"));
  for (const [i, word] of [[1, 'air good'], [3, 'air poor'], [6, 'air hazardous']]) assert.equal(LE.airText({ aqi: i }), word);
  assert.equal(LE.airText({ aqi: 9 }), '');
});

test('the airport report wins over WeatherAPI: its mist over their haze, and no fog where it sees none', () => {
  const { LE, merge } = airport();
  const now = Date.now();
  const both = (w, o) => merge(LE.withWeatherApi(FORECAST_1118, WAPI_1118(now, w), now), VGHS_1118(now, o), now);
  const today = both({}, {});
  assert.equal(today.visibility, 1000, 'the airport measured 1 km');
  assert.equal(today.obscured, 'mist');
  assert.equal(LE.weatherLabel(today), 'Mist', "the airport's mist, not WeatherAPI's words");
  assert.equal(today.pm25, 97.6, 'the air quality stays');
  assert.equal(LE.weatherLabel(both({ code: 1183, text: 'Patchy light rain' }, { vis: 9999, wx: '', km: 30 })), 'Patchy light rain', 'its words stand when the airport saw nothing in the air (30 km off: its rain too)');
  assert.equal(today.temp, 21);
  assert.equal(today.windSpeed, 7.6, "the wind stays WeatherAPI's");
  assert.equal(today.cloud, 70);
  assert.ok(today.wapi && today.obs, 'both are named');
  const clearAirport = both({ code: 1135, vis: 400 }, { vis: 9999, wx: '' });
  assert.notEqual(clearAirport.code, 45, 'WeatherAPI says fog, the airport sees none: no fog');
  assert.equal(clearAirport.obscured, undefined);
  assert.equal(both({ code: 1030 }, { wx: 'HZ', vis: 4000 }).obscured, 'haze', 'what the airport sees');
});

test("the weather service keeps WeatherAPI's weather from the exe and lays the airport's over it", async () => {
  const { weather } = newWeather(async () => ok({}));
  const now = Date.now();
  assert.equal(weather.setWeatherApi(WAPI_1118(now)), true);
  assert.equal(weather.setWeatherApi(WAPI_1118(now)), false, 'the same again: no change');
  assert.equal(weather.setWeatherApi({ code: 1000 }), true, 'not weather: as none');
  assert.equal(weather.wapi, null);
  weather.setWeatherApi(WAPI_1118(now));
  weather.setObservation(VGHS_1118(now));
  weather.start(23.87, 90.4);
  await sleep(30);
  weather.stop();
  const r = weather.current();
  assert.equal(r.windDir, 10, "WeatherAPI's wind");
  assert.equal(r.visibility, 1000, "the airport's visibility");
  assert.equal(r.obscured, 'mist');
  const host = readFileSync(new URL('services/host.js', SRC), 'utf8');
  assert.ok(host.includes('if (window.leSetWeatherApi) window.leSetWeatherApi(options.wapi || null);'));
  const main = readFileSync(new URL('main.js', SRC), 'utf8');
  assert.ok(main.includes('if (weather.setWeatherApi(w)) pushWeather();'));
  assert.ok(main.includes('if (ob && ob.wapi) parts.push(`WeatherAPI ${hm(ob.wapi.t)}`);'));
});

// ---------------------------------------------------------------- the test panel (?debug=1)
function panelWeather(base, fields) {
  const h = load(['config.js', 'services/astronomy.js', 'engine/environment.js', 'ui/debugpanel.js']);
  const env = new h.LE.Environment(h.LE.config);
  const rec = h.LE.testWeather(typeof base === 'string' ? h.LE.weatherPresets[base] : base, fields);
  env.setWeather(rec, 'preview');
  env.update(new Date('2026-11-03T06:00:00Z'), 1, 1);
  return { rec, w: env.state.weather, deck: [env.w.deckE, env.w.deckN] };
}

test('the panel leaves a preset as it is until a slider that decides the weather moves', () => {
  assert.equal(panelWeather('rain', {}).rec.code, 63);
  const humid = panelWeather('rain', { humidity: 40 }).rec;
  assert.equal(humid.code, 63, 'humidity alone does not change what kind of weather it is');
  assert.equal(humid.exactCloud, undefined);
  assert.equal(panelWeather('rain', { windSpeed: 90 }).rec.code, 63, 'nor does the wind');
});

test('the cloud slider gives that cover, with no jumps as it passes the weather codes', () => {
  for (const cloud of [0, 10, 11, 12, 20, 34, 35, 50, 61, 62, 63, 75, 89, 90, 100]) {
    near(panelWeather('clear', { cloud }).w.coverage, cloud / 100, 1e-9, `cover at ${cloud}%`);
  }
});

test('the rain slider never jumps as it passes the weather codes', () => {
  let last = panelWeather('overcast', { precip: 0.1 }).w.rain;
  for (let precip = 0.2; precip <= 10; precip += 0.1) {
    const { rain } = panelWeather('overcast', { precip }).w;
    assert.ok(rain >= last - 1e-9 && rain - last < 0.03, `rain ${last} to ${rain} at ${precip.toFixed(1)} mm/h`);
    last = rain;
  }
  assert.ok(last > 0.9, 'and reaches heavy rain');
});

test('temperature decides rain or snow, and thunder and visibility do what they say', () => {
  const warm = panelWeather('overcast', { precip: 3, temp: 10 }).w;
  assert.ok(warm.rain > 0.3 && warm.snow === 0, 'rain when warm');
  const cold = panelWeather('overcast', { precip: 3, temp: -5 }).w;
  assert.ok(cold.snow > 0.3 && cold.rain === 0, 'snow when cold');
  assert.ok(panelWeather('rain', { temp: -5 }).w.snow > 0.3, 'a rain preset turned cold snows');
  assert.equal(panelWeather('clear', { thunder: 1 }).w.storm, 1, 'thunder on');
  assert.equal(panelWeather('storm', { thunder: 0 }).w.storm, 0, 'thunder off in a storm');
  near(panelWeather('clear', { visibility: 300 }).w.fog, 0.9, 1e-9, 'thick fog');
  near(panelWeather('clear', { visibility: 800 }).w.fog, 0.75, 0.01, 'fog');
  near(panelWeather('clear', { visibility: 2000 }).w.fog, 0.49, 0.02, 'thin fog');
  assert.equal(panelWeather('fog', { visibility: 30000 }).w.fog, 0, 'and it clears');
});

test('on real weather, the sliders win over the data they would otherwise lose to', () => {
  const real = { code: 3, cloud: 80, cloudLow: 70, cloudMid: 40, windSpeed: 5, windDir: 90, wind850: 40, dir850: 10, wind700: 60, dir700: 20, wind300: 90, dir300: 30, temp: 20 };
  near(panelWeather(real, { cloud: 20 }).w.coverage, 0.2, 1e-9, 'layers do not decide the cover');
  const { deck } = panelWeather(real, { windSpeed: 50, windDir: 270 });
  assert.ok(deck[0] > 100 && Math.abs(deck[1]) < 1e-6, `the clouds go with this wind, not the upper winds: ${deck}`);
  assert.equal(panelWeather(real, {}).rec.wind850, 40, 'untouched, the real data stays');
});

test('the panel clock keeps what is not changing and goes back to live', () => {
  const h = load(['config.js', 'services/clock.js', 'ui/debugpanel.js']);
  h.ctx.performance = performance;
  const { LE } = h;
  const set = (change) => LE.testClock(LE.config, LE.clock, change);
  set({ time: '06:20' });
  assert.equal(LE.clock.isLive(), false);
  assert.equal(LE.clock.now().getHours(), 6);
  set({ date: '2026-07-15' });
  let d = LE.clock.now();
  assert.deepEqual([d.getMonth(), d.getDate(), d.getHours(), d.getMinutes()], [6, 15, 6, 20], 'a new day keeps the time');
  set({ timelapse: 720 });
  d = LE.clock.now();
  assert.deepEqual([d.getMonth(), d.getHours()], [6, 6], 'the time-lapse starts from what is showing');
  assert.equal(LE.clock.modeLabel(), 'Time-lapse ×720');
  set({ timelapse: 0 });
  assert.equal(LE.clock.modeLabel(), 'Preview time');
  set({ time: null });
  assert.equal(LE.clock.now().getMonth(), 6, 'the day stays when only the time goes back');
  assert.equal(LE.clock.now().getHours(), new Date().getHours());
  set({ date: null });
  assert.equal(LE.clock.isLive(), true, 'and with nothing set it is live');
});

test('every place that names the version agrees, and the download links point at that file', () => {
  const read = (f) => readFileSync(new URL('../' + f, import.meta.url), 'utf8');
  const { version } = JSON.parse(read('package.json'));
  assert.ok(read('src/config.js').includes(`version: '${version}'`), 'config.js');
  assert.ok(read('host/LivingEarthHost.cs').includes(`AssemblyFileVersion("${version}.0")`), 'the exe');
  for (const page of ['README.md', 'docs/index.html']) {
    const text = read(page);
    assert.ok(text.includes(`releases/download/v${version}/LivingEarthHimalaya-${version}.exe`), page + ' links to this version');
    assert.ok(!text.includes('LivingEarthHimalaya.exe'), page + ' has no name without a version');
  }
});

test('the app follows Edge by its job, because the process it starts can hand over to another and exit', () => {
  const host = readFileSync(new URL('../host/LivingEarthHost.cs', import.meta.url), 'utf8');
  const method = (signature) => {
    const at = host.indexOf(signature);
    assert.ok(at >= 0, signature);
    return host.slice(at, host.indexOf('\n        private ', at + signature.length));
  };
  // On the first run of a new exe the first msedge.exe lives about 30 ms. Watching only it, the app killed the real browser.
  assert.ok(method('private void KeepEdgeRunning(').includes('EdgeRunning()'), 'going by the job');
  assert.ok(method('private bool EdgeRunning(').includes('JobCounts('), 'a first process that exited is not the end while the job has others');
  const find = method('private IntPtr FindEdgeWindow(');
  assert.ok(find.includes('InEdgeJob('), 'the window can belong to the process Edge handed over to');
  assert.ok(!/GetProcessId|edgeProcess/.test(find), 'so it is not looked for by the first process');
  // Whatever the cause, the screen must not keep flashing
  assert.ok(method('private bool EdgeFailed(').includes('MaxQuickDeaths'), 'it stops trying and says so');
  // With this switch Edge opens a console window of its own when, as here, nothing it was started from has one
  assert.ok(!method('private void StartEdge(').includes('cmd.Append(" --enable-logging'), 'no terminal window on the desktop');
});

// ---- the road -------------------------------------------------------------------------------------------------------
/** A hillside like the real one: rising away from the viewer to a crest about 2.8 km off, with small bumps. */
function testHillside(R) {
  const { na, nr, az, r0, r1 } = R.GRID;
  const h = new Float32Array(na * nr);
  for (let j = 0; j < nr; j++) {
    const r = r0 + ((r1 - r0) * (j + 0.5)) / nr;
    for (let i = 0; i < na; i++) {
      const a = -az + (2 * az * (i + 0.5)) / na;
      const rise = Math.min(Math.max((r - 2.1) / 0.8, 0), 1);
      const bump = 0.012 * Math.sin(a * 0.4) * Math.cos(r * 9);
      h[j * na + i] = r < 2.9 ? 2.2 + 0.25 * rise + bump : 2.45 - 0.5 * (r - 2.9) + bump;
    }
  }
  return h;
}

function testRoad() {
  const { LE } = load(['engine/road.js']);
  const R = LE.Road;
  const line = R.plan(testHillside(R), 2.8, -0.2757);
  const ys = new Float32Array(line.length / 2).fill(2.3);
  return { R, line, road: R.finish(line, ys) };
}

/** Makes Math.random in a fake browser give the same numbers every run, for tests of what chance decides. */
function seedRandom(ctx, seed) {
  vm.runInContext(`(() => { let a = ${seed >>> 0}; Math.random = () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; })()`, ctx);
}

function testLife(hour = 12, over = {}, seed = null) {
  const { LE, ctx } = load(['engine/road.js', 'engine/life.js']);
  if (seed !== null) seedRandom(ctx, seed); // before anything is made, so the whole run repeats exactly
  const R = LE.Road;
  const line = R.plan(testHillside(R), 2.8, -0.2757);
  const road = R.finish(line, new Float32Array(line.length / 2).fill(2.3));
  const life = new LE.Life();
  life.setRoad(road);
  const state = {
    now: new Date(2026, 4, 15, hour, 0, 0),
    time: 100,
    heading: 50,
    starVis: 0,
    starMat: [1, 0, 0, 0, 1, 0, 0, 0, 1],
    windVel: [0, 0, 0],
    astro: { sunAltDeg: hour > 6 && hour < 18 ? 40 : -30, moonAltDeg: 0, moonFraction: 0, dayOfYear: 135, times: {} },
    weather: { rain: 0, snow: 0, fog: 0, storm: 0, overcast: 0, coverage: 0, windSpeed: 5, flash: 0, rainSlant: 0, ...over },
  };
  const hfov = (140 * Math.PI) / 180;
  const view = { w: 3840, h: 1080, hfov, pxAng: hfov / 3840, horizonY: 0.4, camY: 2.8 };
  return { LE, ctx, life, road, state, view };
}

/** What life wrote for the picture, one entry per sprite. */
function sprites(life) {
  const F = life.constructor.FLOATS;
  const out = [];
  for (let k = 0; k < life.count; k++) {
    const f = Array.from(life.data.slice(k * F, k * F + F));
    out.push({ type: f[5], f });
  }
  return out;
}

test('the road is smooth, evenly spaced, and starts and ends outside the widest view', () => {
  const { line, road } = testRoad();
  const n = line.length / 2;
  assert.ok(road.length > 6, 'crosses the whole view: ' + road.length);
  const azOf = (i) => (Math.atan2(line[i * 2], line[i * 2 + 1]) * 180) / Math.PI;
  assert.ok(azOf(0) < -70 && azOf(n - 1) > 70, `from ${azOf(0)} to ${azOf(n - 1)}`);
  for (let i = 1; i < n; i++) near(Math.hypot(line[i * 2] - line[i * 2 - 2], line[i * 2 + 1] - line[i * 2 - 1]), road.step, road.step * 0.3, 'spacing at ' + i);
  // no kink: the heading changes little from one point to the next
  for (let i = 2; i < n; i++) {
    const a = Math.atan2(line[i * 2 - 2] - line[i * 2 - 4], line[i * 2 - 1] - line[i * 2 - 3]);
    const b = Math.atan2(line[i * 2] - line[i * 2 - 2], line[i * 2 + 1] - line[i * 2 - 1]);
    const turn = Math.abs(Math.atan2(Math.sin(b - a), Math.cos(b - a)));
    assert.ok(turn < 0.6, `turn of ${turn} rad at point ${i}`);
  }
});

test('the bake finds the way to the road from either side of it, and nothing far from it', () => {
  const { R, road } = testRoad();
  const map = R.vectorMap(road);
  const look = (x, z) => {
    const u = Math.floor((x - map.box[0]) * map.box[2] * map.w);
    const v = Math.floor((z - map.box[1]) * map.box[3] * map.h);
    const k = (v * map.w + u) * 2;
    return [map.data[k], map.data[k + 1]];
  };
  const i = Math.floor(road.n / 2);
  const dx = road.x[i + 1] - road.x[i];
  const dz = road.z[i + 1] - road.z[i];
  const l = Math.hypot(dx, dz);
  for (const side of [-1, 1]) {
    const px = road.x[i] + (side * 0.012 * dz) / l;
    const pz = road.z[i] - (side * 0.012 * dx) / l;
    const [vx, vz] = look(px, pz);
    near(Math.hypot(vx, vz), 0.012, 0.005, 'distance to the centre');
  }
  const far = look(map.box[0] + 0.001, map.box[1] + 0.001);
  assert.ok(Math.hypot(far[0], far[1]) > 0.5, 'far from the road');
});

test('headlights show only towards the viewer, for every kind of vehicle, and are gone on a turn', () => {
  const { R } = testRoad();
  near(R.headlight(1), 1, 1e-6, 'heading straight at the viewer');
  near(R.headlight(0.8), 1, 1e-6, 'nearly straight at the viewer');
  assert.equal(R.headlight(0.4), 0, 'turned well away');
  assert.equal(R.headlight(0), 0, 'across the view');
  assert.equal(R.headlight(-1), 0, 'driving away');
  // tail lights: from behind, over a wider angle, and never from the front
  near(R.taillight(-1), 1, 1e-6, 'straight from behind');
  assert.ok(R.taillight(-0.4) > 0.99, 'from behind and to the side');
  assert.ok(R.taillight(0) > 0.5, 'most of it across the view: rear lamps wrap round the corners');
  assert.equal(R.taillight(0.3), 0, 'none from ahead');
  assert.equal(R.taillight(0.8), 0, 'from the front');
  // one rule: nothing in the vehicle's own data decides it
  const life = readFileSync(new URL('engine/life.js', SRC), 'utf8');
  assert.ok(life.includes('const lamp = lampOn * R.headlight(facing) * head.fall;'), 'the same call for all kinds, dimmed only by the distance');
  assert.equal((life.match(/headlight\(/g) || []).length, 1, 'and only that one');
});

test('vehicles pushed to the picture carry the headlight by the way they face', () => {
  const { life, road, state, view } = testLife(22);
  life._view = view;
  life.state = state;
  // find a point where one direction faces the viewer, and one where the road runs across the view
  const facingAt = (i, dir) => {
    const fx = (road.x[i + 2] - road.x[i - 2]) * dir;
    const fz = (road.z[i + 2] - road.z[i - 2]) * dir;
    const cx = -road.x[i];
    const cy = 0.5;
    const cz = -road.z[i];
    return (fx * cx + fz * cz) / (Math.hypot(fx, fz) * Math.hypot(cx, cy, cz));
  };
  let toward = -1;
  let across = -1;
  for (let i = 5; i < road.n - 5; i++) {
    if (Math.abs(Math.atan2(road.x[i], road.z[i])) > 1.1) continue;
    if (toward < 0 && facingAt(i, 1) > 0.85) toward = i;
    if (across < 0 && Math.abs(facingAt(i, 1)) < 0.1) across = i;
  }
  assert.ok(toward > 0, 'the road has a stretch that heads towards the viewer');
  assert.ok(across > 0, 'and one that runs across the view');
  for (const kind of ['bus', 'jeep', 'motorcycle', 'lorry', 'armyLorry', 'armyJeep', 'ambulance']) {
    const at = (i, dir) => {
      life.count = 0;
      life._pushVehicle(life._newVehicle(kind, dir, i * road.step), 1);
      const v = sprites(life).find((x) => x.type === 6);
      assert.ok(v, kind + ' is in view');
      return v;
    };
    const lit = at(toward, 1);
    assert.ok(lit.f[14] > 0.5 * life.constructor.headGlow(lit.f[7], 1, 0).fall, kind + ' heading towards the viewer shows its light');
    assert.equal(at(toward, -1).f[14], 0, kind + ' driving away shows none');
    assert.equal(at(across, 1).f[14], 0, kind + ' going across the view shows none');
    assert.ok(at(toward, -1).f[16] > 0.3, kind + ' driving away shows its tail lights');
    assert.equal(at(toward, 1).f[16], 0, kind + ' heading towards the viewer shows none');
  }
});

test('traffic is busy by day, thin at night, keeps its distance and slows for bends', () => {
  const day = testLife(12);
  const night = testLife(3);
  assert.ok(day.life._trafficWanted(day.state) >= 10, 'day');
  assert.ok(night.life._trafficWanted(night.state) <= 2, 'night');
  const snow = testLife(12, { snow: 0.9 });
  assert.ok(snow.life._trafficWanted(snow.state) < day.life._trafficWanted(day.state), 'snow keeps people home');

  const { life, road, state, view } = day;
  for (let k = 0; k < 2000; k++) life.update(0.5, state, view);
  assert.ok(life.vehicles.length > 3, 'vehicles keep coming: ' + life.vehicles.length);
  for (const a of life.vehicles) {
    assert.ok(a.s >= 0 && a.s <= road.length, 'stays on the road');
    assert.ok(a.v >= 0 && a.v < 0.02, 'a sane speed: ' + a.v);
    const i = Math.min(Math.round(a.s / road.step), road.n - 1);
    assert.ok(a.v <= road.limit[i] * a.bend + 0.002, `no faster than the bend allows it: ${a.v} at ${road.limit[i]} x ${a.bend}`);
    for (const b of life.vehicles) {
      if (a === b || a.dir !== b.dir) continue;
      assert.ok(Math.abs(a.s - b.s) > 0.001, 'no two in the same place going the same way');
    }
  }
});

test('vehicles drive on the left of their own direction', () => {
  const { LE, life, road, state, view } = testLife(12);
  life._view = view;
  life.state = state;
  const i = Math.floor(road.n / 2);
  const fx = road.x[i + 1] - road.x[i];
  const fz = road.z[i + 1] - road.z[i];
  // this frame has +x to the right when looking along +z, so the left of a heading (fx, fz) is (-fz, fx)
  const leftOf = (px, pz, dir) => (px - road.x[i]) * -fz * dir + (pz - road.z[i]) * fx * dir;
  for (const dir of [1, -1]) {
    const c = life._newVehicle('jeep', dir, i * road.step);
    const p = LE.Road.at(road, c.s, -c.dir * c.lane, [0, 0, 0]);
    assert.ok(leftOf(p[0], p[2], dir) > 0, 'going ' + dir + ' keeps left');
  }
});

test('vehicles do not raise the frame rate: they are too slow on the picture to need it', () => {
  const { life, state, view } = testLife(12);
  life.update(0.1, state, view);
  assert.ok(life.vehicles.length > 0);
  assert.ok(life.count > 0, 'some are in view');
  assert.equal(life.movers, 0, 'no birds, meteors or satellites, so nothing asks for more frames');
});

// ---- the options in the Windows app's window: birds, flying leaves, the panel's corner ------------------------------
test('birds off takes the birds away at once and brings no new ones, while meteors, satellites and traffic stay', () => {
  const { life, state, view } = testLife(22);
  life.seedForTest(state, view);
  life.update(0.1, state, view);
  assert.ok(life.raptors.length > 0 && life.flock && life.geese, 'birds to start with');
  assert.ok(life.meteors.length > 0 && life.sats.length > 0 && life.vehicles.length > 0);
  life.birds = false;
  life.update(0.1, state, view);
  assert.equal(life.raptors.length, 0);
  assert.equal(life.flock, null);
  assert.equal(life.geese, null);
  assert.ok(life.meteors.length > 0 && life.sats.length > 0 && life.vehicles.length > 0, 'the rest of life goes on');
  life.summon('raptor');
  life.summon('flock');
  life.summon('geese');
  life.summon('meteor');
  life.update(0.1, state, view);
  assert.ok(!life.raptors.length && !life.flock && !life.geese, 'the test panel can not bring them either');
  assert.ok(life.meteors.length > 1, 'but it can bring a meteor');
});

test('with birds off a sunny noon stays empty of them, where with birds on they come', () => {
  const on = testLife(12);
  for (let i = 0; i < 30; i++) on.life.update(2, on.state, on.view);
  assert.ok(on.life.raptors.length > 0, 'birds on: raptors in the thermals');
  const off = testLife(12);
  off.life.birds = false;
  for (let i = 0; i < 30; i++) off.life.update(2, off.state, off.view);
  assert.ok(!off.life.raptors.length && !off.life.flock && !off.life.geese);
});

test("birds fly over the valley fog an airport's mist makes, and stay in when it reports fog", () => {
  // 2026-11-18: Dhaka airport's mist at 1.4 km gave fog 0.66, which let 12 % of the birds out: none at all
  const misty = testLife(12, { fog: 0.66 });
  for (let i = 0; i < 30; i++) misty.life.update(2, misty.state, misty.view);
  assert.ok(misty.life.raptors.length > 0, 'mist: raptors in the thermals over it');
  const foggy = testLife(12, { fog: 0.9 });
  for (let i = 0; i < 30; i++) foggy.life.update(2, foggy.state, foggy.view);
  assert.ok(!foggy.life.raptors.length && !foggy.life.flock && !foggy.life.geese, 'fog: none');
});

// 2026-11-24 the user: "this birds coming from same direction everything needs to fix". The season fixed the
// skein's compass course, so with the view facing NE every autumn skein came straight at the viewer from the same place.
test('geese come from either side, change sides more often than not, and never appear or vanish in open sky', () => {
  const h = testLife(12, {}, 2911);
  const { life, state, view } = h;
  life._view = view;
  life.state = state;
  const shows = (g) => g.birds.some((b) => (b.alpha ?? 1) > 0.01 && life._birdShows(b));
  for (const [doy, season] of [[300, 'autumn'], [90, 'spring'], [190, 'summer']]) {
    for (const heading of [50, 180, 90, 270, 0]) {
      state.astro.dayOfYear = doy;
      state.heading = heading;
      life._lastGeeseSide = undefined;
      life._geeseRun = 0;
      const sides = [];
      const kinds = {};
      for (let n = 0; n < 200; n++) {
        const g = life._newGeese(state, false);
        sides.push(g.side);
        kinds[g.kind] = (kinds[g.kind] || 0) + 1;
        const what = `${season}, heading ${heading}, skein ${n} (${g.kind})`;
        assert.ok(!shows(g), 'comes in out of sight: ' + what);
        // the leader flies in front of the V
        for (const b of g.birds) {
          if (b.idx === 0) continue;
          const back = (g.lead[0] - b.pos[0]) * g.dir[0] + (g.lead[2] - b.pos[2]) * g.dir[2];
          assert.ok(back > 0.005, 'the leader in front: ' + what);
        }
        if (n % 10 === 0) {
          // flown to the end: it was seen on the way, and every bird is out of sight when it goes
          let seenAt = -1;
          let wasShowing = false;
          while (!g.dead) {
            wasShowing = shows(g);
            life._stepGeese(g, 0.5);
            if (g.seen && seenAt < 0) seenAt = g.age;
          }
          assert.ok(seenAt > 0 && g.age < g.maxAge, `seen on its way and gone by itself: ${what}, age ${g.age.toFixed(0)} of ${g.maxAge.toFixed(0)}`);
          assert.ok(!wasShowing && !shows(g), 'out of sight when it goes: ' + what);
        }
      }
      const right = sides.filter((s) => s > 0).length / sides.length;
      assert.ok(right >= 0.35 && right <= 0.65, `both sides, ${season}, heading ${heading}: ${(right * 100).toFixed(0)} % from the right`);
      for (let i = 2; i < sides.length; i++) assert.ok(!(sides[i] === sides[i - 1] && sides[i] === sides[i - 2]), `never three in a row from one side: ${season}, heading ${heading}`);
      const changes = sides.filter((s, i) => i && s !== sides[i - 1]).length / (sides.length - 1);
      assert.ok(changes > 0.55, `the next one often from the other side: ${(changes * 100).toFixed(0)} %`);
      assert.ok(kinds.cross > 130 && (kinds.toward || 0) > 5 && (kinds.away || 0) > 5, 'mostly across, some out of the peaks or into them: ' + JSON.stringify(kinds));
    }
  }
  // the test panel and the demo call one up in view: it shows at once
  for (let n = 0; n < 20; n++) {
    const g = life._newGeese(state, true);
    assert.ok(shows(g), 'summoned: in sight at once');
    life._stepGeese(g, 1);
    assert.ok(!g.dead, 'and stays');
  }
  // the season still says how often, not which way
  assert.ok(readSrc('engine/life.js').includes('this._nextGeese = season ? rand(900, 2400) : rand(5400, 14400);'));
  assert.ok(!readSrc('engine/life.js').includes('rand(195, 240)'), 'no fixed autumn course');
});

test('choughs and birds of prey come in from either side too', () => {
  const { life, state, view } = testLife(12, {}, 77);
  life._view = view;
  life.state = state;
  let flockRight = 0;
  let raptorRight = 0;
  for (let n = 0; n < 200; n++) {
    const f = life._newFlock(false);
    if (Math.atan2(f.birds[0].pos[0], f.birds[0].pos[2]) > 0) flockRight++;
    const r = life._newRaptor(false);
    if (Math.atan2(r.pos[0], r.pos[2]) > 0) raptorRight++;
  }
  assert.ok(flockRight >= 70 && flockRight <= 130, `choughs: ${flockRight} of 200 from the right`);
  assert.ok(raptorRight >= 70 && raptorRight <= 130, `raptors: ${raptorRight} of 200 from the right`);
});

test('flying leaves off clears the air at once and keeps the tree, in autumn wind and spring blossom alike', () => {
  const { fg, run } = newForeground();
  run(12, 36, [1, 0]);
  assert.ok(fg.drift.length > 5, 'leaves to start with');
  fg.r.cfg.leaves = false;
  run(1, 36, [1, 0]);
  assert.equal(fg.drift.length, 0, 'gone');
  run(12, 36, [1, 0]);
  run(12, 20, [1, 0], [1, 0, 0, 0], 80); // spring, with the blossom out
  assert.equal(fg.drift.length, 0, 'none let go');
  assert.ok(fg.enabled && fg.tree, 'the tree stays');
  fg.r.cfg.leaves = true;
  run(12, 36, [1, 0]);
  assert.ok(fg.drift.length > 5, 'and they come back when turned on');
});

test('the Windows app can have the processor draw, or give the graphics chip a share, from the address', () => {
  const gpu = load(['config.js']).LE.config;
  assert.equal(gpu.render.device, 'gpu');
  assert.equal(gpu.render.maxGpuShare, 0.5, 'half the graphics chip, as before');
  assert.equal(gpu.startStill, null);
  const small = load(['config.js'], { search: '?gpushare=0.25&quality=high' }).LE.config;
  assert.equal(small.render.maxGpuShare, 0.25);
  assert.equal(small.render.quality, 'high');
  assert.equal(load(['config.js'], { search: '?gpushare=5' }).LE.config.render.maxGpuShare, 0.9, 'never all of it');
  assert.equal(load(['config.js'], { search: '?gpushare=0' }).LE.config.render.maxGpuShare, 0.1);
  const cpu = load(['config.js'], { search: '?device=cpu&quality=high&fps=24' }).LE.config;
  assert.equal(cpu.render.device, 'cpu');
  assert.equal(cpu.render.renderScale, 0.5, 'a quarter of the pixels');
  assert.equal(cpu.render.quality, 'eco');
  assert.equal(cpu.render.fpsCap, 15);
  assert.equal(cpu.render.calmFps, 10);
  assert.equal(cpu.render.calmSceneMs, 2000);
  assert.equal(load(['config.js'], { search: '?device=cpu&test=1' }).LE.config.render.calmSceneMs, 0, 'tests still see every frame');
  assert.equal(load(['config.js'], { search: '?still=golden' }).LE.config.startStill, 'golden');
  assert.equal(load(['config.js'], { search: '?still=../../x' }).LE.config.startStill, null, 'only the stills there are');
});

test('birds, leaves and the corner come from the address, and an unknown corner is ignored', () => {
  const on = load(['config.js']).LE.config;
  assert.equal(on.birds, true);
  assert.equal(on.leaves, true);
  assert.equal(on.ui.panelPosition, 'right-bottom');
  const off = load(['config.js'], { search: '?birds=0&leaves=0&road=0&corner=left-top' }).LE.config;
  assert.equal(off.birds, false);
  assert.equal(off.leaves, false);
  assert.equal(off.road, false);
  assert.equal(off.ui.panelPosition, 'left-top');
  for (const c of ['right-top', 'left-bottom', 'left-top', 'right-bottom'])
    assert.equal(load(['config.js'], { search: `?corner=${c}` }).LE.config.ui.panelPosition, c);
  for (const c of ['middle', 'top-left', '', 'right-bottom2'])
    assert.equal(load(['config.js'], { search: `?corner=${c}` }).LE.config.ui.panelPosition, 'right-bottom', c);
});

test('the app\'s settings reach the page once, on a change, and never start the mountains over for nothing', () => {
  const h = load(['config.js', 'services/host.js'], { search: '?host=1' });
  // a script tag that loads at once: the poll then applies the options
  h.ctx.document.createElement = () => ({ remove() {} });
  h.ctx.document.head = { appendChild: (s) => s.onload() };
  const cfg = h.LE.config;
  const CORNER = ['right-bottom', 'right-top', 'left-bottom', 'left-top'];
  const calls = [];
  h.ctx.livelyPropertyListener = (name, v) => {
    calls.push([name, v]);
    if (name === 'panelPosition') cfg.ui.panelPosition = CORNER[v];
    else if (name !== 'quality') cfg[name] = v;
  };
  const all = { quality: 'auto', road: true, birds: true, leaves: true, corner: 'right-bottom' };
  h.ctx.leHostState('live', all);
  h.tick();
  assert.deepEqual(calls, [], 'the same as the page already has');
  h.ctx.leHostState('live', { ...all, road: false, leaves: false, corner: 'left-top' });
  h.tick();
  h.tick();
  h.tick();
  assert.deepEqual(calls, [['road', false], ['leaves', false], ['panelPosition', 3]], 'each change once');
  h.ctx.leHostState('live', { ...all, road: false, leaves: false, corner: 'somewhere' });
  h.tick();
  assert.equal(calls.length, 3, 'an unknown corner changes nothing');
  h.ctx.leHostState('live', { quality: 'auto' }); // an older app without these options
  h.tick();
  assert.equal(calls.length, 3, 'a missing option is left as it is');
});

test('the four corners are in the same order in the app, the page and Lively, and the page knows each option', () => {
  const read = (p) => readFileSync(new URL(p, new URL('../', import.meta.url)), 'utf8');
  const list = (text, re) => {
    const m = text.match(re);
    assert.ok(m, String(re));
    return m[1].match(/[a-z]+-[a-z]+/g);
  };
  const app = list(read('host/LivingEarthHost.cs'), /Corners = \{([^}]*)\}/);
  const main = read('src/main.js');
  assert.deepEqual(list(main, /PANEL_POS = \[([^\]]*)\]/), app, 'main.js');
  assert.deepEqual(list(read('src/services/host.js'), /CORNER = \[([^\]]*)\]/), app, 'host.js');
  const lively = JSON.parse(read('LivelyProperties.json'));
  assert.deepEqual(lively.panelPosition.items.map((s) => s.toLowerCase().replace(/ monitor · /, '-')), app, 'Lively');
  for (const name of ['road', 'birds', 'leaves']) {
    assert.ok(main.includes(`case '${name}':`), `main.js takes ${name}`);
    assert.equal(lively[name].type, 'checkbox', `Lively offers ${name}`);
  }
});

// ---- what rises from the hills: wood smoke, mist off the forest, a burning field --------------------------------------
/** Life with places for smoke in the houses and on the forest, all in view, at this hour and weather. */
function hills(hour, weather = {}) {
  const h = testLife(hour, weather);
  h.life._view = h.view;
  h.life.state = h.state;
  h.life.birds = false;
  const at = (azDeg, km) => ({ x: Math.sin((azDeg * Math.PI) / 180) * km, y: h.view.camY - 0.4, z: Math.cos((azDeg * Math.PI) / 180) * km });
  h.life.setSmokeSources([-40, -20, 0, 20, 40, 55, -55, 10].map((a, i) => at(a, 3 + i * 0.4)));
  h.life.setForestSources([-50, -35, -25, -10, 5, 15, 30, 45, 60, -60].map((a, i) => at(a, 2 + i * 0.6)));
  h.kinds = () => h.life.smoke.reduce((n, s) => ((n[s.kind] = (n[s.kind] || 0) + 1), n), {});
  h.run = (seconds, each) => {
    for (let t = 0; t < seconds; t += 1) {
      h.life.update(1, h.state, h.view);
      if (each) each(t);
    }
  };
  return h;
}

test('mist lifts off the forest when the air is humid or it has rained, one wisp after another, and not in dry air', () => {
  const humid = hills(8, { mist: 0.9, wet: 0.6 });
  humid.life._nextFire = 1e9;
  let firstAt = -1;
  let most = 0;
  humid.run(400, (t) => {
    const n = humid.kinds()[1] || 0;
    if (n > 0 && firstAt < 0) firstAt = t;
    most = Math.max(most, n);
  });
  assert.ok(firstAt >= 0 && firstAt < 40, 'the first wisp soon: ' + firstAt);
  assert.ok(most >= 4, 'several over the slopes: ' + most);
  // they come and go: after their time each one dissolves and others rise in its place
  const before = humid.life.smoke.filter((s) => s.kind === 1);
  humid.run(1200);
  const after = humid.life.smoke.filter((s) => s.kind === 1);
  assert.ok(!before.some((s) => after.includes(s)), 'the first ones have dissolved');
  assert.ok(after.length >= 3, 'and others have risen: ' + after.length);
  const dry = hills(13, { mist: 0.1, wet: 0 });
  dry.life._nextFire = 1e9;
  dry.run(300);
  assert.equal(dry.kinds()[1] || 0, 0, 'none in dry air');
  const heavy = hills(8, { mist: 0.9, wet: 1, rain: 0.95 });
  heavy.life._nextFire = 1e9;
  heavy.run(300);
  assert.equal(heavy.kinds()[1] || 0, 0, 'none in a downpour: it would not be seen');
});

test('village smoke rises through the day, most at cooking times, and a cooking fire glows at its foot after dark', () => {
  const morning = hills(10, { mist: 0.2 });
  seedRandom(morning.ctx, 7);
  morning.life._nextFire = 1e9;
  morning.run(200);
  const midMorning = morning.kinds()[0] || 0;
  assert.ok(midMorning >= 1, 'some smoke outside cooking times too: ' + midMorning);
  const cooking = hills(18, { mist: 0.2 });
  seedRandom(cooking.ctx, 7);
  cooking.life._nextFire = 1e9;
  cooking.run(200);
  assert.ok((cooking.kinds()[0] || 0) > midMorning, 'more at cooking time');
  const dusk = hills(19, { mist: 0.2 });
  dusk.state.astro.sunAltDeg = -10;
  dusk.life._nextFire = 1e9;
  dusk.run(200);
  const lit = dusk.life.smoke.filter((s) => s.kind === 0);
  assert.ok(lit.length && lit.every((s) => s.fire > 0.1), 'cooking fires glow after dark');
});

test('every village in view has a chimney, across the whole picture and the far side of the valley, not just the nearest', () => {
  const h = load(RENDER_FILES);
  const hfov = (140 * Math.PI) / 180;
  // a big village close by on the right (the one that used to take all ten), and smaller ones everywhere else
  const villages = [[50, 2.4, 40], [-62, 9, 5], [-48, 7.5, 4], [-30, 11, 6], [-15, 5.5, 5], [-3, 13, 3], [12, 8, 4], [28, 6.5, 6], [40, 14, 3], [60, 4, 5]];
  const houses = [];
  for (const [azDeg, km, n] of villages) {
    for (let i = 0; i < n; i++) {
      const a = ((azDeg + (i % 5) * 0.4 - 0.8) * Math.PI) / 180;
      const t = km + Math.floor(i / 5) * 0.05;
      houses.push({ t, a, x: Math.sin(a) * t, y: 2.4, z: Math.cos(a) * t });
    }
  }
  const chimneys = h.LE.Renderer.villageChimneys(houses, hfov);
  assert.equal(chimneys.length, villages.length, 'one for each village, and only one: ' + chimneys.length);
  for (const [azDeg, km] of villages) {
    const near = chimneys.filter((c) => Math.abs((Math.atan2(c.x, c.z) * 180) / Math.PI - azDeg) < 2 && Math.abs(Math.hypot(c.x, c.z) - km) < 0.6);
    assert.equal(near.length, 1, `the village at ${azDeg}°, ${km} km`);
  }
  // many villages: no more than 14, but still from every part of the view
  const many = [];
  for (let k = 0; k < 60; k++) {
    const a = ((-66 + k * 2.2) * Math.PI) / 180;
    const t = 2 + (k % 7) * 1.7;
    many.push({ t, a, x: Math.sin(a) * t, y: 2.4, z: Math.cos(a) * t });
  }
  const some = h.LE.Renderer.villageChimneys(many, hfov);
  assert.equal(some.length, 14);
  const parts = new Set(some.map((c) => Math.floor(((Math.atan2(c.x, c.z) / hfov) + 0.5) * 7)));
  assert.equal(parts.size, 7, 'all seven slices of the view');
  // the finder hands over what this gives, out to 16 km
  const src = readSrc('engine/renderer.js');
  assert.ok(src.includes('this.smokeSources = Renderer.villageChimneys(found, w * v.pxAng);') && src.includes('if (!(t > 1.5 && t < 16)) continue;'));
});

test('village smoke across the valley: each village its own hours, lit one after another, none flickering, all in a day', () => {
  const h = hills(5, { mist: 0.1 });
  seedRandom(h.ctx, 3);
  h.life._nextFire = 1e9;
  h.state.astro.dayOfYear = 15;
  const start = new Date(2026, 0, 15, 5, 0, 0).getTime();
  const smoked = new Set();
  const firstLit = new Map();
  const changes = [];
  const seen = new Set();
  let midday = [99, 0, 0, 0]; // fewest, most, sum, samples
  let supper = 0;
  for (let t = 0; t < 17 * 3600; t++) {
    const hr = 5 + t / 3600;
    h.state.now = new Date(start + t * 1000);
    h.state.astro.sunAltDeg = hr > 7 && hr < 17.5 ? 30 : -10;
    for (const s of h.life.smoke) if (s.kind === 0 && s.fading && !s.out) {
      s.out = true;
      changes.push(t);
      assert.ok(s.age >= 479 || s.age > s.life, 'a fire burns a good while once lit: ' + Math.round(s.age));
    }
    h.life.update(1, h.state, h.view);
    const on = h.life.smoke.filter((s) => s.kind === 0 && !s.fading);
    for (const s of on) {
      smoked.add(s.src);
      if (seen.has(s)) continue;
      seen.add(s);
      if (t > 0) changes.push(t);
      if (t > 0 && hr < 9.5 && !firstLit.has(s.src)) firstLit.set(s.src, hr);
    }
    if (hr > 10 && hr < 16) midday = [Math.min(midday[0], on.length), Math.max(midday[1], on.length), midday[2] + on.length, midday[3] + 1];
    if (hr > 18 && hr < 19) supper = Math.max(supper, on.length);
  }
  assert.equal(smoked.size, 8, 'every village smokes some time in the day: ' + smoked.size);
  const mornings = [...firstLit.values()];
  assert.ok(mornings.length >= 3 && Math.max(...mornings) - Math.min(...mornings) > 0.5, 'the morning fires lit over the best part of an hour or more: ' + mornings.map((x) => x.toFixed(2)));
  changes.sort((p, q) => p - q);
  const gaps = changes.slice(1).map((c, i) => c - changes[i]).filter((g) => g < 14);
  assert.ok(gaps.length <= changes.length * 0.05, 'one village at a time, not together: ' + gaps.length + ' of ' + changes.length + ' within 14 s');
  // in January a village keeps a fire in much of the day, some more than others, and they come and go
  const mean = midday[2] / midday[3];
  assert.ok(midday[0] >= 1 && midday[1] - midday[0] >= 2 && mean >= 2.5 && mean <= 6.5, 'through the day, coming and going: ' + midday.slice(0, 2) + ', ' + mean.toFixed(1) + ' on average');
  assert.ok(supper >= 6, 'nearly all at supper in winter: ' + supper);
  // each its own: not one look for all of them
  const looks = new Set([...seen].map((s) => [s.rise, s.width, s.target, s.seed].map((x) => x.toFixed(3)).join()));
  assert.equal(looks.size, seen.size, 'no two alike');
  // when the scene first shows, those already smoking are each at their own stage
  const first = hills(18, { mist: 0.1 });
  seedRandom(first.ctx, 5);
  first.life._nextFire = 1e9;
  first.state.astro.dayOfYear = 15;
  first.run(2);
  const ages = first.life.smoke.filter((s) => s.kind === 0).map((s) => s.age).sort((p, q) => p - q);
  assert.ok(ages.length >= 4 && ages[ages.length - 1] - ages[0] > 600, 'already going, each at its own stage: ' + ages.map(Math.round));
});

test('now and then a field burns on a hill: a tall plume, glowing by night, and put out by rain', () => {
  const h = hills(14, { mist: 0.1, wet: 0 });
  h.life._nextFire = 5;
  let seen = null;
  for (let tries = 0; tries < 20 && !seen; tries++) {
    h.run(10);
    seen = h.life.smoke.find((s) => s.kind === 2);
    if (!seen) h.life._nextFire = 1;
  }
  assert.ok(seen, 'a fire started');
  assert.ok(seen.rise >= 0.45 && seen.fire === 1, 'tall, with a fire at its foot');
  assert.equal(h.life.smoke.filter((s) => s.kind === 2).length, 1, 'one at a time');
  // drawn in 3D as smoke of its own kind, with its fire, and the glow where it burns as a small picture
  h.life._write(h.state);
  const codes = Array.from({ length: h.life.plumeCount }, (_, i) => h.life.plumeC[i * 4 + 3]);
  assert.ok(codes.some((c) => Math.floor(c) === 2 && Math.abs((c % 1) * 2 - 1) < 1e-6), 'the volume pass is told it is a burning field, on fire: ' + codes);
  const glow = sprites(h.life).find((x) => x.type === 5 && x.f[11] === 2);
  assert.ok(glow && glow.f[12] === 1 && glow.f[2] <= 30, 'and a small patch for the glow of its fire');
  h.state.weather.rain = 0.6;
  h.run(400);
  assert.ok(!h.life.smoke.some((s) => s.kind === 2), 'rain puts it out');
});

// The chance of a fire had a floor of a quarter in any weather, and only rain over 0.3 put one out: in drizzle a field
// caught and burned on (the user: "during rain forest fire should not trigger", 2026-11-22).
test('no field catches fire in drizzle, rain or snow, or on soaked ground, and drizzle puts a burning one out', () => {
  for (const [what, weather] of [
    ['light drizzle', { rain: 0.12 }],
    ['drizzle', { rain: 0.3 }],
    ['rain', { rain: 0.6 }],
    ['snow', { snow: 0.4 }],
    ['ground soaked after rain', { wet: 0.8 }],
  ]) {
    const h = hills(14, { mist: 0.1, wet: 0, ...weather });
    seedRandom(h.ctx, 11);
    for (let tries = 0; tries < 60; tries++) {
      h.life._nextFire = 1;
      h.run(3);
    }
    assert.ok(!h.life.smoke.some((s) => s.kind === 2), what + ': none in 60 chances');
  }
  // the same chances in dry weather do bring one, so the check above can fail
  const dry = hills(14, { mist: 0.1, wet: 0 });
  seedRandom(dry.ctx, 11);
  for (let tries = 0; tries < 60 && !dry.life.smoke.some((s) => s.kind === 2); tries++) {
    dry.life._nextFire = 1;
    dry.run(3);
  }
  assert.ok(dry.life.smoke.some((s) => s.kind === 2), 'dry: a fire starts');
  dry.state.weather.rain = 0.12;
  dry.run(600);
  assert.ok(!dry.life.smoke.some((s) => s.kind === 2), 'light drizzle puts it out');
});

test('mist off the forest is drawn in 3D: low patches for the volume pass, nearest first, carried downwind, no pictures', () => {
  const h = hills(8, { mist: 0.9, wet: 0.6 });
  h.life._nextFire = 1e9;
  const toward = 1; // radians from the view's axis
  h.state.windVel = [(Math.sin(toward) * 7) / 3600, 0, (Math.cos(toward) * 7) / 3600];
  h.life.summon('mist');
  h.run(120);
  h.life._write(h.state);
  const L = h.life;
  const isMist = (i) => L.plumeC[i * 4 + 3] === 0;
  const mists = Array.from({ length: L.plumeCount }, (_, i) => i).filter(isMist);
  assert.ok(mists.length >= 3 && mists.length <= 8 && L.plumeCount <= 16, 'patches: ' + mists.length + ' of ' + L.plumeCount);
  assert.ok(!sprites(L).some((x) => x.type === 5 && x.f[11] === 1), 'no flat pictures of mist');
  let last = 0;
  for (let i = 0; i < L.plumeCount; i++) {
    const [x, y, z, H] = L.plumeA.slice(i * 4, i * 4 + 4);
    const [r, amt, sx, sz] = L.plumeB.slice(i * 4, i * 4 + 4);
    const d = Math.hypot(x, y - h.view.camY, z);
    assert.ok(d >= last - 0.02, 'nearest first'); // (mist's foot is set 15 m into the canopy)
    last = d;
    if (!isMist(i)) continue;
    assert.ok(H > 0.03 && H <= 0.33, 'height ' + H);
    assert.ok(r >= 0.15 && r <= 0.35, 'radius ' + r);
    assert.ok(2 * r > H, 'wider than it is tall, as mist lies on a forest: ' + r + ', ' + H);
    assert.ok(amt > 0 && amt <= 1, 'amount ' + amt);
    assert.ok(sx * Math.sin(toward) + sz * Math.cos(toward) > 0, 'its top is carried downwind');
    const [, fx, fy] = L.plumeC.slice(i * 4, i * 4 + 4);
    assert.ok(Number.isFinite(fx) && Number.isFinite(fy), 'its foot on the picture');
  }
  // it forms low over the canopy, then rises: one place on the forest, so the one column is that one
  const one = hills(8, { mist: 0.9, wet: 0.6 });
  one.life._nextFire = 1e9;
  one.life.setForestSources([one.life.forestSources[4]]);
  one.life.villageSmoke = false; // smoke is drawn the same way: only the mist here
  one.life.summon('mist');
  for (const m of one.life.smoke) m.age = 0; // summoned ones are put up part way through their lives
  one.life._write(one.state);
  assert.equal(one.life.plumeCount, 1);
  const low = one.life.plumeA[3];
  one.run(200);
  one.life._write(one.state);
  assert.equal(one.life.plumeCount, 1);
  assert.ok(one.life.plumeA[3] > low * 2.2, 'starts low and rises: ' + low + ' then ' + one.life.plumeA[3]);
  h.life.enabled = false;
  h.run(400);
  h.life._write(h.state);
  assert.equal(h.life.plumeCount, 0, 'gone when it has dissolved');
});

test("by night a village's smoke is a pale haze lit by the lamps below it, not a black veil over them", () => {
  const vol = readSrc('engine/shaders/volume.js');
  // it hides less in the dark, turns from daylight blue to pale grey, and is not dimmed as the mist is
  assert.ok(vol.includes('kind == 1 ? mix(12.0, 4.5, dark)'), 'thinner by night');
  assert.ok(vol.includes('mix(vec3(0.4, 0.45, 0.56), vec3(0.74, 0.77, 0.83), dark)'), 'pale by night, the day colour kept');
  assert.ok(vol.includes('(kind == 1 ? mix(1.0, 0.7, dark) : nightDim)'), 'only mist and field smoke take the night dimming');
  assert.ok(vol.includes('if (kind == 1) Sc += vec3(1.0, 0.62, 0.3) * uHeadE * uLampGlow'), 'lit warm from below');
  // the lamps' share comes from the environment, and is none with the lights or the life switched off
  assert.ok(readSrc('engine/renderer.js').includes("p.set('uLampGlow', this.cfg.life === false || this.cfg.lights === false ? 0 : state.lampGlow || 0);"));
  assert.ok(readSrc('engine/environment.js').includes('s.lampGlow = smooth(-1, -7, sunAlt);'));
});

test('smoke is drawn in 3D and leans the way the weather blows, and a field fire is lit a few km off where it shows', () => {
  for (const toward of [Math.PI / 2, -Math.PI / 2, 0, 2.5]) {
    const h = hills(13, { mist: 0.1, wet: 0 });
    h.life._nextFire = 1e9;
    h.state.windVel = [(Math.sin(toward) * 12) / 3600, 0, (Math.cos(toward) * 12) / 3600];
    h.life.summon('smoke');
    h.life.summon('fire');
    h.life._write(h.state);
    const L = h.life;
    let smoke = 0;
    for (let i = 0; i < L.plumeCount; i++) {
      const code = Math.floor(L.plumeC[i * 4 + 3]);
      if (code === 0) continue;
      smoke++;
      const H = L.plumeA[i * 4 + 3];
      const [r, amt, sx, sz] = L.plumeB.slice(i * 4, i * 4 + 4);
      assert.ok(sx * Math.sin(toward) + sz * Math.cos(toward) > 0.5 * H, 'its top carried downwind: ' + [toward, sx, sz, H]);
      assert.ok(r > 0.01 && r <= 0.16 && amt > 0 && H > 0.03, 'a column, not a sheet: ' + [r, amt, H]);
    }
    assert.ok(smoke >= 2, 'houses and the field: ' + smoke);
    assert.ok(!sprites(L).some((x) => x.type === 5 && x.f[2] > 30), 'no flat pictures of smoke');
  }
  // the fire: on a slope 3 to 8 km off whenever there is forest there
  for (let i = 0; i < 20; i++) {
    const h = hills(13, { mist: 0.1, wet: 0 });
    const near = h.life.forestSources.some((s) => {
      const d = Math.hypot(s.x, s.y - h.view.camY, s.z);
      return d > 3 && d < 8;
    });
    h.life.summon('fire');
    const f = h.life.smoke.find((s) => s.kind === 2);
    assert.ok(f, 'a fire');
    const d = Math.hypot(f.src.x, f.src.y - h.view.camY, f.src.z);
    if (near) assert.ok(d > 3 && d < 8, 'a few km off: ' + d);
  }
});

test('mist, smoke and a fire put up from the debug panel stay in dry air for their time, then go', () => {
  const h = hills(13, { mist: 0.1, wet: 0 });
  h.life._nextFire = 1e9;
  h.life.summon('mist');
  h.life.summon('smoke');
  for (const s of h.life.smoke) s.age = 0;
  const kinds = h.kinds();
  assert.ok((kinds[1] || 0) >= 3 && (kinds[0] || 0) >= 1, 'put up: ' + JSON.stringify(kinds));
  h.run(60);
  const still = h.kinds();
  assert.equal(still[1] || 0, kinds[1], 'the mist is not taken away by the dry air');
  assert.ok((still[0] || 0) >= kinds[0], 'nor the smoke by the hour');
  h.life._write(h.state);
  assert.ok(h.life.plumeCount >= 3, 'and the mist is drawn');
  h.run(800);
  assert.equal(h.kinds()[1] || 0, 0, 'gone at the end of its time');
});

test('mist, smoke and fire all go when life is turned off', () => {
  const h = hills(8, { mist: 0.9, wet: 0.6 });
  h.life.summon('mist');
  h.life.summon('fire');
  assert.ok((h.kinds()[1] || 0) > 0 && (h.kinds()[2] || 0) === 1, 'summoned for tests');
  h.life.enabled = false;
  h.run(400);
  assert.equal(h.life.smoke.length, 0);
});

test('everything in the scene can be turned off, from the address, the app and Lively, and the scene follows', () => {
  const on = load(['config.js']).LE.config;
  for (const k of ['mist', 'banners', 'smoke', 'fires', 'lights', 'shootingStars', 'planes', 'rainbow', 'road', 'birds', 'leaves']) assert.equal(on[k], true, k + ' on to start with');
  assert.equal(on.render.tree, true);
  assert.equal(on.ui.showPanel, true);
  const off = load(['config.js'], { search: '?mist=0&banners=0&smoke=0&fires=0&lights=0&stars=0&planes=0&rainbow=0&tree=0&panel=0' }).LE.config;
  for (const k of ['mist', 'banners', 'smoke', 'fires', 'lights', 'shootingStars', 'planes', 'rainbow']) assert.equal(off[k], false, k + ' off from the address');
  assert.equal(off.render.tree, false);
  assert.equal(off.ui.showPanel, false);

  // from the app: each switch passed on once, on a change, under Lively's name for it
  const a = load(['config.js', 'services/host.js'], { search: '?host=1' });
  a.ctx.document.createElement = () => ({ remove() {} });
  a.ctx.document.head = { appendChild: (x) => x.onload() };
  const calls = [];
  a.ctx.livelyPropertyListener = (name, v) => calls.push([name, v]);
  const all = {
    quality: 'auto', road: true, traffic: 'normal', birds: true, leaves: true, tree: true, mist: true, banners: true, smoke: true, fires: true,
    lights: true, stars: true, planes: true, rainbow: true, flags: true, animals: true, panel: true, corner: 'right-bottom', panelSize: 'medium',
  };
  a.ctx.leHostState('live', all);
  a.tick();
  assert.deepEqual(calls, []);
  a.ctx.leHostState('live', { ...all, tree: false, mist: false, banners: false, smoke: false, fires: false, lights: false, stars: false, planes: false, rainbow: false, flags: false, animals: false, panel: false });
  a.tick();
  const names = calls.map((c) => c[0]).sort();
  assert.deepEqual(names, ['animals', 'banners', 'fires', 'flags', 'lights', 'mist', 'planes', 'rainbow', 'showPanel', 'smoke', 'stars', 'tree']);
  assert.ok(calls.every((c) => c[1] === false));

  // Lively offers each one, on to start with, and the page knows each name
  const read = (f) => readFileSync(new URL(f, new URL('../', import.meta.url)), 'utf8');
  const lively = JSON.parse(read('LivelyProperties.json'));
  const main = read('src/main.js');
  for (const k of ['tree', 'mist', 'banners', 'smoke', 'fires', 'lights', 'stars', 'planes', 'rainbow', 'flags', 'animals', 'birds', 'leaves', 'road', 'showPanel']) {
    assert.equal(lively[k] && lively[k].type, 'checkbox', 'Lively has ' + k);
    assert.equal(lively[k].value, true, k + ' on in Lively');
    assert.ok(main.includes(`case '${k}':`), 'main.js handles ' + k);
  }
  // the app keeps each one, and passes it to the page at start and while running
  const cs = read('host/LivingEarthHost.cs');
  for (const k of ['tree', 'mist', 'banners', 'smoke', 'fires', 'lights', 'stars', 'planes', 'rainbow', 'flags', 'animals', 'panel']) {
    assert.ok(cs.includes(`"${k}="`), 'saved: ' + k);
    assert.ok(cs.includes(`TryGetValue("${k}"`), 'read back: ' + k);
    assert.ok(cs.includes(`"&${k}=0"`), 'in the address: ' + k);
    assert.ok(cs.includes(`", ${k}: "`), 'in state.js: ' + k);
  }
  assert.ok(read('src/engine/renderer.js').includes('this.cfg.lights === false ? 0'), 'village lights off');

  // life follows: nothing of a kind that is off, not even from the test panel
  const h = hills(8, { mist: 0.9, wet: 0.6 });
  h.life.mist = false;
  h.life.villageSmoke = false;
  h.life.fires = false;
  h.life.shootingStars = false;
  for (const k of ['mist', 'smoke', 'fire', 'meteor', 'satellite']) h.life.summon(k);
  assert.equal(h.life.smoke.length, 0, 'nothing put up');
  assert.equal(h.life.meteors.length + h.life.sats.length, 0, 'no meteor or satellite');
  h.life._nextFire = 1;
  h.run(300);
  assert.equal(h.life.smoke.length, 0, 'nothing rises of itself');
  // turning one off while it is up: it dissolves
  h.life.mist = true;
  h.life.summon('mist');
  assert.ok(h.life.smoke.length > 0);
  h.life.mist = false;
  h.run(200);
  assert.equal(h.life.smoke.length, 0, 'what was up has dissolved');
  h.life._write(h.state);
  assert.equal(h.life.plumeCount, 0);
});

test('how much traffic: light, normal or busy, from the address and from the app, and the road holds that much', () => {
  assert.equal(load(['config.js']).LE.config.traffic, 'normal');
  for (const t of ['light', 'normal', 'busy']) assert.equal(load(['config.js'], { search: `?traffic=${t}` }).LE.config.traffic, t);
  assert.equal(load(['config.js'], { search: '?traffic=jam' }).LE.config.traffic, 'normal', 'an unknown amount is ignored');
  // how many the road wants at midday, for each
  const { life, state, view } = testLife(12);
  const n = {};
  for (const t of ['light', 'normal', 'busy']) {
    life.traffic = t;
    n[t] = life._trafficWanted(state);
  }
  assert.ok(n.light < n.normal * 0.6 && n.light >= 3, 'light: ' + JSON.stringify(n));
  assert.ok(n.busy > n.normal * 1.5, 'busy: ' + JSON.stringify(n));
  // a busy road fills up, and nothing drives through anything on it
  life.traffic = 'busy';
  const lanes = (c) => (c.side < 0.7 ? 1 : 0) | (c.side > 0.3 ? 2 : 0);
  let most = 0;
  for (let k = 0; k < 1500; k++) {
    life.update(0.5, state, view);
    most = Math.max(most, life.vehicles.length);
    const vs = life.vehicles;
    for (let a = 0; a < vs.length; a++)
      for (let b = a + 1; b < vs.length; b++) {
        const A = vs[a];
        const B = vs[b];
        const la = lanes(A);
        const lb = A.dir === B.dir ? lanes(B) : ((lanes(B) & 1) << 1) | ((lanes(B) & 2) >> 1);
        if (!(la & lb)) continue;
        assert.ok((A.len + B.len) / 2 - Math.abs(A.s - B.s) < 0.0005, `busy road: ${A.kind} and ${B.kind} overlap at step ${k}`);
      }
  }
  assert.ok(most > n.normal, 'more on the road than a normal day: ' + most);
  // from the app: once, on a change
  const a = load(['config.js', 'services/host.js'], { search: '?host=1' });
  a.ctx.document.createElement = () => ({ remove() {} });
  a.ctx.document.head = { appendChild: (x) => x.onload() };
  const calls = [];
  a.ctx.livelyPropertyListener = (name, v) => {
    calls.push([name, v]);
    if (name === 'traffic') a.LE.config.traffic = ['light', 'normal', 'busy'][v];
  };
  const all = { quality: 'auto', road: true, traffic: 'normal', birds: true, leaves: true, corner: 'right-bottom', panelSize: 'medium' };
  a.ctx.leHostState('live', all);
  a.tick();
  assert.deepEqual(calls, []);
  a.ctx.leHostState('live', { ...all, traffic: 'busy' });
  a.tick();
  a.tick();
  assert.deepEqual(calls, [['traffic', 2]]);
  // the same order in the app, the page and Lively
  const read = (f) => readFileSync(new URL(f, new URL('../', import.meta.url)), 'utf8');
  const words = (text, re) => text.match(re)[1].match(/[a-z]+/g);
  const app = words(read('host/LivingEarthHost.cs'), /Traffics = \{([^}]*)\}/);
  assert.deepEqual(app, ['light', 'normal', 'busy']);
  assert.deepEqual(words(read('src/main.js'), /TRAFFIC = \[([^\]]*)\]/), app, 'main.js');
  assert.deepEqual(words(read('src/services/host.js'), /TRAFFIC = \[([^\]]*)\]/), app, 'host.js');
  const lively = JSON.parse(read('LivelyProperties.json')).traffic;
  assert.deepEqual(lively.items.map((x) => x.toLowerCase()), app, 'Lively');
  assert.equal(lively.value, 1, 'Lively starts on normal');
});

test('the panel comes in three sizes: from the address, from the app, and grown from its own corner', () => {
  assert.equal(load(['config.js']).LE.config.ui.panelSize, 'medium', 'medium unless asked');
  for (const z of ['small', 'medium', 'large']) assert.equal(load(['config.js'], { search: `?panelsize=${z}` }).LE.config.ui.panelSize, z);
  assert.equal(load(['config.js'], { search: '?panelsize=huge' }).LE.config.ui.panelSize, 'medium', 'an unknown size is ignored');
  // the class the panel gets
  const h = load(['config.js', 'ui/overlay.js'], { search: '?panelsize=large&corner=left-top' });
  const root = { style: {}, className: '', querySelectorAll: () => [] };
  new h.LE.Overlay(root, h.LE.config);
  assert.equal(root.className, 'panel pos-left-top size-large');
  // from the app: once, on a change
  const a = load(['config.js', 'services/host.js'], { search: '?host=1' });
  a.ctx.document.createElement = () => ({ remove() {} });
  a.ctx.document.head = { appendChild: (x) => x.onload() };
  const calls = [];
  a.ctx.livelyPropertyListener = (name, v) => {
    calls.push([name, v]);
    if (name === 'panelSize') a.LE.config.ui.panelSize = ['small', 'medium', 'large'][v];
  };
  const all = { quality: 'auto', road: true, birds: true, leaves: true, corner: 'right-bottom', panelSize: 'medium' };
  a.ctx.leHostState('live', all);
  a.tick();
  assert.deepEqual(calls, []);
  a.ctx.leHostState('live', { ...all, panelSize: 'small' });
  a.tick();
  a.tick();
  assert.deepEqual(calls, [['panelSize', 0]]);
  a.ctx.leHostState('live', { ...all, panelSize: 'giant' });
  a.tick();
  assert.equal(calls.length, 1, 'an unknown size changes nothing');
  // the same order everywhere, and each corner scales towards itself so the panel never runs off the screen
  const read = (f) => readFileSync(new URL(f, new URL('../', import.meta.url)), 'utf8');
  const words = (text, re) => text.match(re)[1].match(/[a-z]+/g);
  const app = words(read('host/LivingEarthHost.cs'), /PanelSizes = \{([^}]*)\}/);
  assert.deepEqual(app, ['small', 'medium', 'large']);
  assert.deepEqual(words(read('src/main.js'), /PANEL_SIZE = \[([^\]]*)\]/), app, 'main.js');
  assert.deepEqual(words(read('src/services/host.js'), /PANEL_SIZE = \[([^\]]*)\]/), app, 'host.js');
  const lively = JSON.parse(read('LivelyProperties.json')).panelSize;
  assert.deepEqual(lively.items.map((x) => x.toLowerCase()), app, 'Lively');
  assert.equal(lively.value, 1, 'Lively starts on medium');
  const css = read('src/styles/main.css');
  for (const c of ['right-bottom', 'right-top', 'left-bottom', 'left-top']) {
    const rule = css.match(new RegExp(`\\.pos-${c} \\{([^}]*)\\}`))[1];
    assert.ok(rule.includes(`transform-origin: ${c.replace('-', ' ')};`), c);
  }
  assert.match(css, /\.size-small \{\s*transform: scale\(0\.\d+\);/);
  assert.match(css, /\.size-large \{\s*transform: scale\(1\.\d+\);/);
});

test('the app finds the desktop\'s wallpaper layer again each time, since Explorer can replace it after the start', () => {
  const host = readFileSync(new URL('../host/LivingEarthHost.cs', import.meta.url), 'utf8');
  const method = (signature) => {
    const at = host.indexOf(signature);
    assert.ok(at >= 0, signature);
    return host.slice(at, host.indexOf('\n        private ', at + signature.length));
  };
  // At sign-in on 2026-11-08 a new WorkerW came in front of the wallpaper and stayed there: the check compared
  // the order against the handle found at the start, which no longer existed
  assert.ok(method('private void Place(').includes('FindLayers()'), 'looks the layers up again');
  const order = method('private bool IsAboveWorkerW(');
  assert.ok(order.includes('ClassOf(w) == "WorkerW"'), 'any wallpaper layer counts');
  assert.ok(!order.includes('w == workerW'), 'not only the one seen first');
});

// ---- life on the road: overtaking, stops, beams, brake lights and the light thrown ahead -----------------------------
/** A quiet road with only the vehicles a test puts on it. */
function quietRoad(hour) {
  const h = testLife(hour);
  h.life._view = h.view;
  h.life.state = h.state;
  h.life._trafficSeeded = true;
  h.life._nextVehicle = 1e9;
  h.life._nextConvoy = 1e9;
  h.life._nextAmbulance = 1e9;
  h.life.birds = false; // only the road
  h.put = (kind, dir, i, over = {}) => {
    const c = Object.assign(h.life._newVehicle(kind, dir, i * h.road.step), over);
    h.life.vehicles.push(c);
    return c;
  };
  h.run = (seconds, each) => {
    for (let t = 0; t < seconds; t += 0.25) {
      h.life.update(0.25, h.state, h.view);
      if (each) each(t);
    }
  };
  return h;
}
const STRAIGHT = 740; // the start of a 0.9 km straight on the test road

test('a faster vehicle overtakes a slow bus on a straight when nothing is coming, indicating out and back in', () => {
  const h = quietRoad(12);
  const bus = h.put('bus', 1, STRAIGHT + 4, { cruise: 0.005, stopIn: Infinity });
  const bike = h.put('motorcycle', 1, STRAIGHT, { cool: 0, v: 0.005 });
  const seen = { right: false, out: false, left: false };
  h.run(60, () => {
    if (bike.blink === 2) seen.right = true;
    if (bike.side > 0.9) seen.out = true;
    if (seen.out && bike.blink === 1) seen.left = true;
    // never through the bus while both are in the same lane
    if (bike.side < 0.5) assert.ok(Math.abs(bike.s - bus.s) >= (bike.len + bus.len) / 2 - 1e-4, 'no collision');
  });
  assert.ok(seen.right, 'indicated right before pulling out');
  assert.ok(seen.out, 'went out into the other lane');
  assert.ok(seen.left, 'indicated left to come back in');
  assert.ok(bike.s > bus.s + (bike.len + bus.len) / 2, 'is now in front of the bus');
  assert.ok(bike.side < 0.05 && !bike.pass, 'and back in its own lane');
});

// each kind as it comes, without the spread every driver gets
const AS_BUILT = {
  bus: { cruise: 0.0078, bend: 0.78, accel: 0.6e-3, stopIn: Infinity },
  jeep: { cruise: 0.011, bend: 1.0, accel: 1.2e-3 },
  motorcycle: { cruise: 0.0145, bend: 1.22, accel: 2.0e-3 },
  lorry: { cruise: 0.0072, bend: 0.74, accel: 0.5e-3 },
};
/** Seconds until the last of `kinds` (a line, front first, 40 m apart, all at their pace) is past all the others, or -1. */
function secondsToPass(kinds, at, dir, limit, each) {
  const h = quietRoad(12);
  const start = dir > 0 ? at : h.road.n - 1 - at;
  const line = kinds.map((k, j) => {
    const c = h.put(k, dir, start - dir * 5 * j, AS_BUILT[k]); // the default wait before it thinks of overtaking
    c.v = Math.min(c.cruise, h.road.limit[start - dir * 5 * j] * c.bend);
    return c;
  });
  const last = line[line.length - 1];
  for (let t = 0; t < limit; t += 0.25) {
    h.life.update(0.25, h.state, h.view);
    if (each) each(h, line);
    if (line.slice(0, -1).every((o) => (last.s - o.s) * dir > (last.len + o.len) / 2)) return t;
  }
  return -1;
}

test('on an empty road a faster vehicle caught behind a slower one gets past it soon, every time and anywhere', () => {
  // the places: the far end of the road, the long straight, a winding stretch near the start; both ways
  for (const kinds of [['jeep', 'motorcycle'], ['bus', 'jeep'], ['bus', 'motorcycle']]) {
    for (const at of [150, STRAIGHT, 1250]) {
      for (const dir of [1, -1]) {
        const t = secondsToPass(kinds, at, dir, 120);
        assert.ok(t >= 0 && t < 100, `${kinds[1]} behind a ${kinds[0]} at ${at}, going ${dir}: past in ${t} s`);
      }
    }
  }
});

test('a motorcycle behind a bus with a jeep close behind it gets past both in one go', () => {
  for (const at of [150, STRAIGHT]) {
    for (const dir of [1, -1]) {
      let outs = 0;
      let wasOut = false;
      const t = secondsToPass(['bus', 'jeep', 'motorcycle'], at, dir, 120, (h, line) => {
        const bike = line[2];
        const out = bike.side > 0.5;
        if (out && !wasOut) outs++;
        wasOut = out;
      });
      assert.ok(t >= 0 && t < 100, `past both at ${at}, going ${dir}: ${t} s`);
      assert.equal(outs, 1, 'out once, not in between them');
    }
  }
});

test('overtaking never ends in a bus standing at a stop just beyond the one it passes', () => {
  // a slow jeep, and the bus far enough on that it passes the jeep alone, then near enough that it can't stop for it
  // (without the room to slow down in, the motorcycle ran into the bus in each of these)
  for (const [jv, gap] of [[0.004, 12], [0.006, 14], [0.008, 18], [0.007, 6]]) {
    const h = quietRoad(12);
    const jeep = h.put('jeep', 1, STRAIGHT + 5, { ...AS_BUILT.jeep, cruise: jv, v: jv, cool: 1e9 });
    const bus = h.put('bus', 1, STRAIGHT + 5 + gap, { ...AS_BUILT.bus, v: 0, side: -0.5, sideTarget: -0.5, stopFor: 1e9, blink: 3, blinkFor: 99 });
    const bike = h.put('motorcycle', 1, STRAIGHT, { ...AS_BUILT.motorcycle, v: jv, cool: 0 });
    h.run(90, () => {
      for (const [a, b] of [[bike, bus], [bike, jeep], [jeep, bus]]) {
        if (a.side < 0.7 && b.side < 0.7) assert.ok(Math.abs(a.s - b.s) >= (a.len + b.len) / 2 - 5e-4, `${a.kind} into the ${b.kind} (bus ${gap * 8} m on)`);
      }
    });
    assert.ok(bike.s > bus.s + (bike.len + bus.len) / 2 && bike.side < 0.05, `past the jeep and the bus, and back in (bus ${gap * 8} m on)`);
  }
});

test('nobody overtakes towards something coming the other way', () => {
  const h = quietRoad(12);
  h.put('bus', 1, STRAIGHT + 4, { cruise: 0.005, stopIn: Infinity });
  const bike = h.put('motorcycle', 1, STRAIGHT, { cool: 0, v: 0.005 });
  const jeep = h.put('jeep', -1, STRAIGHT + 40);
  h.run(30, () => {
    if ((jeep.s - bike.s) * bike.dir > 0) assert.ok(bike.side < 0.5, 'stays in its lane while the jeep is ahead');
  });
});

test('a bus stops with its hazard lights on, then indicates right and pulls out', () => {
  const h = quietRoad(12);
  const bus = h.put('bus', 1, STRAIGHT, { stopIn: 0.001 });
  let stopped = false;
  let hazards = false;
  let indicated = false;
  h.run(80, () => {
    if (bus.v < 0.0003 && bus.stopFor > 0) stopped = true;
    if (stopped && bus.blink === 3) hazards = true;
    if (hazards && bus.blink === 2) indicated = true;
  });
  assert.ok(stopped && hazards && indicated, `stopped ${stopped}, hazards ${hazards}, indicated ${indicated}`);
  assert.ok(bus.v > 0.004 && Math.abs(bus.side) < 0.05, 'and is on its way again in its lane');
});

test('a busy day on the road: nothing ever drives through anything, overtaking and stops happen, and nobody is stuck', () => {
  const { life, state, view } = testLife(12);
  let passes = 0;
  let stops = 0;
  // seconds of driving, and of those caught behind a clearly slower one with nothing coming the other way for a km
  let driving = 0;
  let stuck = 0;
  // lanes a vehicle takes up: its own, the other, or both while it moves across
  const lanes = (c) => (c.side < 0.7 ? 1 : 0) | (c.side > 0.3 ? 2 : 0);
  for (let k = 0; k < 4000; k++) {
    life.update(0.5, state, view);
    for (const c of life.vehicles) {
      if (c.pass && c.pass.phase === 1 && c.side > 0.9 && !c.counted) {
        c.counted = true;
        passes++;
      }
      if (c.stopFor > 0 && !c.stopCounted) {
        c.stopCounted = true;
        stops++;
      }
      if (c.side > 0.05 || c.stopFor > 0 || c.stopping) continue;
      driving += 0.5;
      let ahead = null;
      let gap = 1e9;
      let coming = 1e9;
      for (const o of life.vehicles) {
        const g = (o.s - c.s) * c.dir - (o.len + c.len) / 2;
        if (o === c || g <= 0) continue;
        if (o.dir !== c.dir) coming = Math.min(coming, g);
        else if (o.side < 0.7 && g < gap) [ahead, gap] = [o, g];
      }
      if (ahead && gap < 0.06 && ahead.cruise < c.cruise * 0.9 && c.v < c.cruise * 0.9 && coming > 1) stuck += 0.5;
    }
    const vs = life.vehicles;
    for (let a = 0; a < vs.length; a++) {
      for (let b = a + 1; b < vs.length; b++) {
        const A = vs[a];
        const B = vs[b];
        // the other lane for one direction is the own lane for the other
        const la = lanes(A);
        const lb = A.dir === B.dir ? lanes(B) : ((lanes(B) & 1) << 1) | ((lanes(B) & 2) >> 1);
        if (!(la & lb)) continue;
        const overlap = (A.len + B.len) / 2 - Math.abs(A.s - B.s);
        assert.ok(overlap < 0.0005, `${A.kind} and ${B.kind} overlap by ${(overlap * 1000).toFixed(1)} m at step ${k}`);
      }
    }
  }
  assert.ok(passes > 0, 'someone overtook: ' + passes);
  assert.ok(stops > 0, 'a bus stopped: ' + stops);
  // it was near a fifth of all driving when they waited for a long straight at full passing speed
  assert.ok(stuck < driving * 0.05, `stuck behind a slower one on an empty road: ${((100 * stuck) / driving).toFixed(1)}% of driving`);
});

test('at night beams are dipped for oncoming traffic and go back up on an empty road', () => {
  const h = quietRoad(22);
  const a = h.put('jeep', 1, STRAIGHT);
  const b = h.put('jeep', -1, STRAIGHT + 20); // 0.16 km away, coming towards it
  h.run(1);
  assert.ok(a.beam < 0.05 && b.beam < 0.05, 'both dipped');
  h.run(30); // past each other and well apart
  assert.ok((b.s - a.s) * a.dir < -0.3, 'they have passed');
  assert.ok(a.beam > 0.95 && b.beam > 0.95, 'main beam again');
});

test('before a blind hairpin at night the main beam flashes twice', () => {
  const h = quietRoad(22);
  const { road } = h;
  // a sharp bend on the straight, as tight as a hairpin
  for (let i = STRAIGHT + 30; i < STRAIGHT + 37; i++) road.limit[i] = 0.0035;
  assert.ok(road.limit[STRAIGHT + 12] > 0.0075, 'with faster road before it');
  const c = h.put('jeep', 1, STRAIGHT + 12, { v: road.limit[STRAIGHT + 12] });
  let flashes = 0;
  let was = false;
  h.run(12, () => {
    h.life._write(h.state);
    const v = sprites(h.life).find((x) => x.type === 6);
    const on = c.flash > 0.85 || (c.flash > 0.25 && c.flash < 0.6);
    if (on && !was) flashes++;
    was = on;
    if (on && v) assert.equal(v.f[17], 1, 'the picture gets the main beam while it flashes');
  });
  assert.equal(flashes, 2);
});

test('brake lights come on when slowing, by day as well, and tail lights glow at night', () => {
  const day = quietRoad(12);
  const c = day.put('jeep', 1, STRAIGHT, { v: 0.0115 });
  day.put('bus', 1, STRAIGHT + 3, { cruise: 0.003, v: 0.003, stopIn: Infinity });
  day.run(1.5);
  assert.ok(c.brake > 0.9, 'braking behind the slow bus: ' + c.brake);
  // by day the brake light is a small red point, well below the night's
  day.life.count = 0;
  day.life._pushVehicle(c, 0);
  const dayV = sprites(day.life).find((x) => x.type === 6);
  if (dayV) assert.ok(dayV.f[16] <= 0.31, 'dim by day: ' + dayV.f[16]);
  // cruising along an empty road the brake lights stay off: no flicker from small changes of speed
  const calm = quietRoad(12);
  const e = calm.put('jeep', 1, STRAIGHT);
  let most = 0;
  calm.run(4);
  calm.run(30, () => (most = Math.max(most, e.brake)));
  assert.ok(most < 0.05, 'no brake lights while cruising: ' + most);
  const night = quietRoad(22);
  const d = night.put('jeep', 1, STRAIGHT);
  night.run(0.5);
  assert.ok(d.brake < 0.1, 'cruising');
  // seen from behind: the level that goes to the picture
  const R = night.LE.Road;
  const lights = night.life._lightsLevel(night.state);
  near(R.taillight(-1) * Math.max(lights * 0.5, d.brake * (0.3 + 0.7 * lights)), 0.5, 0.05, 'tail lights at night');
  // and what goes to the picture: on with the headlights, brighter and wider when it brakes
  const look = (dir, i, brake) => {
    night.life.count = 0;
    night.life._pushVehicle(Object.assign(night.life._newVehicle('jeep', dir, i * night.road.step), { brake }), lights);
    return sprites(night.life).find((x) => x.type === 6);
  };
  // somewhere it drives straight away from the viewer: tail lights in full, no headlights
  let spot = null;
  for (const dir of [1, -1])
    for (let i = 5; i < night.road.n - 5 && !spot; i++) {
      const v = look(dir, i, 0);
      if (v && v.f[14] === 0 && v.f[16] > 0.49) spot = [dir, i];
    }
  assert.ok(spot, 'somewhere on the road a vehicle drives away from the viewer');
  const cruising = look(spot[0], spot[1], 0);
  const braking = look(spot[0], spot[1], 1);
  near(cruising.f[16], 0.5, 0.02, 'on with the headlights');
  assert.equal(cruising.f[19], 0, 'not braking');
  assert.ok(braking.f[16] > cruising.f[16] * 1.8, 'brighter when braking: ' + braking.f[16] + ' against ' + cruising.f[16]);
  near(braking.f[19], 1, 0.02, 'and the picture is told it brakes, for the wider glow');
});

test('at night each vehicle lights the road ahead: further on main beam, and a motorcycle much less than a bus', () => {
  const h = quietRoad(22);
  const beamOf = (kind, beam) => {
    h.life.count = 0;
    h.life._pushVehicle(Object.assign(h.life._newVehicle(kind, 1, STRAIGHT * h.road.step), { beam }), 1);
    const b = sprites(h.life).find((x) => x.type === 7);
    assert.ok(b, kind + ' throws light');
    return { strength: b.f[6], range: b.f[11], cone: b.f[15] };
  };
  const busHigh = beamOf('bus', 1);
  const busLow = beamOf('bus', 0);
  const bikeLow = beamOf('motorcycle', 0);
  assert.ok(busHigh.range > busLow.range * 2, 'main beam reaches more than twice as far');
  assert.ok(busHigh.cone > busLow.cone, 'and is narrower');
  assert.ok(bikeLow.strength < busLow.strength * 0.5 && bikeLow.range < busLow.range, 'a motorcycle throws far less');
  // by day, none
  h.life.count = 0;
  h.life._pushVehicle(h.life._newVehicle('bus', 1, STRAIGHT * h.road.step), 0);
  assert.ok(!sprites(h.life).some((x) => x.type === 7), 'nothing by day');
});

test('indicators blink at about one and a half times a second, without raising the frame rate', () => {
  const h = quietRoad(12);
  const c = h.put('jeep', 1, STRAIGHT, { blink: 2, blinkFor: 99 });
  const lit = [];
  for (let k = 0; k < 40; k++) {
    h.life.update(0.05, h.state, h.view);
    const v = sprites(h.life).find((x) => x.type === 6);
    lit.push(v && v.f[18] === 2 ? 1 : 0);
  }
  const changes = lit.slice(1).filter((x, k) => x !== lit[k]).length;
  assert.ok(changes >= 4 && changes <= 8, 'on and off over two seconds: ' + lit.join(''));
  assert.equal(h.life.movers, 0, 'it does not ask for more frames');
  assert.ok(c.blink === 2);
});

// ---- lorries, an army column, an ambulance ---------------------------------------------------------------------------
/** An army column put on the road with its first vehicle at point i, as `summon('convoy')` places it. */
function putConvoy(h, dir, i) {
  const q = h.life._newConvoy(dir);
  const members = [];
  for (let back = 0; q.left > 0; ) {
    const c = h.life._convoyMember(q, i * h.road.step - dir * back);
    back += c.len / 2 + 0.014 + (0.0075 * 1.3) / 2;
    h.life.vehicles.push(c);
    members.push(c);
  }
  return members;
}
/** Fails if anything that is not of the column drives in its lane between its first and its last vehicle. */
function columnWhole(vehicles, members, when) {
  const dir = members[0].dir;
  const along = members.map((m) => m.s * dir);
  const front = Math.max(...along);
  const rear = Math.min(...along);
  for (const o of vehicles) {
    if (members.includes(o) || o.dir !== dir || o.side > 0.3) continue;
    assert.ok(o.s * dir > front || o.s * dir < rear, `a ${o.kind} is inside the column ${when}`);
  }
}

test('a lorry is one of the ordinary traffic: slower than a bus on the bends, and about one vehicle in seven', () => {
  const h = quietRoad(12);
  seedRandom(h.ctx, 11);
  const n = { bus: 0, jeep: 0, motorcycle: 0, lorry: 0 };
  for (let k = 0; k < 4000; k++) n[h.life._pickVehicleKind()]++;
  assert.equal(n.bus + n.jeep + n.motorcycle + n.lorry, 4000, 'only these four come by themselves');
  near(n.lorry / 4000, 0.15, 0.03, 'lorries');
  near(n.bus / 4000, 0.2, 0.03, 'buses');
  const lorry = h.life._newVehicle('lorry', 1, STRAIGHT * h.road.step);
  const bus = h.life._newVehicle('bus', 1, STRAIGHT * h.road.step);
  assert.equal(lorry.code, 3);
  assert.ok(lorry.len < bus.len && lorry.hgt >= bus.hgt, 'shorter than a bus and as tall');
  assert.equal(lorry.stopIn, Infinity, 'it does not stop at bus stops');
  // the picture knows the kinds apart: a cab and a covered load, olive canvas, a red stripe
  const sh = readSrc('engine/shaders/sprites.js');
  assert.ok(sh.includes('bool lorry = kind == 3 || kind == 4;') && sh.includes('} else if (kind == 6) {'), 'drawn their own way');
});

test('an army column comes on to the road one after the other, the jeep first, and drives close together with its hazard lights on', () => {
  const { life, road, state, view, ctx } = testLife(12);
  seedRandom(ctx, 14);
  life._trafficSeeded = true; // an empty road, so it can be told apart
  life._nextVehicle = 1e9;
  life._nextAmbulance = 1e9;
  life._nextConvoy = 0;
  life.birds = false;
  for (let k = 0; k < 480; k++) life.update(0.25, state, view);
  const col = life.vehicles.filter((c) => c.group).sort((a, b) => (b.s - a.s) * a.dir);
  assert.ok(col.length >= 4 && col.length <= 7, 'a jeep and three to six lorries: ' + col.length);
  assert.equal(life.vehicles.length, col.length, 'nothing else came on to the road in between');
  assert.equal(col[0].kind, 'armyJeep', 'the jeep leads');
  assert.ok(col.slice(1).every((c) => c.kind === 'armyLorry' && c.code === 4), 'lorries behind it');
  assert.ok(col.every((c) => c.group === col[0].group && c.dir === col[0].dir && c.blink === 3), 'one column, hazard lights on');
  for (let j = 1; j < col.length; j++) {
    const gap = (col[j - 1].s - col[j].s) * col[0].dir - (col[j - 1].len + col[j].len) / 2;
    // (14 m once it has closed up. Out of a slow bend each picks up speed later than the one in front, so the column
    // stretches for a while, as a real one does)
    assert.ok(gap > 0.004 && gap < 0.06, `${(gap * 1000).toFixed(0)} m between vehicles ${j} and ${j + 1}`);
  }
  assert.ok(road.length > 1);
  // by night none sets out
  const night = testLife(2);
  night.life._nextConvoy = 0;
  night.life._nextAmbulance = 1e9;
  for (let k = 0; k < 200; k++) night.life.update(0.25, night.state, night.view);
  assert.ok(!night.life.vehicles.some((c) => c.group), 'by day only');
});

test('an army column keeps together and is never split: others pass the whole of it or wait behind it', () => {
  for (const [seed, coming] of [[1, 0], [2, 0], [3, 60], [4, 110], [5, 150]]) {
    const h = quietRoad(12);
    seedRandom(h.ctx, seed);
    const col = putConvoy(h, 1, STRAIGHT);
    const bike = h.put('motorcycle', 1, STRAIGHT - col.length * 3 - 6, { ...AS_BUILT.motorcycle, cool: 0, v: 0.0068 });
    const jeep = h.put('jeep', 1, STRAIGHT - col.length * 3 - 14, { ...AS_BUILT.jeep, cool: 2, v: 0.0068 });
    if (coming) h.put('jeep', -1, STRAIGHT + coming, AS_BUILT.jeep); // something comes the other way while they are out
    let outs = 0;
    let wasOut = false;
    h.run(240, (t) => {
      columnWhole(h.life.vehicles, col, `at ${t} s (seed ${seed})`);
      for (const m of col) {
        assert.ok(!m.pass && m.side < 0.05, 'none of the column overtakes');
        assert.equal(m.blink, 3, 'hazard lights stay on');
      }
      for (const a of [bike, jeep])
        for (const m of col) if (a.side < 0.7) assert.ok(Math.abs(a.s - m.s) >= (a.len + m.len) / 2 - 5e-4, `${a.kind} into the column at ${t} s (seed ${seed})`);
      const out = bike.side > 0.5;
      if (out && !wasOut) outs++;
      wasOut = out;
      if (t > 30) {
        const order = col.slice().sort((a, b) => b.s - a.s);
        for (let j = 1; j < order.length; j++) assert.ok(order[j - 1].s - order[j].s < 0.075, `the column has come apart at ${t} s (seed ${seed})`);
      }
    });
    assert.equal(col[0].kind, 'armyJeep');
    assert.ok(col.every((m, j) => j === 0 || m.s < col[j - 1].s), 'still in the order it set out in');
    if (!coming) {
      assert.ok(bike.s > col[0].s && bike.side < 0.05, `on an empty road the motorcycle got past the whole column (seed ${seed})`);
      assert.equal(outs, 1, 'in one go');
    }
  }
});

test('everyone makes way for an ambulance: indicates, pulls in and slows, and pulls back out when it is past', () => {
  for (const kind of ['jeep', 'bus', 'lorry', 'motorcycle']) {
    const h = quietRoad(12);
    seedRandom(h.ctx, 31); // each kind as built: a motorcycle at the top of its range is as fast as the ambulance
    const c = h.put(kind, 1, STRAIGHT + 12, { ...AS_BUILT[kind], stopIn: Infinity, cool: 0 });
    const slow = h.put('bus', 1, STRAIGHT + 22, { cruise: 0.004, v: 0.004, stopIn: Infinity }); // one it would overtake
    const amb = h.put('ambulance', 1, STRAIGHT - 14);
    assert.ok(amb.beacon && amb.code === 6 && amb.cruise > 0.0155 && amb.cruise < 0.0175, 'about 60 km/h');
    const seen = { left: false, in: false, slowed: false, right: false };
    let passedAt = -1;
    let wasPassing = false;
    h.run(90, (t) => {
      for (const [a, b] of [[amb, c], [amb, slow], [c, slow]]) {
        if (a.side < 0.7 && b.side < 0.7) assert.ok(Math.abs(a.s - b.s) >= (a.len + b.len) / 2 - 5e-4, `${a.kind} into the ${b.kind} at ${t} s`);
      }
      assert.ok(amb.v < 0.02, 'a sane speed');
      const behind = amb.s < c.s && c.s - amb.s < 0.19;
      if (behind) {
        // (one already out overtaking when it came into range finishes that)
        assert.ok(!c.pass || wasPassing, `the ${kind} does not set out to overtake with it behind`);
        if (c.blink === 1) seen.left = true;
        if (c.side < -0.3) seen.in = true;
        if (c.side < -0.3 && c.v < c.cruise * 0.6) seen.slowed = true;
      }
      wasPassing = !!c.pass;
      if (amb.s > c.s && passedAt < 0) passedAt = t;
      if (passedAt >= 0 && c.blink === 2) seen.right = true;
    });
    assert.ok(seen.left && seen.in && seen.slowed, `the ${kind} indicated left ${seen.left}, pulled in ${seen.in}, slowed ${seen.slowed}`);
    assert.ok(passedAt >= 0 && amb.s > slow.s, `the ambulance got past the ${kind} (${passedAt} s) and the bus`);
    assert.ok(seen.right && !c.yielding && c.side > -0.05, `the ${kind} indicated right and pulled back out`);
    assert.ok(amb.s > c.s && !c.pass, `and the ${kind} stays behind it: nobody overtakes an ambulance`);
  }
  // one coming towards it slows down as they meet, and picks up again after
  const h = quietRoad(12);
  const amb = h.put('ambulance', 1, STRAIGHT);
  const on = h.put('jeep', -1, STRAIGHT + 60, AS_BUILT.jeep);
  on.v = on.cruise;
  let least = 1;
  h.run(40, () => {
    if ((on.s - amb.s) * amb.dir > 0) least = Math.min(least, on.v / on.cruise);
    assert.ok(on.side < 0.05 && on.side > -0.05 && !on.yielding, 'it keeps to its own lane');
  });
  assert.ok(least < 0.75, 'slowed while it came: ' + least.toFixed(2));
  assert.ok((on.s - amb.s) * amb.dir < 0 && on.v > on.cruise * 0.9, 'and is back at its pace once they have passed');
});

test('an ambulance\'s roof light alternates red and blue about twice a second, by day too, without raising the frame rate', () => {
  for (const hour of [12, 23]) {
    const h = quietRoad(hour);
    h.put('ambulance', 1, STRAIGHT);
    const lit = [];
    let patch = 0;
    for (let k = 0; k < 40; k++) {
      h.life.update(0.05, h.state, h.view);
      const v = sprites(h.life).find((x) => x.type === 6);
      assert.ok(v, 'in view');
      assert.equal(v.f[15], 6, 'drawn as an ambulance');
      lit.push(v.f[18] & 12);
      assert.equal(v.f[18] & 3, 0, 'no indicators with it');
      patch = Math.min(v.f[2], v.f[3]);
    }
    assert.ok(lit.every((x) => x === 4 || x === 8), 'always one of the two: ' + lit.join(' '));
    const changes = lit.slice(1).filter((x, k) => x !== lit[k]).length;
    assert.ok(changes >= 6 && changes <= 9, 'four changes a second: ' + changes);
    assert.ok(patch >= 16, 'room on the picture for its glow');
    assert.equal(h.life.movers, 0, 'it does not ask for more frames');
  }
  // no other vehicle carries it
  const h = quietRoad(12);
  for (const kind of ['bus', 'jeep', 'motorcycle', 'lorry', 'armyLorry', 'armyJeep']) {
    h.life.count = 0;
    h.life._pushVehicle(h.life._newVehicle(kind, 1, STRAIGHT * h.road.step), 0);
    const v = sprites(h.life).find((x) => x.type === 6);
    assert.ok(v && v.f[18] < 4, kind);
  }
  const sh = readSrc('engine/shaders/sprites.js');
  assert.ok(sh.includes('if (blink >= 4) {') && sh.includes('if ((blink & 3) != 0) {'), 'the picture reads the two apart');
});

test('flashing lamps light what is round them at night: amber from hazard lights and indicators, red and blue from an ambulance', () => {
  const glows = (life) => sprites(life).filter((x) => x.type === 7 && x.f[15] < -1.5);
  const col = (g) => [g.f[17], g.f[18], g.f[19]].map((x) => +x.toFixed(2)).join(',');
  // an ambulance by night: one light all round its roof, the colour of the lamp that is lit
  const n = quietRoad(23);
  const amb = n.put('ambulance', 1, STRAIGHT);
  const seen = new Set();
  for (let k = 0; k < 40; k++) {
    n.life.update(0.05, n.state, n.view);
    const v = sprites(n.life).find((x) => x.type === 6);
    const g = glows(n.life);
    assert.equal(g.length, 1, 'one glow');
    assert.equal(col(g[0]), (v.f[18] & 8) ? '0.15,0.35,1' : '1,0.08,0.05', 'blue with the blue lamp, red with the red');
    seen.add(col(g[0]));
    assert.ok(Math.abs(g[0].f[11] - 0.045) < 1e-6 && g[0].f[2] > 6, 'it reaches 45 m, and there is room on the picture for that');
    const beam = sprites(n.life).find((x) => x.type === 7 && x.f[15] > 0);
    assert.ok(beam && g[0].f[6] < beam.f[6] * 0.4, 'much weaker than its headlights');
    const all = sprites(n.life);
    assert.ok(all.findIndex((x) => x.type === 7 && x.f[15] < -1.5) < all.findIndex((x) => x.type === 6), 'drawn under the vehicle');
  }
  assert.equal(seen.size, 2, 'both colours in two seconds');
  assert.equal(n.life.movers, 0, 'and no more frames for it');
  // hazard lights: amber, only while the lamps are lit, from the middle of the vehicle; an indicator from its side
  const c = quietRoad(23);
  const lorry = c.put('armyLorry', 1, STRAIGHT, { blink: 3, blinkFor: 99 });
  let on = 0;
  let off = 0;
  for (let k = 0; k < 40; k++) {
    c.life.update(0.05, c.state, c.view);
    const v = sprites(c.life).find((x) => x.type === 6);
    const g = glows(c.life);
    if (v.f[18] & 3) {
      on++;
      assert.equal(g.length, 1);
      assert.equal(col(g[0]), '1,0.55,0.1', 'amber');
      assert.ok(Math.abs(g[0].f[11] - 0.025) < 1e-6, 'it reaches 25 m');
    } else {
      off++;
      assert.equal(g.length, 0, 'dark between flashes');
    }
  }
  assert.ok(on > 8 && off > 8, 'it flashes: ' + on + ' lit, ' + off + ' dark');
  lorry.blink = 2;
  let one = null;
  let both = null;
  for (let k = 0; k < 40 && !one; k++) {
    c.life.update(0.05, c.state, c.view);
    one = glows(c.life)[0];
  }
  lorry.blink = 3;
  for (let k = 0; k < 40 && !both; k++) {
    c.life.update(0.05, c.state, c.view);
    both = glows(c.life)[0];
  }
  assert.ok(one && both && Math.abs(one.f[6] / both.f[6] - 0.5) < 0.05, 'an indicator throws half the light of both sides together');
  // by day nothing: against daylight a small bulb lights nothing
  const d = quietRoad(12);
  d.put('ambulance', 1, STRAIGHT);
  d.put('armyLorry', 1, STRAIGHT + 20, { blink: 3, blinkFor: 99 });
  for (let k = 0; k < 20; k++) {
    d.life.update(0.05, d.state, d.view);
    assert.equal(glows(d.life).length, 0);
  }
  // a dipped headlight has a cut-off: next to nothing above the lamp's own height; main beam reaches the trees
  assert.ok(readSrc('engine/shaders/sprites.js').includes('inBeam *= mix(1.0, mix(0.05, 1.0, vE.y), smoothstep(-0.01, 0.05, l.y - fwd.y));'), 'the cut-off');
  const cut = (up, main) => { const t = Math.min(Math.max((up + 0.01) / 0.06, 0), 1); const k = t * t * (3 - 2 * t); return 1 + ((0.05 + 0.95 * main) - 1) * k; };
  assert.ok(cut(-0.05, 0) === 1 && cut(0.1, 0) < 0.06 && cut(0.1, 1) === 1, 'the road in full, the treetops a twentieth, all of it on main beam');
  for (const hour of [23]) {
    const b = quietRoad(hour);
    const car = b.put('jeep', 1, STRAIGHT);
    b.life.update(0.05, b.state, b.view);
    const beam = sprites(b.life).find((x) => x.type === 7 && x.f[15] > 0);
    assert.ok(beam && Math.abs(beam.f[17] - car.beam) < 1e-6, 'the picture is told whether it is dipped');
  }
  // the picture: all round and in the lamp's colour, on whatever is there, as the headlight's patch
  const sh = readSrc('engine/shaders/sprites.js');
  assert.ok(sh.includes('if (cone < -1.5) inBeam = 1.0;') && sh.includes('vec3 tint = cone < -1.5 ? vE.yzw : vec3(1.0, 0.88, 0.72);') && sh.includes('vec3 E = tint * strength * uHeadE * inBeam * fall * ndl;'));
});

test('columns and ambulances on a busy road: nothing ever drives through anything, no column is split, nobody is stuck for long', () => {
  for (const seed of [21, 22, 23]) {
    const { life, state, view, ctx } = testLife(12);
    seedRandom(ctx, seed);
    let driving = 0;
    let stuck = 0;
    let columns = 0;
    let ambulances = 0;
    const known = new Set();
    const lanes = (c) => (c.side < 0.7 ? 1 : 0) | (c.side > 0.3 ? 2 : 0);
    for (let k = 0; k < 4800; k++) {
      // far more often than they really come
      life._nextConvoy = Math.min(life._nextConvoy, 300);
      life._nextAmbulance = Math.min(life._nextAmbulance, 150);
      life.update(0.5, state, view);
      const vs = life.vehicles;
      const groups = new Map();
      for (const c of vs) {
        if (c.group) groups.set(c.group, (groups.get(c.group) || []).concat(c));
        if (!known.has(c)) {
          known.add(c);
          if (c.beacon) ambulances++;
          if (c.kind === 'armyJeep') columns++;
        }
        assert.ok(c.v >= 0 && c.v < 0.02, 'a sane speed: ' + c.v);
        if (c.side > 0.05 || c.stopFor > 0 || c.stopping || c.group || c.yielding) continue;
        driving += 0.5;
        let ahead = null;
        let gap = 1e9;
        let coming = 1e9;
        for (const o of vs) {
          const g = (o.s - c.s) * c.dir - (o.len + c.len) / 2;
          if (o === c || g <= 0) continue;
          if (o.dir !== c.dir) coming = Math.min(coming, g);
          else if (o.side < 0.7 && g < gap) [ahead, gap] = [o, g];
        }
        // (with an ambulance about nobody pulls out: that wait is not being stuck)
        const siren = vs.some((o) => o.beacon && Math.abs(o.s - c.s) < 0.3);
        if (ahead && gap < 0.06 && ahead.cruise < c.cruise * 0.9 && c.v < c.cruise * 0.9 && coming > 1 && !siren) stuck += 0.5;
      }
      for (const members of groups.values()) columnWhole(vs, members, `at step ${k} (seed ${seed})`);
      for (let a = 0; a < vs.length; a++) {
        for (let b = a + 1; b < vs.length; b++) {
          const A = vs[a];
          const B = vs[b];
          const la = lanes(A);
          const lb = A.dir === B.dir ? lanes(B) : ((lanes(B) & 1) << 1) | ((lanes(B) & 2) >> 1);
          if (!(la & lb)) continue;
          const overlap = (A.len + B.len) / 2 - Math.abs(A.s - B.s);
          assert.ok(overlap < 0.0005, `${A.kind} and ${B.kind} overlap by ${(overlap * 1000).toFixed(1)} m at step ${k} (seed ${seed})`);
        }
      }
    }
    assert.ok(columns >= 3 && ambulances >= 8, `columns ${columns}, ambulances ${ambulances}`);
    assert.ok(stuck < driving * 0.08, `stuck behind a slower one on an empty road: ${((100 * stuck) / driving).toFixed(1)}% of driving (seed ${seed})`);
  }
});

// ---- an airliner and its contrail -----------------------------------------------------------------------------------
/** Life with a sky to fly in: the view set, and the upper air dry (no high cloud) or moist. */
function skyLife(hour, cirrus, wind = [0, 0]) {
  const h = testLife(hour, { cirrus, cirrusE: wind[0], cirrusN: wind[1] });
  h.life._view = h.view;
  h.life.state = h.state;
  h.life._trafficSeeded = true;
  h.life._nextVehicle = h.life._nextConvoy = h.life._nextAmbulance = 1e9;
  h.life.birds = false;
  h.trail = () => sprites(h.life).filter((x) => x.type === 8 && x.f[15] === 0);
  h.craft = () => sprites(h.life).filter((x) => x.type === 8 && x.f[15] === 1);
  return h;
}

test('an airliner crosses high and far off, straight and level, at an airliner\'s speed, and is followed only while in sight', () => {
  const h = skyLife(12, 0.5);
  seedRandom(h.ctx, 5);
  let radials = 0;
  let climbing = 0;
  for (let k = 0; k < 40; k++) {
    const p = h.life._newPlane(h.state, false);
    assert.ok(p.alt >= 10 && p.alt <= 11.5, 'cruising height: ' + p.alt);
    near(Math.hypot(p.dir[0], p.dir[1]), 1, 1e-9, 'a heading');
    const at = (t) => [p.C[0] + p.dir[0] * (p.s0 + 0.23 * t), p.C[1] + p.dir[1] * (p.s0 + 0.23 * t)];
    let nearest = 1e9;
    for (let t = 0; t <= p.cross; t += 1) nearest = Math.min(nearest, Math.hypot(...at(t)));
    // where the top edge of the picture is: a flight that passes nearly overhead leaves over it, or comes in there
    const top = (1 - h.view.horizonY) * h.view.h * h.view.pxAng;
    const steep = ([x, z]) => (p.alt - h.view.camY - (x * x + z * z) / 12742) / Math.hypot(x, z);
    if (p.radial) {
      radials++;
      assert.ok(nearest < 22, 'towards the viewer or away: it comes as near as ' + nearest.toFixed(0) + ' km');
      // on the picture it goes up or down far more than it goes sideways
      const px = (t) => h.life._projectDir([at(t)[0], steep(at(t)) * Math.hypot(...at(t)), at(t)[1]]);
      const a = px(1);
      const b = px(p.cross - 1);
      assert.ok(Math.abs(b[1] - a[1]) > 150 && Math.abs(b[1] - a[1]) > Math.abs(b[0] - a[0]), `up or down the picture: ${(b[0] - a[0]).toFixed(0)} across, ${(b[1] - a[1]).toFixed(0)} up`);
      if (b[1] > a[1]) climbing++;
    } else assert.ok(nearest > 20 && nearest < 56, 'passes ' + nearest.toFixed(0) + ' km off: above the peaks on the picture');
    assert.ok(p.cross > 30 && p.cross < 1100, 'in sight for ' + p.cross.toFixed(0) + ' s');
    // it comes in from out of sight, and leaves out of sight: beyond the edge of the widest view, too far to see, or
    // over the top of the picture
    for (const t of [-10, p.cross + 10]) {
      const [x, z] = at(t);
      assert.ok(Math.hypot(x, z) > 115 || Math.abs(Math.atan2(x, z)) > h.view.hfov / 2 + 0.1 || steep([x, z]) > top, 'out of sight at ' + t);
    }
    // on the picture it is in the sky, above the horizon line, while it is anywhere near
    h.life.aircraft = [Object.assign(p, { t: p.cross / 2 })];
    h.life._write(h.state);
    for (const c of h.craft()) assert.ok(c.f[1] > h.view.horizonY * h.view.h, 'above the horizon');
  }
  assert.ok(radials >= 8 && radials <= 26, 'about two in five fly up or down the picture: ' + radials + ' of 40');
  assert.ok(climbing >= 2 && radials - climbing >= 2, 'some up it, some down: ' + climbing + ' up of ' + radials);
  // they come by themselves, one every 5 to 15 minutes by day and a third as many in the small hours; never more
  // than two in sight, and a few trails of ones gone by at most
  const day = skyLife(12, 0.5);
  seedRandom(day.ctx, 6);
  // airliners only: the helicopter (every 15-40 min by day since 2.8.1) or a kite in sight at the last step asked
  // for frames now and then (2026-11-26, 1 run in 2), as in the perch test
  day.life._nextHeli = day.life._nextKite = 1e9;
  let seen = 0;
  const known = new Set();
  for (let k = 0; k < 14400; k++) {
    day.life.update(0.5, day.state, day.view);
    assert.ok(day.life.aircraft.filter((p) => p.t < p.cross).length <= 2 && day.life.aircraft.length <= 4);
    for (const p of day.life.aircraft) if (!known.has(p)) { known.add(p); seen++; }
  }
  assert.ok(seen >= 7 && seen <= 24, 'in two hours of day: ' + seen);
  const waits = (hour) => {
    const n = skyLife(hour, 0.5);
    seedRandom(n.ctx, 6);
    let sum = 0;
    for (let k = 0; k < 40; k++) {
      n.life._nextPlane = 0;
      n.life._stepPlanes(0.001, n.state);
      sum += n.life._nextPlane;
    }
    return sum / 40;
  };
  const dayWait = waits(12);
  const nightWait = waits(2);
  assert.ok(dayWait > 450 && dayWait < 750, 'by day one comes about every ten minutes: ' + dayWait.toFixed(0) + ' s');
  assert.ok(nightWait > 1350 && nightWait < 2250, 'at 2 in the morning a third as often: ' + nightWait.toFixed(0) + ' s');
  assert.equal(day.life.movers, 0, 'and it does not ask for more frames');
});

test('held still while you work, aircraft keep real time: a picture a minute later has the flight further on, and new ones come', () => {
  // (2026-11-22, the user: "no single plane flown in wallpaper": with an app in front the scene's own time stood still,
  // and the planes counted only that)
  const h = skyLife(12, 0.2);
  seedRandom(h.ctx, 11);
  const p = h.life._newPlane(h.state, false);
  p.t = p.cross * 0.3;
  h.life.aircraft = [p];
  h.life._nextPlane = 1e9;
  h.life._write(h.state);
  const a = h.craft()[0];
  const birdsBefore = h.life.t;
  h.life.catchUpAir(60, h.state, h.view);
  const b = h.craft()[0];
  near(p.t, p.cross * 0.3 + 60, 1e-9, 'a minute further along');
  assert.ok(a && b && Math.hypot(b.f[0] - a.f[0], b.f[1] - a.f[1]) > 5, 'and that far across the picture');
  assert.equal(h.life.t, birdsBefore, 'the rest of the scene keeps its own time');
  // one that was due part of the way through the minute is as far along as if it had set off then
  h.life.aircraft = [];
  h.life._nextPlane = 20;
  h.life.catchUpAir(60, h.state, h.view);
  assert.equal(h.life.aircraft.length, 1, 'a new one starts');
  near(h.life.aircraft[0].t, 40, 1e-9, 'forty seconds on');
  assert.ok(h.life._nextPlane >= 300 - 40 && h.life._nextPlane <= 900 - 40, 'and the next is counted from when it set off');
  // the long trails of two flights gone by do not keep a new one back
  const gone = () => {
    const q = h.life._newPlane(h.state, false);
    q.life = 600;
    q.t = q.cross + 30;
    return q;
  };
  h.life.aircraft = [gone(), gone()];
  h.life._nextPlane = 20;
  h.life.catchUpAir(60, h.state, h.view);
  assert.equal(h.life.aircraft.length, 3, 'two long trails and a new flight');
  assert.equal(h.life.aircraft.filter((q) => q.t < q.cross).length, 1, 'one of them in sight');
  // an hour held, one picture a minute, has flights in sight; a long gap is caught up in one go
  for (const seed of [1, 2, 3]) {
    const m = skyLife(12, 0.2);
    seedRandom(m.ctx, seed);
    let pictures = 0;
    let shown = 0;
    for (let k = 0; k < 60; k++) {
      m.life.catchUpAir(60, m.state, m.view);
      pictures++;
      if (m.craft().length) shown++;
    }
    assert.ok(shown >= 15, `seed ${seed}: an aircraft in ${shown} of ${pictures} pictures in an hour held`);
  }
  const g = skyLife(12, 0.2);
  g.life.catchUpAir(1800, g.state, g.view);
  assert.ok(g.life.aircraft.every((x) => x.t < x.cross + x.life) && g.life._nextPlane > 0, 'half an hour in one step');
  // switched off, none
  g.life.planes = false;
  g.life.catchUpAir(600, g.state, g.view);
  assert.equal(g.life.aircraft.length, 0);
  assert.equal(g.life.heli, null);
});

test('a contrail is a stub or long at random, long more often where there is high cloud, grows from the aircraft, widens with age and drifts with the wind up there', () => {
  // (2026-11-24, the user: "keep both short and long smoke but should appear randomly": under a clear sky every
  // trail was a stub)
  const lifeOf = (cirrus) => {
    const h = skyLife(12, cirrus);
    seedRandom(h.ctx, 9);
    let short = 0;
    let long = 0;
    for (let k = 0; k < 200; k++) {
      const p = h.life._newPlane(h.state, false);
      if (p.life >= 20 && p.life <= 60) short++;
      else if (p.life >= 240 && p.life <= 660) long++;
      else assert.fail('a trail neither short nor long: ' + p.life.toFixed(0) + ' s');
    }
    return long / 200;
  };
  const dry = lifeOf(0);
  const moist = lifeOf(0.7);
  assert.ok(dry > 0.35 && dry < 0.65, 'dry air: about half long, ' + (dry * 100).toFixed(0) + ' %');
  assert.ok(moist > 0.8 && moist < 0.97, 'moist air: most long, some short, ' + (moist * 100).toFixed(0) + ' %');

  const h = skyLife(12, 0.7);
  seedRandom(h.ctx, 3);
  let p;
  do p = h.life._newPlane(h.state, true);
  while (p.life < 240); // a long one
  h.life.aircraft = [p];
  p.t = Math.max(p.t, p.life + 5);
  h.life._write(h.state);
  const pieces = h.trail();
  assert.ok(pieces.length >= 2 && pieces.length <= 16, 'pieces on the picture: ' + pieces.length);
  assert.equal(h.craft().length, p.t < p.cross ? 1 : 0, 'and the aircraft at its head');
  let prevEnd = null;
  for (const q of pieces) {
    const [cx, cy, hx] = q.f;
    const ang = q.f[4];
    const half = q.f[14];
    assert.ok(half > 0 && hx >= half, 'the patch holds the piece');
    assert.ok(q.f[8] > q.f[9], 'older towards its far end');
    near(q.f[10], p.t, 1e-3, 'the time now');
    near(q.f[11], p.life, 1e-3, 'how long it lasts');
    assert.ok(q.f[10] - q.f[9] <= p.life + 1e-3, 'nothing older than it lasts');
    // wider in km with age (on the picture it also depends on how far off that part is)
    const start = [cx - Math.cos(ang) * half, cy - Math.sin(ang) * half];
    const end = [cx + Math.cos(ang) * half, cy + Math.sin(ang) * half];
    if (prevEnd) near(Math.hypot(start[0] - prevEnd[0], start[1] - prevEnd[1]), 0, 0.01, 'each piece starts where the last ended');
    prevEnd = end;
  }
  const young = h.life._trailAt(p, 0);
  const old = h.life._trailAt(p, p.life);
  const km = (age, q) => (0.01 + 0.0008 * age);
  assert.ok(km(p.life) > km(0) * 15, 'much wider at the end of its time');
  assert.ok(young.dist > 20 && old.dist > 10);
  // a fresh one grows: nothing behind an aircraft that has only just come into sight
  const fresh = skyLife(12, 0.7);
  const f = fresh.life._newPlane(fresh.state, false);
  fresh.life.aircraft = [f];
  fresh.life._write(fresh.state);
  assert.equal(fresh.trail().length, 0, 'no trail at the start');

  // the wind aloft carries the old end of it along, and leaves the aircraft where it is
  const still = skyLife(12, 0.7, [0, 0]);
  const windy = skyLife(12, 0.7, [180, 0]); // 180 km/h towards the east
  seedRandom(still.ctx, 4);
  seedRandom(windy.ctx, 4);
  const a = still.life._newPlane(still.state, true);
  const b = windy.life._newPlane(windy.state, true);
  a.t = b.t = Math.max(a.t, 200);
  near(Math.hypot(b.wind[0], b.wind[1]), 0.05, 1e-6, '180 km/h is 0.05 km/s');
  const headA = still.life._trailAt(a, 0);
  const headB = windy.life._trailAt(b, 0);
  near(headA.sx, headB.sx, 1e-6, 'the aircraft is where it flies');
  const oldA = still.life._trailAt(a, 200);
  const oldB = windy.life._trailAt(b, 200);
  assert.ok(Math.abs(oldA.sx - oldB.sx) > 5, 'its trail 200 s back has drifted: ' + (oldB.sx - oldA.sx).toFixed(1) + ' px');
});

test('aircraft can be switched off, show their lights only at night, and are drawn against the sky only', () => {
  const h = skyLife(12, 0.5);
  h.life.summon('plane');
  assert.equal(h.life.aircraft.length, 1, 'called up from the test panel');
  h.life.planes = false;
  h.life.update(0.1, h.state, h.view);
  assert.equal(h.life.aircraft.length, 0, 'gone at once when switched off');
  h.life.summon('plane');
  h.life._nextPlane = 0;
  h.life.update(0.1, h.state, h.view);
  assert.equal(h.life.aircraft.length, 0, 'and none comes while it is off');
  assert.equal(sprites(h.life).filter((x) => x.type === 8).length, 0);
  // by day no lights, by night the steady light and a flash now and then
  const levels = (hour) => {
    const n = skyLife(hour, 0.5);
    seedRandom(n.ctx, 2);
    n.life.summon('plane');
    const p = n.life.aircraft[0];
    const got = [];
    for (let k = 0; k < 40 && p.t < p.cross - 5; k++) {
      n.life.update(0.05, n.state, n.view);
      const c = n.craft()[0];
      if (c) got.push([c.f[8], c.f[9]]);
    }
    return got;
  };
  const day = levels(12);
  const night = levels(23);
  assert.ok(day.length > 10 && night.length > 10, 'in view');
  assert.ok(day.every((x) => x[1] === 0), 'no lights by day');
  assert.ok(night.every((x) => x[1] === 1), 'lights by night');
  const flashes = night.filter((x) => x[0] === 1).length;
  assert.ok(flashes >= 1 && flashes < night.length / 3, 'a short flash now and then: ' + flashes + ' of ' + night.length);
  const sh = readSrc('engine/shaders/sprites.js');
  const at = sh.indexOf('if (type == 8) {');
  assert.ok(at > 0 && sh.slice(at, at + 400).includes('if (t > 0.0) discard;') && sh.slice(at, at + 400).includes('volT()'), 'behind the mountains and the cloud');
});

// ---- a rainbow ------------------------------------------------------------------------------------------------------
test('a rainbow comes only with rain in the air and the sun shining on it from low enough, and stands opposite the sun', () => {
  const { LE } = load(['engine/environment.js']);
  const bow = LE.Environment.bowAmount;
  // a shower clearing in the late afternoon: rain still in the air, the cloud mostly gone, the sun 20 degrees up
  assert.ok(bow(0.5, 0.2, 20) > 0.7, 'a clearing shower: ' + bow(0.5, 0.2, 20));
  assert.equal(bow(0, 0.2, 20), 0, 'none without rain');
  assert.equal(bow(0.8, 0.9, 20), 0, 'none under a closed sky: the sun does not reach the rain');
  assert.equal(bow(0.8, 0.2, 45), 0, 'none with the sun above 42 degrees: the whole bow is below the horizon');
  assert.equal(bow(0.8, 0.2, -2), 0, 'none after sunset');
  assert.ok(bow(0.8, 0.2, 39) < bow(0.8, 0.2, 30), 'fading as the sun climbs towards 42 degrees');
  assert.ok(bow(0.1, 0.2, 20) < bow(0.5, 0.2, 20), 'fainter in thin rain');
  for (const [r, o, a] of [[2, -1, 20], [1, 0, 10], [0.3, 0.5, 5]]) assert.ok(bow(r, o, a) >= 0 && bow(r, o, a) <= 1, 'between 0 and 1');
  // the rain lingers in the air for the bow: quick to come, minutes to go, and the scene's state carries the amount
  const env = readSrc('engine/environment.js');
  assert.ok(env.includes('const bowTau = (w.rain > this.bowRain ? 30 : 300) / this.pace;'), 'half a minute up, five minutes down');
  assert.ok(env.includes('s.bow = LE.Environment.bowAmount(this.bowRain, w.overcast, sunAlt);'));
  // drawn from the sun's place alone: 42 degrees from the point opposite it, red outside; the second bow at 51, reversed
  const sh = readSrc('engine/shaders/composite.js');
  assert.ok(sh.includes('float ang = degrees(acos(clamp(dot(rd, -uSunDir), -1.0, 1.0)));'), 'measured from opposite the sun');
  assert.ok(sh.includes('bowColours((ang - 40.3) / 2.2)') && sh.includes('bowColours(1.0 - (ang - 50.2) / 3.4) * 0.28'), 'two bows, the second reversed and fainter');
  assert.ok(sh.includes('float inRain = t < 0.0 ? 1.0 : smoothstep(2.5, 12.0, t);'), 'not in front of near ground');
  assert.ok(sh.indexOf('if (uBow > 0.002) col += rainbow(rd, t)') > sh.indexOf('if (uMeter == 1) {'), 'added after metering: it does not change the exposure');
  // the colour ramp, worked out here as the shader does: violet inside, red outside, nothing beyond either edge
  const colours = (x) => {
    const st = (a, b, v) => { const t = Math.min(Math.max((v - a) / (b - a), 0), 1); return t * t * (3 - 2 * t); };
    const e = st(-0.2, 0.08, x) * (1 - st(0.92, 1.2, x));
    return [Math.exp(-(((x - 0.86) / 0.3) ** 2)) * e, Math.exp(-(((x - 0.5) / 0.24) ** 2)) * e, Math.exp(-(((x - 0.14) / 0.26) ** 2)) * e];
  };
  const [vr, , vb] = colours(0.1);
  const [rr, , rb] = colours(0.9);
  assert.ok(vb > vr * 3 && rr > rb * 3, 'violet at 40 degrees, red at 42');
  assert.ok(colours(0.5)[1] > 0.9, 'green between');
  assert.ok(Math.max(...colours(-0.3), ...colours(1.3)) < 1e-6, 'nothing outside the band');
  // the switch, and the test panel's two-minute bow
  assert.ok(readSrc('engine/renderer.js').includes("p.set('uBow', this.cfg.rainbow === false ? 0 : Math.max(state.bow || 0, this.bowForce || 0));"));
});

// ---- the bird of prey that sits on the tree --------------------------------------------------------------------------
test('the tree has places to perch on the top of its crown and round it facing the eye, grown last, found on the CPU where the shader puts them', () => {
  const { LE } = load(['engine/gl.js', 'engine/foreground.js']);
  const away = [-0.8, 0, 0.6];
  const T = LE.growTree(7936, away);
  const snags = T.branches.filter((b) => b.snag);
  assert.ok(T.perches.length >= 3 && T.perches.length <= 5, T.perches.length + ' places');
  assert.equal(snags.length, T.perches.length, 'a shoot to each');
  assert.deepEqual(T.branches.slice(-snags.length), snags, 'grown after everything else');
  assert.equal(T.perch, T.perches[0], 'the top one first');
  // each a different place, apart from the others, on the eye's side of the crown or its top
  const toEye = [-away[0], 0, -away[2]];
  T.perches.forEach((s, i) => {
    assert.deepEqual(Array.from(s.p), Array.from(snags[i].nodes[snags[i].nodes.length - 1].p), 'place ' + i + ' is the tip of its shoot');
    assert.ok(Math.abs(Math.hypot(...s.out) - 1) < 1e-9, 'a way out of the crown');
    // (the very top is seen whichever way it leans)
    if (i > 0) assert.ok(s.out[0] * toEye[0] + s.out[2] * toEye[2] >= -0.1 * Math.hypot(toEye[0], toEye[2]), 'not behind the leaves seen from the eye');
    assert.ok(s.p[1] > T.crownC[1], 'in the upper crown');
    for (let j = 0; j < i; j++) assert.ok(Math.hypot(...s.p.map((x, k) => x - T.perches[j].p[k])) >= 1.2, 'places ' + j + ' and ' + i + ' are apart');
  });
  const nodes = snags[0].nodes;
  const tip = nodes[nodes.length - 1];
  assert.deepEqual(Array.from(T.perch.p), Array.from(tip.p), 'the perch is its tip');
  // on top of the leaves, and hardly above them: a long bare stick standing out of the crown looked stuck on
  let topY = -1e9;
  for (let i = 0; i < T.leafCount; i++) topY = Math.max(topY, T.leaves[i * 21 + 1] + Math.max(T.leaves[i * 21 + 4], 0));
  assert.ok(tip.p[1] > topY && tip.p[1] < topY + 0.1, `${((tip.p[1] - topY) * 100).toFixed(0)} cm above the topmost leaf`);
  assert.ok(tip.p[1] <= T.boundHi[1], 'inside what is drawn of the tree');
  assert.ok(nodes.every((n) => n.w[2] === 0), 'no twig flex: it moves with its limb only');
  for (let i = 1; i < nodes.length; i++) {
    assert.ok(nodes[i].w[0] > nodes[i - 1].w[0], 'bends more towards its tip');
    assert.ok(nodes[i].r <= nodes[i - 1].r, 'and tapers');
  }
  // it starts on wood that is there: some other branch has a node at its foot, moving the same way
  const foot = nodes[0];
  const joined = T.branches.some((b) => !b.snag && b.nodes.some((n) => Math.hypot(n.p[0] - foot.p[0], n.p[1] - foot.p[1], n.p[2] - foot.p[2]) < 1e-9 && Math.abs(n.w[0] - foot.w[0]) < 1e-6));
  assert.ok(joined, 'joined to the limb it rises from');
  // the rest of the tree is as it was: the snag takes nothing from the random sequence (same leaves for the same seed,
  // and no leaf on the snag)
  const again = LE.growTree(7936, [-0.8, 0, 0.6]);
  assert.equal(again.leafCount, T.leafCount);
  assert.deepEqual(again.perches.map((s) => Array.from(s.p)), T.perches.map((s) => Array.from(s.p)));

  // moved by the wind as the vertex shader moves it
  const move = LE.Foreground.windMoved;
  const P = [0.4, 5, -0.2];
  const still = move(P, [0.8, 2.3, 0, 1], [1, 0, 0], [0, 0], new Float32Array(8), 5);
  assert.deepEqual(Array.from(still), P, 'still air leaves it where it is');
  // by hand: lean 0.3 m downwind and 0.1 across at the top (h = 1), wind along +x so across is +z
  const limbs = new Float32Array([0.02, 0.01, 0.05, -0.03, 0, 0, 0, 0]);
  const A = [0.8, 0.5 / 0.6366198, 0, 0]; // half way between the first two swings
  const got = move(P, A, [1, 0, 0], [0.3, 0.1], limbs, 5);
  const lx = 0.035;
  const ly = -0.01 * (((A[1] * 5.1) % 1) > 0.5 ? 1 : -1);
  near(got[0], P[0] + 0.3 + lx * 0.8, 1e-9, 'downwind');
  near(got[1], P[1] + 0.6 * ly * 0.8, 1e-9, 'up and down with the swing across');
  near(got[2], P[2] + 0.1 + ly * 0.8, 1e-9, 'across');
  near(move([0, 2.5, 0], [0, 0, 0, 0], [1, 0, 0], [0.4, 0], limbs, 5)[0], 0.1, 1e-9, 'half way up it leans a quarter as far');
  // the same sums as the shader's, line for line
  const sh = readSrc('engine/shaders/tree.js');
  for (const line of ['float h = clamp(P.y / uTreeH, 0.0, 1.2);', 'vec3 d = (W * uLean.x + side * uLean.y) * h * h;', 'float m = A.y * 0.6366198;', 'l.y *= fract(A.y * 5.1) > 0.5 ? 1.0 : -1.0;', 'd += (W * l.x + side * l.y + vec3(0.0, 0.6 * l.y, 0.0)) * A.x;']) {
    assert.ok(sh.includes(line), 'the shader still does: ' + line);
  }
});

/**
 * Life with a tree to sit on: its perch sways a little, as the snag does in the wind. With `sites` > 1 it has that many
 * places (at most 4): the top, and others on the sides of the crown that face the eye.
 */
function perchLife(over = {}, sites = 1, seed = null) {
  const h = testLife(12, { windSpeed: 6, ...over }, seed);
  h.life._view = h.view;
  h.life.state = h.state;
  h.life._trafficSeeded = true;
  h.life._nextVehicle = h.life._nextConvoy = h.life._nextAmbulance = h.life._nextPlane = 1e9;
  // (and no helicopter or kites: one crossing or gliding in by chance asked for frames while the bird sat, and failed
  // a run in 25 or so)
  h.life._nextHeli = h.life._nextKite = 1e9;
  h.life._nextPerch = 1e9;
  h.life._nextRaptorCheck = 1e9;
  h.life._nextFlock = h.life._nextGeese = 1e9;
  // the tree stands 28 m off to the left, its top a little below the eye
  h.perch = () => [-0.0245 + 0.0001 * Math.sin(h.life.t * 2.1), h.view.camY - 0.0004 + 0.00003 * Math.sin(h.life.t * 3.3), 0.0135];
  h.life.perchAt = h.perch;
  if (sites > 1) {
    // offset from the top (km) and the way out of the crown there
    const places = [[0, 0, 0, 0, 1, 0], [0.0015, -0.0006, 0.0008, 0.8, 0.3, 0.5], [0.0003, -0.0007, -0.0014, 0.2, 0.3, -0.9], [-0.0009, -0.0005, -0.0013, 0.4, 0.4, -0.8]].slice(0, sites);
    h.places = places;
    h.life.perchAt = (i = 0) => (places[i] ? h.perch().map((x, k) => x + places[i][k]) : null);
    h.life.perchCount = () => places.length;
    h.life.perchOut = (i = 0) => {
      const o = places[i].slice(3);
      const l = Math.hypot(...o);
      return o.map((x) => x / l);
    };
  }
  h.run = (seconds, each) => {
    for (let t = 0; t < seconds; t += 0.05) {
      h.life.update(0.05, h.state, h.view);
      if (each) each(t);
    }
  };
  h.bird = () => h.life.raptors.find((r) => r.mode === 'approach' || r.mode === 'settle' || r.mode === 'perched');
  /** Runs until `done()` or for `most` seconds; returns the seconds it took, or -1. */
  h.until = (done, most, each) => {
    for (let t = 0; t < most; t += 0.05) {
      h.life.update(0.05, h.state, h.view);
      if (each) each(t);
      if (done()) return t;
    }
    return -1;
  };
  return h;
}

test('a bird of prey comes down to the snag, sits exactly on it while it sways, turns its head, and flies off again', () => {
  const h = perchLife();
  seedRandom(h.ctx, 8);
  h.life.summon('perch');
  const r = h.bird();
  assert.ok(r && r.mode === 'approach', 'on its way in');
  let fastest = 0;
  let slowestNear = 1;
  const landedAt = h.until(() => r.mode === 'perched', 60, () => {
    const at = h.perch();
    const d = Math.hypot(r.pos[0] - at[0], r.pos[1] - at[1], r.pos[2] - at[2]);
    const v = Math.hypot(...r.vel);
    fastest = Math.max(fastest, v);
    if (d < 0.004 && r.mode === 'approach') slowestNear = Math.min(slowestNear, v);
  });
  assert.ok(landedAt > 3 && landedAt < 45, 'down after ' + landedAt.toFixed(1) + ' s');
  assert.ok(fastest < 0.015, 'at a bird\'s speed: ' + (fastest * 3600).toFixed(0) + ' km/h at most');
  assert.ok(slowestNear < 0.004, 'slowed right down for the last metres: ' + (slowestNear * 3600).toFixed(0) + ' km/h');
  assert.ok(r.sit >= 6 && r.sit <= 50, 'it will sit ' + r.sit.toFixed(0) + ' s');
  assert.ok(r.sp.span < 0.001, 'a small falcon, not one of the big soaring birds: ' + r.sp.span * 1000 + ' m across');
  // sitting: exactly on the moving perch, wings still, drawn sitting and after the tree, asking for no more frames
  const looks = new Set();
  let sat = 0;
  h.run(Math.min(r.sit - 0.5, 20), () => {
    if (r.mode !== 'perched') return;
    sat++;
    assert.deepEqual(r.pos, h.perch(), 'on the perch wherever it is');
    assert.equal(r.amp, 0, 'wings folded');
    looks.add(r.look);
    const all = sprites(h.life);
    const k = all.findIndex((x) => x.type === 9);
    assert.ok(k >= 0, 'drawn sitting');
    assert.ok(k >= h.life.nearFrom, 'after the tree, in front of it');
    assert.ok(all[k].f[10] > 8 && all[k].f[10] < 30, 'about ' + all[k].f[10].toFixed(0) + ' px tall on a 3840 px picture');
    assert.ok(Math.abs(all[k].f[8]) === 1, 'facing one way or the other');
    assert.equal(h.life.movers, 0, 'no more frames for a sitting bird: ' + (h.life.movers ? JSON.stringify({ raptors: h.life.raptors.map((x) => [x.sp.span, x.mode]), flock: !!h.life.flock, geese: !!h.life.geese, heli: !!h.life.heli, sats: h.life.sats.length, meteors: h.life.meteors.length, birds: h.life.birds }) : ''));
  });
  assert.ok(sat > 50 && looks.size >= 2, 'its head turned: ' + looks.size + ' ways in ' + (sat * 0.05).toFixed(0) + ' s');
  // and off: it drops forward, beats its wings, and is a soaring bird again
  h.run(r.sit + 1);
  assert.equal(r.mode, 'leave', 'flown off, out of the picture');
  assert.ok(r.flapLeft > 0 || r.amp > 0, 'beating its wings');
  const at = h.perch();
  h.run(4);
  assert.ok(Math.hypot(r.pos[0] - at[0], r.pos[1] - at[1], r.pos[2] - at[2]) > 0.01, 'and away from the tree');
  assert.ok(!sprites(h.life).some((x) => x.type === 9));
});

test('the bird comes in to the tree and leaves it in one smooth movement: low, swooping up, braking evenly, and never a jump', () => {
  const h = perchLife();
  seedRandom(h.ctx, 8);
  h.life.summon('perch');
  const r = h.bird();
  let prev = r.pos.slice();
  let pv = null;
  let worst = 0;
  let worstAt = '';
  let sitWas = null;
  let hop = 0;
  let fade = 0;
  let lowest = 1e9;
  let upAtTouch = 0;
  let foldAtSit = -1;
  let leftFor = 0;
  let was = r.mode;
  for (let k = 0; k < 2400 && leftFor < 3; k++) {
    h.life.update(0.05, h.state, h.view);
    const at = h.perch();
    const v = r.pos.map((x, i) => (x - prev[i]) / 0.05);
    // (sitting, it moves with the tree; the step on to it is covered by the settling)
    const jerk = pv && r.mode !== 'perched' && was !== 'perched' ? Math.hypot(...v.map((x, i) => x - pv[i])) / 0.05 : 0;
    if (jerk > worst) [worst, worstAt] = [jerk, r.mode + ' after ' + was + ', step ' + k];
    if (r.mode === 'approach') lowest = Math.min(lowest, r.pos[1] - at[1]);
    // on the picture: the sitting bird fades in where the flying one's body is and does not move as it takes over,
    // and the two together are always one whole bird
    const all = sprites(h.life);
    const sit = all.find((x) => x.type === 9);
    const fly = all.find((x) => x.type === 0);
    if (sit) {
      if (sitWas && r.mode !== 'leave') hop = Math.max(hop, Math.hypot(sit.f[0] - sitWas.f[0], sit.f[1] - sitWas.f[1]));
      if (sitWas) fade = Math.max(fade, Math.abs(sit.f[6] - sitWas.f[6]));
      else fade = Math.max(fade, sit.f[6]);
      if (fly) assert.ok(Math.abs(sit.f[6] + fly.f[6] - 1) < 0.02, 'one whole bird: ' + sit.f[6] + ' + ' + fly.f[6]);
      else assert.ok(sit.f[6] > 0.98 || r.mode !== 'perched');
    }
    sitWas = sit;
    if (r.mode === 'settle' && was === 'approach') upAtTouch = v[1];
    if (r.mode === 'perched' && was === 'settle') foldAtSit = r.fold;
    if (r.mode === 'perched' && r.sit > 1) r.sit = 1;
    if (r.mode === 'leave') leftFor += 0.05;
    // (leaving, it is followed by its body again, not its feet: that step is not a movement)
    pv = was === 'perched' ? null : v;
    was = r.mode;
    prev = r.pos.slice();
  }
  assert.ok(leftFor >= 3, 'it came, sat and left');
  assert.ok(worst < 0.02, 'never a jerk: ' + (worst * 1000).toFixed(1) + ' m/s2 at most (' + worstAt + ')');
  assert.ok(lowest < -0.0002 && lowest > -0.002, 'it comes in ' + (-lowest * 1000).toFixed(1) + ' m below its perch');
  assert.ok(upAtTouch > 0.0003, 'and is rising as its feet touch: ' + (upAtTouch * 1000).toFixed(2) + ' m/s');
  assert.equal(foldAtSit, 1, 'its wings are shut before it sits still');
  assert.ok(hop < 1.5, 'the sitting bird does not hop as it takes over: ' + hop.toFixed(2) + ' px at most on a 3840 px picture');
  assert.ok(fade < 0.3, 'and comes and goes by degrees: ' + fade.toFixed(2) + ' a step at most');
  assert.ok(r.fold === 0, 'and open again on the way out');
});

test('the falcon comes in from every side and leaves to every side, sits in different places, and never pops in or out of sight', () => {
  // (the user, 2026-11-18: "its come from same direction and go to same direction it shold be random like it may come
  // from any direction and fly to any direction seat diffrent place")
  const seed = +(process.env.LE_FALCON_SEED || 5);
  const h = perchLife({}, 4, seed);
  const { w, h: H } = h.view;
  const sector = (from, to) => Math.floor((((Math.atan2(to[0] - from[0], to[2] - from[2]) / (2 * Math.PI)) % 1) + 1) * 8) % 8;
  const edge = (f) => f[0] < 60 || f[0] > w - 60 || f[1] < 60 || f[1] > H - 60;
  const arrive = new Set();
  const leave = new Set();
  const places = [];
  let closest = 1;
  let closestAt = '';
  let worst = 0;
  let worstAt = '';
  const pops = [];
  for (let visit = 0; visit < 40; visit++) {
    h.life._nextPerch = 0;
    h.run(0.05);
    const r = h.life.raptors.find((x) => x.sp.span < 0.001 && x.mode === 'approach');
    assert.ok(r, 'visit ' + visit + ': a falcon sets out');
    places.push(r.site);
    arrive.add(sector(h.life.perchAt(r.site), r.pos));
    let prev = r.pos.slice();
    let pv = null;
    let was = r.mode;
    let shown = null; // the bird as last drawn flying: [x, y, alpha]
    for (let k = 0; k < 12000 && !r.dead; k++) {
      h.life.update(0.05, h.state, h.view);
      if (r.mode === 'perched' && r.sit > 1) r.sit = 1;
      if (r.mode === 'leave' && was !== 'leave') leave.add(sector(h.life.perchAt(r.site), r.target));
      const eye = Math.hypot(r.pos[0], r.pos[1] - h.view.camY, r.pos[2]);
      if (eye < closest) [closest, closestAt] = [eye, `visit ${visit}, ${r.mode}, place ${r.site}`];
      const v = r.pos.map((x, i) => (x - prev[i]) / 0.05);
      const jerk = pv && r.mode !== 'perched' && was !== 'perched' ? Math.hypot(...v.map((x, i) => x - pv[i])) / 0.05 : 0;
      if (jerk > worst) [worst, worstAt] = [jerk, `visit ${visit}, ${r.mode} after ${was}`];
      // on the picture: it comes into sight faint or at an edge of it, and goes the same way
      const all = sprites(h.life);
      const fly = all.find((x) => x.type === 0 && x.f[8] === r.phase);
      const now = fly ? [fly.f[0], fly.f[1], fly.f[6]] : null;
      if (now && !shown && was !== 'perched' && r.mode !== 'leave' && now[2] > 0.3 && !edge(now)) pops.push(`visit ${visit}: appeared at ${now.map((x) => x.toFixed(2))}`);
      if (!now && shown && r.mode === 'leave' && shown[2] > 0.3 && !edge(shown)) pops.push(`visit ${visit}: vanished at ${shown.map((x) => x.toFixed(2))}`);
      shown = now || (r.mode === 'perched' || r.mode === 'settle' ? shown : null);
      pv = was === 'perched' ? null : v;
      was = r.mode;
      prev = r.pos.slice();
    }
    assert.ok(r.dead, 'visit ' + visit + ' ended: ' + r.mode);
    h.life.raptors = h.life.raptors.filter((x) => x !== r);
  }
  assert.ok(arrive.size >= 6, 'came in from ' + arrive.size + ' of 8 sides: ' + [...arrive]);
  assert.ok(leave.size >= 6, 'flew off to ' + leave.size + ' of 8 sides: ' + [...leave]);
  assert.ok(new Set(places).size >= 3, 'sat in ' + new Set(places).size + ' places: ' + places);
  assert.ok(places.every((p, i) => i === 0 || p !== places[i - 1]), 'never the same place twice running: ' + places);
  assert.ok(closest >= 0.0149, 'never nearer the eye than 15 m: ' + (closest * 1000).toFixed(1) + ' m (' + closestAt + ')');
  assert.ok(worst < 0.02, 'never a jerk: ' + (worst * 1000).toFixed(1) + ' m/s2 (' + worstAt + ')');
  assert.deepEqual(pops, [], 'nothing pops in or out of sight');
});

test('a bird sits on the tree only in fair weather, only when one is about, one at a time, and not without a tree', () => {
  // rain: none comes in, and one that is sitting leaves at once
  const wet = perchLife();
  wet.life.summon('perch');
  const r = wet.bird();
  assert.ok(wet.until(() => r.mode === 'perched', 60) >= 0, 'it came down');
  r.sit = 1e6;
  wet.state.weather.rain = 0.4;
  wet.life.birds = true;
  wet.run(0.2);
  assert.notEqual(r.mode, 'perched', 'off when the rain starts');
  // a gale: the one on its way in gives up
  const gale = perchLife({ windSpeed: 45 });
  gale.life.summon('perch');
  const g = gale.life.raptors[0];
  gale.run(1);
  assert.ok(g && g.mode !== 'approach' && g.mode !== 'perched', 'no perching in a gale: ' + (g && g.mode));
  // by itself: only a bird that is already about, near enough, and only one
  const h = perchLife();
  seedRandom(h.ctx, 12);
  h.life._nextPerch = 0;
  h.run(0.1);
  assert.equal(h.life.raptors.filter((x) => x.mode === 'approach' && x.sp.span < 0.001).length, 1, 'a falcon comes in by itself');
  assert.ok(h.life._nextPerch >= 300, 'and it is minutes before the next chance');
  for (let i = 0; i < 3; i++) h.life.summon('raptor');
  assert.ok(h.life.raptors.filter((x) => x.sp.span > 0.002).every((x) => x.mode !== 'approach'), 'the big soaring birds stay up');
  const dark = perchLife();
  dark.state.astro.sunAltDeg = -20;
  dark.life._nextPerch = 0;
  dark.run(0.1);
  assert.equal(dark.life.raptors.length, 0, 'none at night');
  h.life._nextPerch = 0;
  h.run(0.1);
  assert.equal(h.life.raptors.filter((x) => x.mode === 'approach' || x.mode === 'perched').length, 1, 'never two');
  // no tree (switched off): nothing to sit on
  const bare = perchLife();
  bare.life.perchAt = () => null;
  bare.life.summon('perch');
  bare.life.summon('raptor');
  bare.life._nextPerch = 0;
  bare.run(0.5);
  assert.ok(!bare.life.raptors.some((x) => x.mode === 'approach' || x.mode === 'perched'));
  // main.js gives life the perch from the tree, and the renderer draws the near bird after the tree
  assert.ok(readSrc('main.js').includes('const p = renderer.fg && renderer.fg.perchEye(i);'));
  assert.ok(readSrc('main.js').includes('life.perchCount = () => (renderer.fg ? renderer.fg.perchCount() : 0);'));
  const rn = readSrc('engine/renderer.js');
  assert.ok(/this\.fg\.draw\(state\);[^}]*\}\n      this\._setClip\(clip\);\n      this\._spritePass\(state, true\);/.test(rn) && rn.includes('this.fg.draw(state);\n          this._spritePass(state, true);'), 'in both kinds of frame');
});

// ---------------------------------------------------------------- the motion's clock (birds, leaves, the tree)
// A frame that came seconds late moved every bird across the whole gap at once, and a gap over 2 s made the falling
// leaves start over: on screen, birds and leaves vanished and appeared somewhere else.
function steady(c, from, n, ms) {
  let now = from;
  for (let i = 0; i < n; i++) c.tick((now += ms));
  return now;
}

test('a late frame moves birds and leaves on a little, never across the whole gap', () => {
  const { LE } = load(['services/clock.js']);
  const c = new LE.SceneClock(0);
  let now = steady(c, 0, 100, 50);
  near(c.t, 5, 1e-9, 'frames 50 ms apart keep real time');
  const before = c.t;
  c.tick((now += 3000)); // the PC busy for 3 s
  const moved = c.t - before;
  assert.ok(moved <= LE.SceneClock.MIN_CAP_MS / 1000 + 1e-9, `3 s late: ${moved} s of motion in one frame`);
  assert.ok(moved >= 0.05, 'but it does move on');
  const after = c.t;
  steady(c, now, 20, 50);
  near(c.t - after, 1, 1e-9, 'and keeps real time again at once');
});

test('a pause moves nothing on: the next frame goes on from the held picture', () => {
  const { LE } = load(['services/clock.js']);
  const c = new LE.SceneClock(0);
  let now = steady(c, 0, 40, 50);
  const held = c.t;
  now += 10 * 60e3; // ten minutes in an app
  c.resume(now);
  c.tick((now += 50));
  near(c.t - held, 0.05, 1e-9, 'one frame on');
});

test('a chip that is slow all the time keeps real time', () => {
  const { LE } = load(['services/clock.js']);
  const c = new LE.SceneClock(0);
  const now = steady(c, 0, 15, 600);
  const t = c.t;
  steady(c, now, 10, 600);
  near(c.t - t, 6, 1e-9, 'frames 0.6 s apart, after a few of them');
  const d = new LE.SceneClock(0);
  steady(d, 0, 20, 120); // rest mode on a slow chip: fades 120 ms apart
  near(d.t, 2.4, 1e-9, 'frames 120 ms apart from the first');
});

test('the page moves birds and leaves on the motion clock, and a pause resumes it', () => {
  const main = readFileSync(new URL('main.js', SRC), 'utf8');
  assert.ok(!main.includes('simStart'), 'no clock that runs on through a pause');
  assert.ok(/lastState\.time = sceneClock\.tick\(now\);\s*stepLife\(lastState\);/.test(main), 'a fade sets the time first, then moves life');
  assert.ok(main.includes('const timeSec = sceneClock.tick(nowReal);'), 'a scene frame too');
  assert.ok(/sceneClock\.resume\(lastReal\);\s*env\.refreshSky\(\);/.test(main), 'a resume goes on from the held picture, with the sun where it is now');
  assert.ok(/renderer\.refreshSky\(\);\s*renderer\.forgetFrame\(\);/.test(main), 'and does not time the pause as a frame on the GPU');
  assert.ok(/renderer\.forgetFrame\(\);[^}]*renderer\.forgetPictures\(\);/.test(main), 'and draws the next scene whole, not from pictures kept before it');
  assert.ok(/renderer\.setArea\(restMs \? restArea : null\);\s*renderer\.onStill = showStill;\s*const drew = renderer\.render\(state, dt\);/.test(main),
    'the free screen\'s part of the width reaches the renderer, in the app\'s rest only');
  // measured on the UHD 730: at 20 fades a second the free screen took 14–16 % of the chip, as much as the old rest
  assert.ok(/if \(restMs && restArea\) rate = Math\.min\(rate, FADE_FPS\);/.test(main), 'and its fades come at the dissolve\'s rate, 10 a second');
});

// Two screens, an app in front on one: the other screen stood still too, and a whole screen of desktop not moving
// beside the app looked wrong (2026-11-10), so from 2.3.0 to 2.6.0 it moved gently, drawn again on its own. Since
// 2026-11-22 the app holds every screen still instead (the next tests); the page still draws a part of the width when asked.
test('rest with a part of the width draws the scene again only there', () => {
  const { r, gl } = newRendererWithFence();
  const calls = [];
  Object.assign(gl, {
    READ_FRAMEBUFFER: 10,
    DRAW_FRAMEBUFFER: 11,
    FRAMEBUFFER: 12,
    COLOR_BUFFER_BIT: 1,
    NEAREST: 2,
    bindFramebuffer: (t, f) => calls.push(['bind', t, f]),
    blitFramebuffer: (...a) => calls.push(['blit', ...a]),
  });
  r.w = 3840;
  r.h = 1080;
  r.pictureBands = 8;
  r.pictureA = { fbo: 'A' };
  r.pictureB = { fbo: 'B' };
  r.pictureNext = { fbo: 'N' };
  const bands = [];
  r._compositePass = (s, meter, band) => bands.push(band);
  const picture = () => {
    calls.length = 0;
    bands.length = 0;
    r._pictureJob = { state: { time: 5 }, time: 5, y: 0, fresh: true };
    r._pictureStep(); // the frame it begins
    assert.equal(bands.length, 0, 'nothing drawn in the frame that begins it');
    while (r._pictureJob.y < r.h) r._pictureStep();
  };

  r.setArea([0.5, 1]);
  picture();
  const blits = calls.filter((c) => c[0] === 'blit');
  assert.equal(blits.length, 1, 'the latest picture is copied into the next one, once');
  assert.deepEqual(blits[0].slice(1, 9), [0, 0, 3840, 1080, 0, 0, 3840, 1080], 'whole');
  assert.ok(calls.some((c) => c[0] === 'bind' && c[1] === 10 && c[2] === 'B') && calls.some((c) => c[0] === 'bind' && c[1] === 11 && c[2] === 'N'), 'from the latest, into the next');
  assert.ok(bands.length >= 8, `${bands.length} bands`);
  for (const b of bands) assert.deepEqual([b.x, b.w], [1920, 1920], 'only the right-hand screen');
  assert.equal(bands.reduce((s, b) => s + b.h, 0), 1080, 'all of its height');

  r.setArea([0, 0.5]);
  picture();
  for (const b of bands) assert.deepEqual([b.x, b.w], [0, 1920], 'the app went to the other screen');

  r.setArea(null);
  picture();
  assert.equal(calls.filter((c) => c[0] === 'blit').length, 0, 'drawn whole: nothing to copy');
  for (const b of bands) assert.deepEqual([b.x, b.w], [0, 3840], 'all of the width');

  r.setArea([0.7, 0.2]);
  assert.equal(r._area, null, 'an empty part is no part');

  r._pictureReady = true;
  r._pictureJob = { y: 0 };
  r.forgetPictures();
  assert.equal(r._pictureReady, false, 'after a pause the kept pictures are old');
  assert.equal(r._pictureJob, null);
});

test('the page takes the part of the width to draw again in rest, and nothing else', () => {
  const h = load(['config.js', 'services/host.js'], { search: '?host=1' });
  h.ctx.document.createElement = () => ({ remove() {} });
  h.ctx.document.head = { appendChild: (s) => s.onload() };
  let now = 1; // the page's clock never reads 0
  h.ctx.performance = { now: () => now };
  const got = [];
  h.ctx.leSetArea = (a) => got.push(['area', a && [...a]]);
  h.ctx.leSetSlowFrames = (ms) => got.push(['slow', ms]);
  h.ctx.livelyWallpaperPlaybackChanged = (p) => got.push(['paused', p.IsPaused]);
  h.ctx.__leReady = true;
  h.tick();
  now = 7000; // settled
  const say = (pace, opts) => {
    got.length = 0;
    h.ctx.leHostState(pace, opts);
    h.tick();
    return got;
  };
  assert.deepEqual(say('rest', { area: [0.5, 1] }), [['area', [0.5, 1]], ['slow', 2000], ['paused', false]]);
  assert.deepEqual(say('rest', { area: [0.5, 1] }), [], 'the same again changes nothing');
  assert.deepEqual(say('rest', { area: [0, 0.5] }), [['area', [0, 0.5]], ['slow', 2000], ['paused', false]], 'the app went to the other screen');
  assert.deepEqual(say('rest', {})[0], ['area', null], 'rest while the PC is busy draws all of it');
  assert.deepEqual(say('still', {}), [['area', null], ['slow', 0], ['paused', true]], 'an app in front with no free screen');
  assert.deepEqual(say('live', { area: [0.5, 1] }), [['area', null], ['slow', 0], ['paused', false]], 'an area means nothing outside rest');
  for (const bad of [[0.6, 0.4], [0, 2], ['a', 1], [0.5], 'left']) {
    say('rest', { area: [0.25, 0.75] });
    assert.deepEqual(say('rest', { area: bad })[0], ['area', null], JSON.stringify(bad));
  }
});

// The free second screen moving gently while you worked looked like the wallpaper never stopped (the user, 2026-11-22:
// "when screen one is blocked the other monitor keeps going"). They chose every screen still while an app is in front,
// with the light redrawn once a minute.
test('an app in front holds every screen still, with a new picture once a minute; locked or paused, none at all', () => {
  const h = load(['config.js', 'services/host.js'], { search: '?host=1' });
  h.ctx.document.createElement = () => ({ remove() {} });
  h.ctx.document.head = { appendChild: (s) => s.onload() };
  let now = 1;
  h.ctx.performance = { now: () => now };
  const got = [];
  h.ctx.leSetArea = (a) => got.push(['area', a && [...a]]);
  h.ctx.leSetSlowFrames = (ms) => got.push(['slow', ms]);
  h.ctx.leSetHold = (ms) => got.push(['hold', ms]);
  h.ctx.livelyWallpaperPlaybackChanged = (p) => got.push(['paused', p.IsPaused]);
  h.ctx.__leReady = true;
  h.tick();
  now = 7000;
  const say = (pace) => {
    got.length = 0;
    h.ctx.leHostState(pace, {});
    h.tick();
    return got;
  };
  assert.deepEqual(say('hold'), [['area', null], ['slow', 0], ['hold', 60000], ['paused', true]], 'an app in front');
  assert.deepEqual(say('still'), [['area', null], ['slow', 0], ['hold', 0], ['paused', true]], 'locked or paused: no new pictures');
  assert.deepEqual(say('live'), [['area', null], ['slow', 0], ['hold', 0], ['paused', false]], 'back on the desktop');
  assert.deepEqual(say('rest'), [['area', null], ['slow', 2000], ['hold', 0], ['paused', false]], 'busy PC, desktop in front');
  // the page: pausing starts the minute, coming back stops it, and the picture is begun and drawn by the renderer
  const main = readSrc('main.js');
  assert.ok(/pausedPanelTimer = setInterval\(updateIfPaused, 5000\);\s*planHold\(\);/.test(main), 'a pause plans the next picture');
  assert.ok(/\} else \{\s*stopHold\(\);/.test(main), 'a resume stops it');
  assert.ok(/sceneClock\.resume\(nowReal\);\s*env\.refreshSky\(\);\s*updateMoonView\(\);\s*const state = env\.update\(LE\.clock\.now\(\), dt, sceneClock\.t, Math\.min\(gap, 600\)\);/.test(main),
    'the light and weather now, the scene\'s own time standing');
  assert.ok(main.includes('if (!renderer.holdBegin(state, dt)) return planHold();') && main.includes('renderer.frameDone() && renderer.holdStep(lastState)'),
    'one band a frame, each after the GPU has finished the last');
  // the app's side: an app in front is "hold", never the old gentle rest on a free screen
  const cs = readFileSync(new URL('../host/LivingEarthHost.cs', import.meta.url), 'utf8');
  assert.ok(/if \(work\) return Hold;/.test(cs) && !cs.includes('FreeArea') && !cs.includes('area: ['), 'the app asks for hold, with no free screen');
});

test('held still, the new picture is drawn a band at a time off the screen and shown in one frame', () => {
  const { r, gl, advance, signal } = newRendererWithFence();
  const draws = [];
  r.status = 'running';
  r.w = 3840;
  r.h = 1080;
  r.pictureBands = 8;
  r.pictureA = { fbo: 'A', tex: ['a'] };
  r.pictureB = { fbo: 'B', tex: ['b'] };
  r.pictureNext = { fbo: 'N', tex: ['n'] };
  r._compositePass = (s, meter, band) => draws.push(['band', band && band.y, band && band.h]);
  r.drawFade = (f) => draws.push(['screen', f, r.pictureB.fbo]);
  r._volumePass = () => draws.push(['volume']);
  r._shadow = { y: 0 };
  let shadowSteps = 0;
  r._shadowStep = () => shadowSteps++;
  r._pictureJob = { state: { time: 5 }, time: 5, y: 0, fresh: true };
  r._holdVolPasses = 3; // as holdBegin leaves it
  let frames = 0;
  while (!r.holdStep({ time: 5 })) {
    frames++;
    assert.ok(frames < 40, 'it ends');
    assert.ok(!draws.some((d) => d[0] === 'screen'), 'nothing on the screen while the bands are drawn');
  }
  const bands = draws.filter((d) => d[0] === 'band');
  assert.deepEqual(draws.slice(0, 3).map((d) => d[0]), ['volume', 'volume', 'volume'], 'first the clouds catch up, one pass a frame');
  assert.equal(draws.filter((d) => d[0] === 'volume').length, 3, 'three of them');
  assert.equal(bands.reduce((s, b) => s + b[2], 0), 1080, 'the bands cover the whole height');
  assert.ok(bands.every((b) => b[2] <= 1080 / 8 + 1), 'each an eighth of it at most');
  assert.deepEqual(draws[draws.length - 1], ['screen', 1, 'N'], 'then the new picture goes on the screen whole, at once');
  assert.equal(draws.filter((d) => d[0] === 'screen').length, 1, 'in one frame');
  assert.ok(shadowSteps >= bands.length, 'a shadow refresh moves on with the bands');
  assert.equal(r._pictureJob, null);
  assert.ok(r.holdStep({ time: 5 }), 'nothing more to draw');
  // a shadow chunk while held is a small one, as on the desktop: the app in front must never wait
  r._bgPacer = { targetMs: 0, maxPx: 0 };
  r.setSlowMode(true, true, true);
  assert.equal(r._bgPacer.targetMs, 4);
  r.setSlowMode(true, true);
  assert.equal(r._bgPacer.targetMs, 25, 'rest keeps its bigger chunks');
});

test('a long step keeps the falling leaves going instead of starting them over', () => {
  const { fg, run } = newForeground();
  run(12, 36, [1, 0]);
  const seeds = fg.drift.map((L) => L.seed);
  assert.ok(seeds.length > 5, 'leaves in the air');
  const st = { time: 12 + 2.4, treeKmh: 36, gustDir: [1, 0], season: [0, 1, 0, 0], astro: { dayOfYear: 310 } };
  fg.update(st); // a chip that draws about once a second: a late frame moves on 2.4 s
  const still = seeds.filter((k) => fg.drift.some((L) => L.seed === k)).length;
  assert.ok(still >= seeds.length * 0.5, `${still} of ${seeds.length} still falling, not all gone at once`);
});

// Measured across a pause, one frame seemed to take many seconds on the GPU, and the frames after it were spaced
// that far apart: after every return to the desktop the wallpaper stood nearly still for minutes (seen 2026-11-10).
test('a pause is not counted as time on the GPU', () => {
  const { r, advance, signal } = newRendererWithFence();
  r.gpuBusyMs = 12;
  r._fenceFrame();
  advance(10);
  assert.equal(r.frameDone(), false, 'on the GPU when the wallpaper paused');
  signal(true);
  advance(60000); // a minute in an app: nobody looks
  r.forgetFrame(); // the page goes on
  assert.equal(r.frameDone(), true, 'finished long ago');
  near(r.gpuBusyMs, 12, 1e-9, 'the minute away is not the frame’s cost');
  r._fenceFrame();
  advance(16);
  assert.equal(r.frameDone(), true);
  near(r.gpuBusyMs, 12 + (8 - 12) * 0.2, 1e-9, 'the next frame is measured as usual');
});

test('a slow frame watched at every refresh still counts in full', () => {
  const { r, advance, signal } = newRendererWithFence();
  r._fenceFrame();
  for (let t = 0; t < 400; t += 16) {
    assert.equal(r.frameDone(), false);
    advance(16);
  }
  signal(true);
  assert.equal(r.frameDone(), true);
  near(r.gpuBusyMs, 400 - 8, 1e-9, 'the GPU really was busy that long');
});

// ---------------------------------------------------------------- 2.4.0 steps 10 to 12
/** A small baked view for the place finders: 400 by 200, a degree to nine pixels, level ground 5 km off unless told otherwise. */
function bakedView(over = {}) {
  const v = { w: 400, h: 200, pxAng: 0.002, horizonY: 0.5, camY: 2.8 };
  return { v, dist: () => 5, normalY: () => 0.95, bare: () => true, ...over };
}

test('the waterfall is put on the tallest steep bare rock face in view, below the snow, and carries more water after rain', () => {
  const { LE } = load(RENDER_FILES);
  const R = LE.Renderer;
  const cliff = (x, y) => x >= 198 && x <= 202 && y >= 80 && y < 140;
  const b = bakedView({ normalY: (x, y) => (cliff(x, y) ? 0.2 : 0.95) });
  const pick = (o = {}, maxY = 3.9) => R.pickFall(400, 40, 170, o.dist || b.dist, o.normalY || b.normalY, o.bare || b.bare, b.v, maxY);
  const f = pick();
  assert.ok(f, 'found');
  near(f.x, 0, 0.02, 'straight ahead');
  near(f.z, 5, 0.03, '5 km off');
  near(f.y, 2.8 + 39 * 0.002 * 5, 0.02, 'its top is the top of the face');
  near(f.foot, 2.8 - 20 * 0.002 * 5, 0.02, 'its foot the foot of the face');
  assert.equal(pick({ normalY: () => 0.95 }), null, 'no steep face, no fall');
  assert.equal(pick({ bare: () => false }), null, 'not down a forested slope');
  assert.equal(pick({}, 3.0), null, 'not above the snow, where it would be frozen all year');
  assert.equal(pick({ normalY: (x, y) => (cliff(x, y) && y < 90 ? 0.2 : 0.95) }), null, 'a face 100 m high is too small to carry one');
  assert.equal(pick({ dist: () => 14 }), null, 'nor one too far off to see');
  // a face broken by a nearer ridge half way up is two faces, not one
  const split = pick({ dist: (x, y) => (y < 110 ? 5 : 6.5) });
  assert.ok(split && split.y - split.foot < 0.35, 'two faces: ' + (split.y - split.foot).toFixed(2));
  // of two faces the one that stands taller in the picture
  const two = pick({ normalY: (x, y) => (cliff(x, y) || (x >= 98 && x <= 102 && y >= 100 && y < 130) ? 0.2 : 0.95) });
  near(two.x, 0, 0.02, 'the taller of two');
  assert.equal(R.fallFlow(0), 0.3, 'a thread in dry weather');
  assert.equal(R.fallFlow(1), 1, 'in spate after rain');
  assert.ok(R.fallFlow(0.5) > R.fallFlow(0.2) && R.fallFlow(7) === 1);
  const sh = readSrc('engine/shaders/composite.js');
  assert.ok(sh.includes('float wide = mix(0.0012, 0.0045, uFallFlow) * (0.6 + 0.8 * along);'), 'wider with more water, and towards its foot');
  assert.ok(sh.includes('if (uFallFlow > 0.0 && !ledge) alb = mix(alb, vec3(0.78, 0.83, 0.88), waterfall(pos) * (1.0 - snow) * (1.0 - canopy));'), 'white water on the rock; hidden under snow');
  assert.ok(sh.includes('abs(dot(rel, sight)) > 0.4'), 'only on its own face, not on ridges in front of it or behind');
  const src = readSrc('engine/renderer.js');
  assert.ok(src.includes('this._findFall();') && src.includes("p.set('uFallFlow', fall && this.cfg.waterfall !== false ? Renderer.fallFlow(w.wet) : 0);"));
  // cloud shadows crossing the hills were there already: the deck's own density along the way to the sun
  assert.ok(sh.includes('float cloudShadow(vec3 pos) {') && sh.includes('vec3 p = pos + L / ly * (hMid - pos.y);'));
});

test('festival nights: Tihar and Diwali by the year, every house lit with oil lamps, fireworks over the villages', () => {
  const { LE } = load(['engine/environment.js']);
  const fest = (y, m, d, h) => LE.Environment.festival(new Date(y, m - 1, d, h, 0, 0));
  assert.equal(fest(2026, 11, 8, 20), 1, 'the night of Laxmi Puja');
  assert.equal(fest(2026, 11, 9, 3), 1, 'still that night after midnight');
  assert.equal(fest(2026, 11, 7, 21), 0.5, 'the evening before');
  assert.equal(fest(2026, 11, 9, 20), 0.7, 'the evening after');
  assert.equal(fest(2026, 11, 10, 20), 0.5, 'Bhai Tika');
  assert.equal(fest(2026, 11, 11, 20), 0, 'over');
  assert.equal(fest(2026, 11, 6, 20), 0, 'not yet');
  assert.equal(fest(2026, 5, 15, 22), 0, 'an ordinary night');
  assert.equal(fest(2027, 10, 29, 22), 1, 'it moves with the moon: 2027');
  assert.equal(fest(2025, 10, 20, 22), 1, '2025');
  assert.equal(fest(2050, 11, 1, 22), 0, 'a year not in the table: no festival, never a guess');
  assert.ok(readSrc('engine/environment.js').includes('s.festival = Environment.festival(s.now);'));
  // the lamps
  const sh = readSrc('engine/shaders/composite.js');
  assert.ok(sh.includes('float fest = uFestival > 0.001 ? step(fract(id * 9.1), uFestival) : 0.0;'), 'that share of the houses');
  assert.ok(sh.includes('float on = clamp(evening + allNight + earlyRiser + fest, 0.0, 1.0);') && sh.includes('on *= max(lit, max(allNight, fest));'), 'lit all night');
  assert.ok(sh.includes('c = mix(c, vec3(1.0, 0.56, 0.22), fest);') && sh.includes('* (1.0 + 1.5 * fest);'), 'warmer and brighter');
  assert.ok(readSrc('engine/renderer.js').includes("p.set('uFestival', this.cfg.life === false || this.cfg.lights === false ? 0 : Math.max(state.festival || 0, this.festForce || 0));"), 'part of the village lights');
  // the fireworks
  const night = (over = {}, festival = 1) => {
    const h = hills(21, over);
    h.state.festival = festival;
    h.life.villageSmoke = false;
    seedRandom(h.ctx, 11);
    return h;
  };
  const count = (h, seconds = 900) => {
    const seen = new Set();
    h.run(seconds, () => h.life.fireworks.forEach((f) => seen.add(f)));
    return seen.size;
  };
  const main = count(night());
  assert.ok(main >= 20 && main <= 90, 'on the night itself, in 15 minutes: ' + main);
  const beside = count(night({}, 0.5));
  assert.ok(beside >= 2 && beside < main, 'fewer on the evenings around it: ' + beside);
  assert.equal(count(night({}, 0)), 0, 'none on an ordinary night');
  assert.equal(count(night({ rain: 0.5 })), 0, 'none in rain');
  assert.equal(count(night({ fog: 0.9 })), 0, 'none in fog');
  const dark = night();
  dark.life.lights = false;
  assert.equal(count(dark), 0, 'none with the village lights turned off');
  const day = hills(12);
  day.state.festival = 1;
  assert.equal(count(day), 0, 'none by day');
  // one rocket: up from a village, slowing to the top of its rise, then a ball of sparks there
  const h = night();
  const f = h.life._newFirework();
  const home = h.life.smokeSources.reduce((a, b) => (Math.hypot(b.x - f.at[0], b.z - f.at[2]) < Math.hypot(a.x - f.at[0], a.z - f.at[2]) ? b : a));
  assert.ok(Math.hypot(home.x - f.at[0], home.z - f.at[2]) < 0.045, 'from a village');
  assert.ok(f.height >= 0.25 && f.height <= 0.4 && f.radius >= 0.15 && f.radius <= 0.2 && f.life <= 3.4, 'big enough to see its sparks from 9 to 16 km');
  const yAt = (age) => h.LE.Life.fireworkAt({ ...f, age })[1];
  near(yAt(-f.rise), f.at[1], 1e-9, 'from the ground');
  near(yAt(0), f.at[1] + f.height, 1e-9, 'to its height');
  assert.ok(yAt(-f.rise * 0.5) - yAt(-f.rise) > yAt(0) - yAt(-f.rise * 0.5), 'slowing as it climbs');
  near(yAt(1), yAt(0), 1e-9, 'the burst stays where it went off');
  h.life.fireworks = [Object.assign(f, { age: 0.5 })];
  h.life._write(h.state);
  const sp = sprites(h.life).filter((x) => x.type === 10);
  assert.equal(sp.length, 1);
  const p = h.LE.Life.fireworkAt(f);
  const dist = Math.hypot(p[0], p[1] - h.view.camY, p[2]);
  near(sp[0].f[11], f.radius / dist / h.view.pxAng, 1e-3, 'as big on the picture as a burst that size, that far off');
  assert.ok(sp[0].f[2] >= sp[0].f[11] * 2.2, 'with room for the sparks to sink');
  const ss = readSrc('engine/shaders/sprites.js');
  assert.ok(ss.includes('if (type == 10) {') && ss.includes('float outA = 1.0 - exp(-age * 3.0);') && ss.includes('vec2 sinkA = vec2(0.0, 0.1 * R * age * age);'));
  assert.ok(ss.includes('vec2 back = dir * outB - sinkB;') && ss.includes('vec2 dd = vLocal - back - ab * h;'), 'each spark a streak');
  assert.ok(ss.includes('if (t > 0.0 && t < dist) discard;'), 'a nearer ridge hides it');
  assert.ok(ss.includes('float few = clamp(R * R / 1200.0, 0.0025, 0.5);') && ss.includes('c *= fade * few * clamp(outA * outA * 2.5, 0.25, 1.0);'), 'far off it keeps its colour');
  // from the test panel: one every few seconds, and by day it first sets the clock to the evening
  const forced = night({}, 0);
  forced.life.festForce = 1;
  const many = count(forced, 120);
  assert.ok(many >= 15, 'the test panel: many in two minutes: ' + many);
  const panel = readSrc('ui/debugpanel.js');
  assert.ok(panel.includes("if (!s || s.sunAltDeg > -8) this._clock({ time: '20:30' }); R.festForce = life.festForce = 1;"), 'by day the panel makes it night');
});

test('more life: black kites over a near village or the slopes below, herds on the meadows by day, a monastery lamp at night, a helicopter now and then', () => {
  // kites
  const h = hills(12);
  h.life.birds = true;
  h.life.villageSmoke = false;
  const villageAt = { x: 0.3, y: 2.3, z: 0.9 };
  h.life.setSmokeSources([villageAt, { x: -3, y: 2.4, z: 8 }]);
  seedRandom(h.ctx, 21);
  const isKite = (r) => r.sp.span === 0.0015;
  let most = 0;
  let circled = 0;
  h.run(1500, () => {
    const kites = h.life.raptors.filter(isKite);
    most = Math.max(most, kites.filter((k) => k.mode !== 'leave').length); // (one on its way out does not count)
    for (const k of kites) {
      if (k.mode !== 'circle') continue;
      circled++;
      assert.ok(Math.hypot(k.pos[0] - villageAt.x, k.pos[2] - villageAt.z) < 0.17, 'over the village');
      assert.ok(k.pos[1] - villageAt.y >= 0.049 && k.pos[1] - villageAt.y <= 0.18, 'low over its roofs: ' + (k.pos[1] - villageAt.y).toFixed(3));
    }
  });
  assert.ok(most >= 1 && most <= 3, 'one or two: ' + most);
  assert.ok(circled > 100, 'and they circle there: ' + circled);
  const far = hills(12);
  far.life.birds = true;
  far.life.villageSmoke = false;
  far.life.setSmokeSources([{ x: -3, y: 2.4, z: 8 }]);
  seedRandom(far.ctx, 21);
  // a village too far off to see a kite over it: they hang over the slopes just below the viewpoint instead, where one
  // is five to nine pixels across (2026-11-18: with no village near, there were none, not even from the test panel)
  let overSlopes = 0;
  far.run(900, () => {
    for (const k of far.life.raptors.filter(isKite)) {
      if (k.mode !== 'circle') continue;
      overSlopes++;
      const d = Math.hypot(k.pos[0], k.pos[2]);
      assert.ok(d > 0.15 && d < 0.5, 'out from the viewpoint: ' + d.toFixed(2));
      assert.ok(k.pos[1] < far.view.camY - 0.04 && k.pos[1] > far.view.camY - 0.17, 'below the eye: ' + (k.pos[1] - far.view.camY).toFixed(3));
      const span = 0.0015 / Math.hypot(k.pos[0], k.pos[1] - far.view.camY, k.pos[2]) / far.view.pxAng;
      assert.ok(span > 4.5, 'big enough to see: ' + span.toFixed(1) + ' px');
    }
  });
  assert.ok(overSlopes > 50, 'they come all the same: ' + overSlopes);
  far.life.raptors = far.life.raptors.filter((r) => !isKite(r));
  far.life.summon('kite');
  assert.equal(far.life.raptors.filter(isKite).length, 1, 'and the test panel calls one up');
  const nightK = hills(23);
  nightK.life.birds = true;
  nightK.life.villageSmoke = false;
  nightK.life.setSmokeSources([villageAt]);
  nightK.run(300, () => assert.equal(nightK.life.raptors.filter(isKite).length, 0, 'none at night'));

  // herds
  const g = hills(12);
  g.life.villageSmoke = false;
  const n = [0.12, 0, 0.1];
  n[1] = Math.sqrt(1 - n[0] * n[0] - n[2] * n[2]);
  const meadow = { x: 0.3, y: 2.5, z: 1.4, n };
  seedRandom(g.ctx, 31);
  g.life.setPastures([meadow]);
  const herd = g.life.herds[0];
  assert.ok(herd.animals.length >= 4 && herd.animals.length <= 8, herd.animals.length + ' animals');
  let moved = 0;
  let last = herd.animals.map((a) => [a.x, a.z]);
  g.run(1200, () => {
    herd.animals.forEach((a, i) => {
      const step = Math.hypot(a.x - last[i][0], a.z - last[i][1]);
      assert.ok(step <= 0.00025 + 1e-9, 'a slow walk at most');
      moved += step;
      assert.ok(Math.hypot(a.x, a.z) <= 0.0301, 'within 30 m of the middle of the herd');
      const p = g.LE.Life.animalAt(herd, a);
      near((p[0] - meadow.x) * n[0] + (p[1] - meadow.y) * n[1] + (p[2] - meadow.z) * n[2], 0, 1e-9, 'on the slope of the meadow');
    });
    last = herd.animals.map((a) => [a.x, a.z]);
  });
  assert.ok(moved > 0.05, 'they wander: ' + (moved * 1000).toFixed(0) + ' m between them in 20 minutes');
  g.state.snowLine = 5;
  g.life._write(g.state);
  const beasts = () => sprites(g.life).filter((x) => x.type === 11 && x.f[8] === 0);
  assert.equal(beasts().length, herd.animals.length, 'each one drawn');
  for (const b of beasts()) assert.ok(b.f[2] >= 1.2 && b.f[6] > 0 && b.f[6] <= 1, 'at least a pixel wide, fainter when really smaller');
  g.state.snowLine = 2.4;
  g.life._write(g.state);
  assert.equal(beasts().length, 0, 'not on snow');
  g.state.snowLine = 5;
  g.life.animals = false;
  g.life.update(1, g.state, g.view);
  assert.equal(beasts().length, 0, 'the switch');
  const dusk = hills(22);
  dusk.life.villageSmoke = false;
  dusk.life.setPastures([meadow]);
  dusk.state.snowLine = 5;
  dusk.life.update(1, dusk.state, dusk.view);
  assert.equal(sprites(dusk.life).filter((x) => x.type === 11 && x.f[8] === 0).length, 0, 'taken in at night');

  // the monastery
  const lamp = (hh, glow, lights = true) => {
    const m = hills(hh);
    m.life.villageSmoke = false;
    m.life.lights = lights;
    m.life.setGompa({ x: 1, y: 3.1, z: 6 });
    m.state.lampGlow = glow;
    m.state.snowLine = 5;
    m.life.update(1, m.state, m.view);
    return sprites(m.life).filter((x) => x.type === 11 && x.f[8] === 1);
  };
  assert.equal(lamp(22, 1).length, 1, 'its lamp at night');
  assert.equal(lamp(12, 0).length, 0, 'not by day');
  assert.equal(lamp(22, 1, false).length, 0, 'it goes with the village lights');

  // the helicopter
  const s = skyLife(12, 0);
  seedRandom(s.ctx, 41);
  for (let k = 0; k < 30; k++) {
    const c = s.life._newHeli(false);
    const at = (c2) => s.LE.Life.heliAt(c2);
    const p0 = at(c);
    assert.ok(Math.abs(Math.atan2(p0[0], p0[2])) > s.view.hfov / 2, 'it comes in from out of sight');
    let nearest = 1e9;
    for (let q = c.s; q <= c.s1; q += 0.05) nearest = Math.min(nearest, Math.hypot(c.C[0] + c.dir[0] * q, c.C[1] + c.dir[1] * q));
    // near enough to be seen for what it is: at 2.5 to 7 km it was a dot 6 px long (the user, 2026-11-17)
    assert.ok(nearest > 0.7 && nearest <= 2.21, 'a km or two off: ' + nearest.toFixed(1));
    assert.ok(c.y >= s.view.camY - 0.09 * nearest / 0.95 && c.y <= s.view.camY + 0.21 * nearest / 0.95, 'about the height of the eye, inside the picture');
    assert.ok([0, 1, 2].includes(c.paint), 'in one of three paints');
  }
  // on the picture: tens of pixels long, with room in its patch for its lights; by day they are off, by night on,
  // the red one flashing; and it is drawn at the birds' frame rate while it crosses
  const heliSprite = (hour) => {
    const n = skyLife(hour, 0);
    seedRandom(n.ctx, 3);
    n.life.summon('helicopter');
    const flashes = new Set();
    let f = null;
    for (let k = 0; k < 40; k++) {
      n.life.update(0.05, n.state, n.view);
      f = sprites(n.life).find((x) => x.type === 11 && x.f[8] === 2).f;
      flashes.add(f[14]);
    }
    return { f, flashes, movers: n.life.movers };
  };
  const hd = heliSprite(12);
  assert.ok(hd.f[12] * 2 >= 17 && hd.f[12] * 2 <= 60, 'its length on the picture: ' + (hd.f[12] * 2).toFixed(0) + ' px');
  assert.ok(hd.f[2] > hd.f[12] + 5 && hd.f[3] > hd.f[12] * 0.45 + 5, 'room for the rotor and the lights');
  assert.equal(hd.f[13], 0, 'no lights by day');
  assert.ok(hd.movers >= 1, 'it moves, so it is drawn often');
  const hn = heliSprite(23);
  assert.equal(hn.f[13], 1, 'lights on at night');
  assert.ok(hn.flashes.has(0) && hn.flashes.has(1), 'the red light flashes');
  const sp = readSrc('engine/shaders/sprites.js');
  assert.ok(sp.includes('float cabin = ') && sp.includes('float boom = ') && sp.includes('float fin = ') && sp.includes('float disc = ') && sp.includes('float tailRotor = '), 'cabin, tail boom, fin, rotor and tail rotor');
  assert.ok(sp.includes('fragColor = vec4(grade(L * T + skyH * (1.0 - T)) * a + lamps, a);'), 'its lights are added to it');
  // the contrail by night: it was a black line over the stars; it hides less in the dark and is never darker than the sky
  assert.ok(sp.includes('* seen * alpha * mix(1.0, 0.4, uNight);') && sp.includes('lightC = max(lightC, skyLUT(rd) * 1.15);'), 'a trail is never darker than the sky behind it');
  {
  s.life.heli = s.life._newHeli(false);
  const before = s.LE.Life.heliAt(s.life.heli);
  s.life.update(1, s.state, s.view);
  const after = s.LE.Life.heliAt(s.life.heli);
  near(Math.hypot(after[0] - before[0], after[2] - before[2]), 0.045, 1e-6, '45 m/s');
  near(after[1], before[1], 1e-12, 'level');
  }
  let gone = false;
  for (let k = 0; k < 2000 && !gone; k++) {
    s.life.update(1, s.state, s.view);
    gone = !s.life.heli;
  }
  assert.ok(gone, 'and it leaves');
  s.life.summon('helicopter');
  assert.ok(s.life.heli, 'the test panel calls one up');
  s.life._write(s.state);
  assert.equal(sprites(s.life).filter((x) => x.type === 11 && x.f[8] === 2).length, 1);
  s.life.planes = false;
  s.life.update(1, s.state, s.view);
  assert.equal(s.life.heli, null, 'it goes with the aircraft switch');
  const wet = skyLife(12, 0);
  wet.state.weather.rain = 0.6;
  wet.life._nextHeli = 0;
  wet.life.update(1, wet.state, wet.view);
  assert.equal(wet.life.heli, null, 'none sets out in rain');
  // (2026-11-24, the user: "also i dont see any helicopter") one every 15 to 40 minutes by day, under a broken deck
  // too, and seen in the pictures held still while you work
  for (const seed of [1, 2, 3]) {
    const m = skyLife(12, 0);
    seedRandom(m.ctx, seed);
    m.life._nextHeli = 600;
    m.state.weather.coverage = 0.85;
    const flights = new Set();
    let shown = 0;
    for (let k = 0; k < 120; k++) {
      m.life.catchUpAir(60, m.state, m.view);
      if (m.life.heli) flights.add(m.life.heli);
      if (sprites(m.life).some((x) => x.type === 11 && x.f[8] === 2)) shown++;
    }
    assert.ok(flights.size >= 3 && flights.size <= 8, `seed ${seed}: ${flights.size} helicopters in two hours held`);
    assert.ok(shown >= flights.size, `seed ${seed}: in ${shown} pictures`);
  }

  // their places, found in the baked view
  const { LE } = load(RENDER_FILES);
  const R = LE.Renderer;
  const b = bakedView();
  const flat = () => [0, 1, 0];
  const grassAt = (x, y) => y >= 60 && y < 90 && ((x > 40 && x < 120) || (x > 280 && x < 360));
  const near2 = { ...b, dist: (x, y) => (y < 90 ? 2 : 6) };
  const P = R.pickPastures(400, 40, 170, near2.dist, flat, grassAt, b.v);
  assert.ok(P.length >= 2 && P.length <= 3, P.length + ' meadows');
  for (let i = 0; i < P.length; i++) for (let j = 0; j < i; j++) assert.ok(Math.hypot(P[i].x - P[j].x, P[i].z - P[j].z) > 0.4, 'apart');
  assert.equal(R.pickPastures(400, 40, 170, () => 6, flat, grassAt, b.v).length, 0, 'not so far off that an animal would not show');
  assert.equal(R.pickPastures(400, 40, 170, near2.dist, () => [0.6, 0.8, 0], grassAt, b.v).length, 0, 'not on a steep slope');
  assert.equal(R.pickPastures(400, 40, 170, near2.dist, flat, () => false, b.v).length, 0, 'only on grass');
  // a ridge 5 km off against land 12 km off, up to row 120; above it the far land, then sky
  const ridge = R.pickRidge(400, 40, 170, (x, y) => (y <= 120 ? 5 : y < 150 ? 12 : 0), b.v, 3.9);
  assert.ok(ridge, 'a ridge found');
  near(ridge.t, 5, 1e-9, 'on the nearer ridge');
  near(ridge.y, 2.8 + 20 * 0.002 * 5, 0.03, 'at its crest');
  assert.equal(R.pickRidge(400, 40, 170, () => 5, b.v, 3.9), null, 'a plain slope has no ridge line');
  assert.equal(R.pickRidge(400, 40, 170, (x, y) => (y <= 120 ? 5 : 0), b.v, 2.9), null, 'not above the snow');
  const src = readSrc('engine/renderer.js');
  assert.ok(src.includes('this.life.setPastures(this.pastures);') && src.includes('this.life.setGompa(this.gompa);'));
  const ss = readSrc('engine/shaders/sprites.js');
  assert.ok(ss.includes('if (type == 11) {') && ss.includes('if (t > 0.0 && t < dist * 0.985 - 0.03) discard;'), 'only a ridge clearly nearer hides them');
  // the switch for the animals, like the others
  assert.equal(load(['config.js']).LE.config.animals, true);
  assert.equal(load(['config.js'], { search: '?animals=0' }).LE.config.animals, false);
  assert.ok(readSrc('services/host.js').includes("animals: [c.animals, 'animals'],") && readSrc('main.js').includes('life.animals = cfg.animals !== false;'));
});

test('goats graze on the rock by the tree by day, stand on its top, walk off at dusk and in heavy rain, and come back from the left', () => {
  // 2026-11-18: "grazing animals is marked but i cant see any": the near slopes are all forest and a meadow far off
  // holds an animal under a pixel, so they graze where the eye can see them, on the rock with the tree
  const { LE } = load(RENDER_FILES);
  const h = testLife(12);
  const v = h.view;
  const a0 = (-0.672 * v.hfov) / 2;
  const site = [Math.sin(a0) * 28, -3.6, Math.cos(a0) * 28, 1.4]; // renderer.js TREE, treeSite()
  const al = Math.hypot(site[0], site[2]);
  const [ax, az] = [site[0] / al, site[2] / al];
  // a baked view of a level top at the foot of the tree, from 12 m to its left to the point, 5 m either side; beyond it
  // far land
  const W = Math.ceil(v.w * 0.32);
  const H = Math.ceil(v.h * 0.5);
  const dist = (x, y) => {
    const a = (x - 0.5 * v.w) * v.pxAng;
    const ty = (y - v.horizonY * v.h) * v.pxAng;
    const len = Math.hypot(Math.sin(a), ty, Math.cos(a));
    const T = site[1] / ty;
    if (!(T > 0)) return 6;
    const qx = Math.sin(a) * T - site[0];
    const qz = Math.cos(a) * T - site[2];
    const X = qx * az - qz * ax;
    const D = qx * ax + qz * az;
    if (X > -12 && X < 2.6 && D > -5 && D < 5) return (T * len) / 1000;
    return 6;
  };
  const M = LE.Renderer.ledgeMap(W, H, dist, () => 0.7, v, site);
  let seen = 0;
  for (let c = 0; c < M.h.length; c++) {
    if (M.h[c] !== M.h[c]) continue;
    if (M.h[c] > -1) {
      seen++;
      near(M.h[c], 0, 0.02, 'the top is level at the foot of the tree');
      near(M.grass[c], 0.7, 1e-5, 'and as grassy as it looked');
    }
  }
  assert.ok(seen > 200, seen + ' cells of the top seen');
  assert.ok(M.minX > -12.5 && M.minX < -5, 'seen from its left edge on the picture: ' + M.minX);

  const life = h.life;
  life._view = v;
  life.state = h.state;
  life.birds = false;
  life.setLedge(M);
  seedRandom(h.ctx, 4);
  const onTop = (g) => Math.abs(g.Y) < 0.02 && life._goatGround(g.X, g.D);
  life.update(1, h.state, v);
  assert.ok(life.goats.length >= 2 && life.goats.length <= 4, 'a herd there at once by day: ' + life.goats.length);
  let walked = 0;
  let grazed = 0;
  for (let t = 0; t < 1800; t++) {
    life.update(1, h.state, v);
    for (const g of life.goats) {
      if (g.mode === 'arrive' || g.mode === 'leave') continue;
      assert.ok(onTop(g), `on the top: ${g.X.toFixed(2)}, ${g.D.toFixed(2)}, ${g.Y.toFixed(3)} (${g.mode})`);
      assert.ok(Math.hypot(g.X, g.D) >= 2.1, 'clear of the trunk');
      if (g.stride > 0.5) walked++;
      if (g.head > 0.8) grazed++;
    }
  }
  assert.ok(grazed > walked * 2 && walked > 50, `mostly grazing (${grazed}), walking now and then (${walked})`);
  // no flat sprites any more (goats.js draws them in 3D); a walking goat in view still asks for the birds' frame rate
  life._write(h.state);
  assert.equal(sprites(life).filter((x) => x.type === 12).length, 0, 'not drawn as sprites');
  const g0 = life.goats[0];
  const was = g0.stride;
  g0.stride = 1;
  assert.ok(life._goatsWalking() >= 1, 'a walking goat counts as moving');
  g0.stride = was;
  // dusk: they walk off to the left and are gone; none comes by night
  h.state.astro.sunAltDeg = 0;
  life.update(1, h.state, v);
  assert.ok(life.goats.every((g) => g.mode === 'leave'), 'off at dusk');
  for (let t = 0; t < 300; t++) life.update(1, h.state, v);
  assert.equal(life.goats.length, 0, 'gone');
  h.state.astro.sunAltDeg = -20;
  for (let t = 0; t < 3600; t++) life.update(1, h.state, v);
  assert.equal(life.goats.length, 0, 'none by night');
  // by day again they come back, walking in from beyond the left of the picture
  h.state.astro.sunAltDeg = 30;
  let back = null;
  for (let t = 0; t < 2000 && !back; t++) {
    life.update(1, h.state, v);
    if (life.goats.length) back = life.goats[0];
  }
  assert.ok(back && back.mode === 'arrive', 'back by day');
  const pr = life._project(...life._goatWorld(back.X, back.D, back.Y));
  assert.ok(pr.sx < 0, 'from off the picture: ' + pr.sx.toFixed(0));
  for (let t = 0; t < 120; t++) life.update(1, h.state, v);
  assert.ok(life.goats.some((g) => g.mode !== 'arrive'), 'and on to the grass');
  // heavy rain sends them off; the switch takes them at once
  h.state.weather.rain = 0.6;
  life.update(1, h.state, v);
  assert.ok(life.goats.every((g) => g.mode === 'leave'), 'off in the rain');
  h.state.weather.rain = 0;
  life.summon('goats');
  assert.ok(life.goats.length >= 2 && life.goats.every((g) => g.mode === 'graze'), 'the test panel puts a herd there');
  life.animals = false;
  life.update(1, h.state, v);
  assert.equal(life.goats.length, 0, 'Grazing animals off: none');
  // the renderer finds the rock after the bake and hands it over; the sprite: rock in front hides it
  const src = readSrc('engine/renderer.js');
  assert.ok(src.includes('this._findLedge();') && src.includes('if (this.life) this.life.setLedge(this.ledge);'));
  assert.ok(readSrc('main.js').includes('life.setLedge(renderer.ledge);'));
  assert.ok(!readSrc('engine/shaders/sprites.js').includes('type == 12'), 'the flat goat is gone');
});

test('a goat is a lit 3D body: it stands on its hooves, grazes with its mouth at the grass, walks with each foot in turn, and kids have no horns', () => {
  // 2026-11-18, the user on the flat goat: "goat is in 2nd mode itr should be 3d", "goat looks like cardboard"
  const { LE } = load(['engine/gl.js', 'engine/goats.js']);
  const FL = LE.Goats.FLOATS;
  const base = { X: 0, D: 0, Y: 0, h: 0, head: 0, stride: 0, phase: 0, clock: 3, seed: 0.5, size: 1 };
  const build = (g, ground = () => 0) => {
    const out = new Float32Array(4096 * FL);
    const lofts = [];
    const pose = LE.goatPose({ ...base, ...g }, ground);
    const n = LE.goatMesh(pose, out, 0, LE.goatMesh.IDENTITY, lofts);
    return { pose, out, n, lofts };
  };
  const ref = build({});
  assert.ok(ref.n > 800 && ref.n < 2000, 'a body of ' + ref.n + ' points');
  // the same rings in every pose and for every goat, so one index list serves them all
  for (const g of [{ head: 1 }, { stride: 1, phase: 2 }, { seed: 0.05, size: 0.6 }, { seed: 0.95 }, { clock: 77 }]) {
    const b = build(g);
    assert.equal(b.n, ref.n, 'same number of points: ' + JSON.stringify(g));
    assert.deepEqual(b.lofts, ref.lofts);
    for (let i = 0; i < b.n; i++) {
      const o = i * FL;
      for (let k = 0; k < 14; k++) assert.ok(Number.isFinite(b.out[o + k]), 'finite');
      near(Math.hypot(b.out[o + 3], b.out[o + 4], b.out[o + 5]), 1, 1e-3, 'unit normals');
    }
  }
  // standing: all four soles on the ground, each under its knee or hock, a grown goat about 0.7 m at the withers
  const top = Math.max(...Array.from({ length: ref.n }, (_, i) => (ref.out[i * FL + 6] === 0 && ref.out[i * FL + 12] === 0 ? ref.out[i * FL + 1] : -1)));
  near(top, 0.69, 0.03, 'height at the withers');
  for (const L of ref.pose.legs) {
    near(L.G[1], 0, 1e-6, 'sole on the ground');
    assert.ok(L.M[1] > L.F[1] && L.T[1] > L.M[1], 'joints one above the other');
    assert.ok(L.fore ? L.M[0] > L.F[0] - 0.03 : L.M[0] < L.F[0], 'the hock behind the foot, the knee over it');
  }
  // grazing its mouth is at the grass; looking up its head is high
  const graze = build({ head: 1 }).pose;
  assert.ok(graze.muzzle[1] < 0.09, 'mouth at the grass: ' + graze.muzzle[1].toFixed(3));
  assert.ok(build({ head: 0 }).pose.muzzle[1] > 0.55, 'head up');
  // walking: each foot in turn; at any moment at least two on the ground, and a lifted one clear of it
  let minDown = 4;
  let maxLift = 0;
  for (let ph = 0; ph < Math.PI * 2; ph += 0.1) {
    const legs = build({ stride: 1, phase: ph }).pose.legs;
    minDown = Math.min(minDown, legs.filter((L) => L.G[1] < 1e-6).length);
    maxLift = Math.max(maxLift, ...legs.map((L) => L.G[1]));
  }
  assert.ok(minDown >= 2 && maxLift > 0.05, `feet down ${minDown}, highest lift ${maxLift.toFixed(3)} m`);
  // on a slope each foot stands on the rock under it
  const slope = build({}, (x) => 0.2 * x).pose.legs;
  for (const L of slope) near(L.G[1], 0.2 * L.G[0], 0.02, 'on the slope');
  // a kid has no horns and no beard; a buck has long horns
  assert.equal(build({ seed: 0.05 }).pose.hornL, 0);
  assert.equal(build({ seed: 0.05 }).pose.beard, false);
  assert.ok(build({ seed: 0.9 }).pose.hornL > build({ seed: 0.3 }).pose.hornL);
  // drawn in 3D, lit as the tree is, beyond the tree before it and nearer than the tree after it, in every frame path
  const rs = readSrc('engine/renderer.js');
  assert.equal(rs.split('this.goats.draw(state, false);').length - 1, 2);
  assert.equal(rs.split('this.goats.draw(state, true);').length - 1, 2);
  assert.ok(rs.indexOf('this.goats.draw(state, false);') < rs.indexOf('this.fg.draw(state);'));
  const gs = readSrc('engine/shaders/goat.js');
  assert.ok(gs.includes('uTreeL[7]') && gs.includes('capsLight(') && gs.includes('discard'), "the tree's light, its own shadow, hidden by nearer rock");
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.ok(html.indexOf('src/engine/shaders/goat.js') > 0 && html.indexOf('src/engine/goats.js') > html.indexOf('src/engine/foreground.js'));
});

// ---- 2026-11-22 evening: the moon in view, the airport's cloud, weather while held, fresh data, the still, headlights --
// (the user, Uttara: "outside is dark and i can see the moon now", "no single plane flown in wallpaper", "golden hour
// wallpaper become morning for half sec", "make sure every 15 min fetch weather data they make impact on scenario",
// "weather cache should reset old data every new fetch", "there is big light in village")
const MOON_VIEW = (() => {
  const hfov = (140 * Math.PI) / 180;
  return { w: 3840, h: 1080, hfov, pxAng: hfov / 3840, horizonY: 0.4, camY: 2.8 };
})();
const PANEL_RT = { x0: 3531 / 3840, y0: 40 / 1080, x1: 3796 / 3840, y1: 275 / 1080 }; // right-top, small, on 3840×1080
const DEG = Math.PI / 180;
function moonEnv(keep = PANEL_RT) {
  const h = newEnv();
  h.cfg.render.heading = 50;
  h.env.setLocation({ lat: 23.867, lon: 90.4, name: 'Uttara' });
  h.env.setMoonView(MOON_VIEW, keep);
  return h;
}
/** Where the moon's disk is on the picture: x, and y from the top, in pixels. */
const moonPx = (s, v = MOON_VIEW) => {
  const d = s.moonShowDir;
  return [v.w / 2 + Math.atan2(d[0], d[2]) / v.pxAng, v.h - (v.horizonY * v.h + d[1] / Math.hypot(d[0], d[2]) / v.pxAng)];
};
const TOP_EDGE = Math.atan((1 - MOON_VIEW.horizonY) * MOON_VIEW.h * MOON_VIEW.pxAng);

test('the moon is drawn where the picture can show it: as it is low down in view, squeezed under the top edge higher up', () => {
  const { LE } = newEnv();
  const show = (rel, alt, side = 0, keep = null) => [...LE.Environment.moonShown(rel * DEG, alt * DEG, MOON_VIEW, side, keep)].map((x) => x / DEG);
  const same = (a, b, msg) => a.forEach((x, i) => near(x, b[i], 1e-9, msg));
  same(show(20, 5), [20, 5], 'in the picture and low: where it is');
  same(show(-60, 11.9), [-60, 11.9]);
  near(TOP_EDGE / DEG, 22.4, 0.1, 'the sky reaches 22.4 degrees up');
  let was = 12;
  for (const alt of [13, 20, 30, 50, 70, 89]) {
    const up = show(0, alt)[1];
    assert.ok(up > was && up < TOP_EDGE / DEG - 3 + 1e-9, `${alt} degrees up is drawn at ${up.toFixed(2)}`);
    was = up;
  }
  near(show(0, 12.001)[1], 12.001, 1e-3, 'no kink where the squeeze begins');
  // out of the picture, at the side it left by
  near(show(100, 30, 1)[0], 66, 1e-9, 'held 4 degrees in from the right edge');
  near(show(-170, 30, 1)[0], 66, 1e-9, 'behind the viewer it stays at the side it left by');
  near(show(100, 30, -1)[0], -66, 1e-9);
  // the panel: kept out from under it
  const [rel, alt] = show(64, 40, 0, PANEL_RT);
  const x = MOON_VIEW.w / 2 + (rel * DEG) / MOON_VIEW.pxAng;
  assert.ok(x < PANEL_RT.x0 * MOON_VIEW.w - 20, 'beside the panel, not under it: ' + x.toFixed(0));
  near(show(64, 2, 0, PANEL_RT)[0], 64, 1e-9, 'well under the panel it is where it is');
  assert.ok(show(64, 5, 0, PANEL_RT)[0] < 64 && show(64, 5, 0, PANEL_RT)[0] > show(64, 9, 0, PANEL_RT)[0], 'and eased aside as it rises towards it');
  near(alt, show(64, 40)[1], 1e-9, 'its height is not changed');
});

test('2026-11-22 19:00 at Uttara the moon is on the right screen, at its true bearing, high under the top edge; its light stays true', () => {
  const { env } = moonEnv();
  const s = env.update(new Date('2026-11-22T13:00:00Z'), 0.5, 1);
  near(s.astro.moonAzDeg, 93.3, 0.3, 'its bearing');
  near(s.astro.moonAltDeg, 50.4, 0.3, 'and height');
  const d = s.moonShowDir;
  near((Math.atan2(d[0], d[2]) / DEG + 50), 93.3, 1.5, 'drawn at its bearing');
  const up = Math.asin(d[1]) / DEG;
  assert.ok(up > 12 && up < TOP_EDGE / DEG - 2.9, 'under the top edge, above 12 degrees: ' + up.toFixed(2));
  const [x, y] = moonPx(s);
  assert.ok(x > 1920 && x < PANEL_RT.x0 * 3840 && y > 60 && y < 200, `on the right screen at ${x.toFixed(0)}, ${y.toFixed(0)}`);
  near(Math.asin(s.moonDir[1]) / DEG, 50.4, 0.3, 'the light comes from where it really is');
  assert.ok(s.moonVis > 0.99);
  // the sun as seen from the drawn disk is turned with it: the same phase and lit side
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  near(dot(s.moonShowSun, s.moonShowDir), dot(s.sunDir, s.moonDir), 1e-5, 'the lit fraction is kept');
  near(Math.hypot(...s.moonShowSun), 1, 1e-5);
  // with no view yet (the renderer not running) it is drawn where it is
  const bare = newEnv();
  bare.env.setLocation({ lat: 23.867, lon: 90.4, name: 'Uttara' });
  const b = bare.env.update(new Date('2026-11-22T13:00:00Z'), 0.5, 1);
  for (let i = 0; i < 3; i++) near(b.moonShowDir[i], b.moonDir[i], 1e-6);
});

test('after leaving the picture the moon stays at that edge until it sets, never jumping across behind the viewer', () => {
  // 2026-11-22: it passes south of the zenith and leaves over the right edge at about 21:00
  const { env } = moonEnv(null);
  let held = 0;
  for (let m = 0; m <= 330; m += 10) {
    const s = env.update(new Date(Date.parse('2026-11-22T17:00:00Z') + m * 60e3), 0.5, m + 1); // 23:00 to 04:30
    if (s.astro.moonAltDeg < 0.5) break;
    const [x] = moonPx(s);
    near(x, 1920 + (66 * DEG) / MOON_VIEW.pxAng, 2, 'at the right edge at ' + m);
    held++;
  }
  assert.ok(held > 25, 'all night: ' + held);
  // 2026-11-26 after midnight it passes just north of the zenith (its declination over the latitude) and goes down
  // in the north-west: it leaves over the left edge, and stays there
  const north = moonEnv(null);
  let seen = 0;
  for (let m = 0; m <= 300; m += 10) {
    const s = north.env.update(new Date(Date.parse('2026-11-25T21:30:00Z') + m * 60e3), 0.5, m + 1);
    if (s.astro.moonAltDeg < 0.5) break;
    assert.ok(moonPx(s)[0] < 120, 'held at the left edge: ' + moonPx(s)[0].toFixed(0));
    seen++;
  }
  assert.ok(seen > 10, 'until it sets: ' + seen);
});

test('night after night the drawn moon glides: never more than 30 px in a minute, never under the panel', () => {
  for (const start of ['2026-11-22T09:00:00Z', '2026-11-25T09:00:00Z', '2026-06-14T21:00:00Z']) {
    const { env } = moonEnv();
    let prev = null;
    let worst = 0;
    let up = 0;
    for (let m = 0; m < 22 * 60; m++) {
      const s = env.update(new Date(Date.parse(start) + m * 60e3), 0.5, m + 1);
      if (s.moonVis <= 0) {
        prev = null;
        continue;
      }
      up++;
      const [x, y] = moonPx(s);
      if (prev) worst = Math.max(worst, Math.hypot(x - prev[0], y - prev[1]));
      prev = [x, y];
      const under = x + 10 > PANEL_RT.x0 * 3840 && x - 10 < PANEL_RT.x1 * 3840 && y + 10 > PANEL_RT.y0 * 1080 && y - 10 < PANEL_RT.y1 * 1080;
      assert.ok(!under, `${start}: under the panel at minute ${m} (${x.toFixed(0)}, ${y.toFixed(0)})`);
      assert.ok(y > 60, `${start}: clear of the top edge at minute ${m}`);
    }
    assert.ok(up > 300, `${start}: the moon was up ${up} minutes`);
    assert.ok(worst <= 30, `${start}: at most ${worst.toFixed(1)} px in a minute`);
  }
  // the renderer is told: both programs that draw it get the drawn direction and the sun as seen from it
  const r = readSrc('engine/renderer.js');
  assert.ok(r.includes("p.set('uMoonShowDir', state.moonShowDir);") && r.includes("p.set('uMoonShowSun', state.moonShowSun);"));
  const comp = readSrc('engine/shaders/composite.js');
  assert.ok(comp.includes('float cm = dot(rd, uMoonShowDir);') && comp.includes('vec3 Tm = transmittance(uCamPos.y, uMoonDir.y);'), 'drawn there, as bright as its true height lets it be');
  assert.ok(comp.includes('dot(n, uMoonShowSun)'), 'lit as in the sky');
  assert.ok(readSrc('engine/shaders/volume.js').includes('float cosM = dot(rd, uMoonShowDir);'), "the clouds' bright edges round it");
  assert.ok(readSrc('main.js').includes('env.setMoonView(renderer.viewInfo(), keep);'), 'main.js gives the view and the panel');
});

test("the close airport's sky groups decide the cloud: 2026-11-22 evening, FEW015 SCT100 over WeatherAPI's 74 %", () => {
  const { LE, merge, targets } = airport();
  const now = Date.now();
  const forecast = { code: 0, cloud: 6, cloudLow: 4, cloudMid: 4, cloudHigh: 0, humidity: 74, visibility: 7300, windSpeed: 5, windDir: 240, precip: 0, temp: 26.5, source: 'live' };
  const wapi = { t: now - 15 * 60e3, code: 1063, text: 'Patchy rain nearby', cloud: 74, vis: 10000, temp: 27, dewp: 22, hum: 74, wind: 5, dir: 240, precip: 0.07 };
  const vghs = { id: 'VGHS', name: 'Dhaka', km: 2.3, t: now - 20 * 60e3, temp: 27, dewp: 22, vis: 3500, wx: 'HZ', sky: 'FEW015 SCT100' };
  const before = merge(LE.withWeatherApi(forecast, wapi, now), { ...vghs, sky: '' }, now);
  near(before.cloud, 74, 0.01, "without the sky groups, WeatherAPI's cloud");
  const r = merge(LE.withWeatherApi(forecast, wapi, now), vghs, now);
  near(r.cloudLow, 19, 0.5, 'FEW at 1,500 ft: low');
  near(r.cloudMid, 31, 0.5, "SCT at 10,000 ft: middle, what it adds over the FEW below it");
  near(r.cloudHigh, 0, 1e-9, 'no high cloud: as the forecast had');
  near(r.cloud, 44, 0.5);
  assert.equal(r.code, 1);
  assert.equal(LE.weatherLabel(r), 'Haze');
  assert.equal(r.wapiText, undefined, "WeatherAPI's words were about its own cloud");
  assert.equal(r.obs.sky, 'FEW015 SCT100');
  assert.ok(targets(r).coverage < targets(before).coverage, 'less cloud drawn');
  // SKC: none at all; CLR and NCD: none up to the middle, the forecast's cirrus stays; NSC and CAVOK: no low cloud
  const cirrus = { ...forecast, cloud: 70, cloudLow: 50, cloudMid: 30, cloudHigh: 40 };
  const skc = merge(cirrus, { ...vghs, wx: '', sky: 'SKC' }, now);
  assert.deepEqual([skc.cloudLow, skc.cloudMid, skc.cloudHigh, skc.cloud, skc.code], [0, 0, 0, 0, 0]);
  const clr = merge(cirrus, { ...vghs, wx: '', sky: 'NCD' }, now);
  assert.deepEqual([clr.cloudLow, clr.cloudMid, clr.cloudHigh, clr.cloud], [0, 0, 40, 40]);
  for (const sky of ['NSC', 'CAVOK']) {
    const n = merge(cirrus, { ...vghs, wx: '', sky }, now);
    assert.deepEqual([n.cloudLow, n.cloudMid, n.cloudHigh], [0, 30, 40], sky + ' keeps the middle and high cloud');
  }
  // overcast low down over a forecast of 5 %; a high layer listed replaces the forecast's
  const ovc = merge({ ...forecast, cloud: 5, cloudLow: 5, cloudMid: 0, cloudHigh: 0 }, { ...vghs, wx: '', sky: 'OVC008' }, now);
  assert.equal(ovc.code, 3);
  assert.equal(ovc.cloud, 100);
  assert.equal(LE.weatherLabel(ovc), 'Overcast');
  const high = merge(cirrus, { ...vghs, wx: '', sky: 'FEW030CB BKN250' }, now);
  near(high.cloudLow, 19, 0.5);
  assert.equal(high.cloudMid, 0, 'none listed in the middle');
  near(high.cloudHigh, 69, 0.5, 'BKN over FEW: what it adds');
  // a report too far off, too old, or with the sky hidden (VV, which the fog has) leaves the cloud alone
  assert.equal(merge(cirrus, { ...vghs, km: 30 }, now).cloud, 70, '30 km off');
  assert.equal(merge(cirrus, { ...vghs, t: now - 70 * 60e3 }, now).cloud, 70, '70 minutes old');
  const fog = merge(cirrus, { ...vghs, wx: 'FG', vis: 200, sky: 'VV002' }, now);
  assert.equal(fog.cloud, 70);
  assert.equal(fog.code, 45);
  // and rain stays as it was decided: a close airport seeing rain under OVC keeps the rain code
  const rain = merge({ ...forecast, code: 63, precip: 2, rain: 2, cloud: 90 }, { ...vghs, wx: '-RA', sky: 'BKN012 OVC080' }, now);
  assert.equal(rain.code, 63);
  assert.equal(rain.cloud, 100);
  // the Windows app sends the groups: read from the report's text up to its trend, CB and TCU kept
  const cs = readFileSync(new URL('../host/LivingEarthHost.cs', import.meta.url), 'utf8');
  assert.ok(cs.includes('", wx: " + Q(Wx) + ", sky: " + Q(Sky) + " }"') && cs.includes('Sky = Clip(SkyOf(d), 60),'));
});

test('held still while you work, the weather comes in at the pace it would with the desktop in sight', () => {
  const GOAL = { ...CLEAR, code: 3, cloud: 80, cloudLow: 80 };
  const goal = settledOn(GOAL).env.state.weather.coverage;
  assert.ok(goal > 0.5);
  const when = new Date('2026-11-03T06:00:00Z');
  // seconds until the cover is 90 % of the way there: frames every half second, or one picture a minute (dt 25 s, as
  // main.js holdPicture caps it, and the real minute for the weather)
  const timeTo = (held, weatherDt = 60) => {
    const { env } = settledOn(CLEAR);
    env.setWeather(GOAL, 'live');
    let t = 10;
    for (let sec = 0; sec < 3600; ) {
      if (held) {
        sec += weatherDt;
        t += 25;
        env.update(when, 25, t, weatherDt);
      } else {
        sec += 0.5;
        t += 0.5;
        env.update(when, 0.5, t);
      }
      if (env.state.weather.coverage >= 0.9 * goal) return sec;
    }
    return Infinity;
  };
  const live = timeTo(false);
  const held = timeTo(true);
  assert.ok(live < 15 * 60, 'in sight it comes in within the quarter of an hour: ' + live + ' s');
  assert.ok(Math.abs(held - live) <= 90, `held, as fast as in sight: ${held} s against ${live} s`);
  assert.ok(held < 15 * 60, 'each 15-minute fetch is on the screen before the next');
  // the old way, the weather eased only by the 25 s each picture: 2.4 times slower
  assert.ok(timeTo(true, 25) * (60 / 25) > live * 1.8, 'before');
  // a long gap is eased through in steps: no snap, and where it would be in that much real time
  for (const gap of [120, 600]) {
    const { env } = settledOn(CLEAR);
    env.setWeather(GOAL, 'live');
    env.update(when, 25, 40, gap);
    const once = env.state.weather.coverage;
    const step = settledOn(CLEAR);
    step.env.setWeather(GOAL, 'live');
    let t = 10;
    for (let i = 0; i < gap * 2; i++) step.env.update(when, 0.5, (t += 0.5));
    near(once, step.env.state.weather.coverage, 0.06, `${gap} s of weather in one picture, as ${gap} s in sight`);
    if (gap === 120) assert.ok(once < goal * 0.8 && once > 0.02, 'two minutes: part of the way, not snapped: ' + once.toFixed(3));
  }
  // the page passes the real gap, up to ten minutes; the clouds' drift keeps to dt
  const main = readSrc('main.js');
  assert.ok(main.includes('const state = env.update(LE.clock.now(), dt, sceneClock.t, Math.min(gap, 600));'));
});

test('each fetch replaces what the last one gave, in memory and in storage; only a failed fetch keeps old data', async () => {
  let n = 0;
  const answers = [
    { cloud_cover_low: 10, cloud_cover_mid: 33, visibility: 9000, temperature_2m: 20 },
    { cloud_cover_low: 20, temperature_2m: 21 }, // no middle cloud or visibility this time
  ];
  const { weather, store } = newWeather(async () => ok(answers[Math.min(n++, 1)]), { refreshMinutes: 100 });
  let told = 0;
  weather.onUpdate(() => told++);
  weather.start(23.7, 90.4);
  await sleep(30);
  assert.equal(weather.current().cloudMid, 33);
  const afterFirst = told;
  weather.refreshNow();
  await sleep(30);
  weather.stop();
  assert.equal(n, 2);
  const r = weather.current();
  assert.equal(r.cloudLow, 20);
  assert.equal(r.temp, 21);
  assert.notEqual(r.cloudMid, 33, "the old middle cloud is gone (the same answer's hourly row stands in)");
  assert.notEqual(r.visibility, 9000, 'and the old visibility');
  assert.ok(told > afterFirst, 'the scene is told after each fetch');
  const saved = JSON.parse(store.get('le3840.weather.v2'));
  assert.equal(saved.current.cloudLow, 20, 'the saved copy is the new one');
  assert.notEqual(saved.current.visibility, 9000);
  // WeatherAPI turned off in the app: nothing of it stays
  const w = newWeather(async () => ok({ cloud_cover_low: 5 }), { refreshMinutes: 100 }).weather;
  w.setWeatherApi(WAPI_1118(Date.now()));
  w.start(23.7, 90.4);
  await sleep(30);
  w.stop();
  assert.equal(w.current().wapiText, 'Smoky haze');
  assert.equal(w.setWeatherApi(null), true);
  const gone = w.current();
  assert.equal(gone.wapi, undefined);
  assert.equal(gone.wapiText, undefined);
  assert.equal(gone.cloudLow, 5);
  assert.equal(gone.pm25, undefined);
  assert.ok(readSrc('services/weather.js').includes("const res = await fetch(this.url(), { signal: ctrl.signal, cache: 'no-store' });"), 'never an old copy from the browser cache');
});

test("the still under a resized or reset scene is the one for the sun now, as the Windows app's", () => {
  const h = load(['services/astronomy.js']);
  const A = h.LE.astronomy;
  // Dhaka, 2026-11-22 (UTC+6): the bands of WindowsBackground.StillFor in host/LivingEarthHost.cs
  const at = (hm) => A.stillFor(new Date(`2026-11-22T${hm}:00+06:00`), 23.7104, 90.4074);
  assert.equal(at('03:00'), 'night');
  assert.equal(at('06:00'), 'dawn');
  assert.equal(at('07:00'), 'morning');
  assert.equal(at('12:00'), 'day');
  assert.equal(at('16:00'), 'golden');
  assert.equal(at('17:30'), 'dusk');
  assert.equal(at('19:00'), 'night');
  const main = readSrc('main.js');
  assert.ok(main.includes('const still = LE.astronomy.stillFor(LE.clock.now(), location.lat, location.lon);'), 'the veil shows it');
  // and the app changes the Windows background only while nobody can see the desktop
  const cs = readFileSync(new URL('../host/LivingEarthHost.cs', import.meta.url), 'utf8');
  assert.ok(cs.includes('if (attached && !background.Shows(still) && !DesktopHidden())'), 'it waits while the scene is up and the desktop shows');
  assert.ok(cs.includes('if (!attached && backgroundWaiting != null) UpdateBackground(now);'), 'and goes up before the scene starts again');
});

test('a far car is a small point of light, not a flare: the glow and its patch shrink with distance', () => {
  const { LE } = testLife(22);
  const G = LE.Life.headGlow;
  const at1 = G(1, 1, 1);
  const at3 = G(3, 1, 1);
  const at8 = G(8, 1, 1);
  assert.ok(at1.fall === 1 && at3.fall < at1.fall && at8.fall < at3.fall && at8.fall >= 0.15, 'dimmer further off');
  assert.ok(at1.near === 1 && at3.near < 1 && at8.near === 0.25, 'and smaller');
  // the patch a glow needs, as _pushVehicle makes it room: main beam at 8 km is no bigger than dipped at 1 km
  const room = (g) => Math.max((12 + 8 * g.glare) * g.near, 3);
  assert.ok(room(G(8, 1, 1)) <= room(G(1, 1, 0)), 'main beam 8 km off against dipped 1 km off');
  assert.ok(room(G(1, 1, 1)) > room(G(3, 1, 1)) && room(G(3, 1, 1)) > room(G(8, 1, 1)));
  // the dazzle of main beam only when it points almost straight at the eye; a flash always
  assert.equal(G(1, 0.8, 1).glare, 0);
  assert.equal(G(1, 0.99, 1).glare, 1);
  assert.equal(G(1, 0.8, 1, 1).glare, 1);
  // in the shader the halo shrinks the same way
  const sp = readSrc('engine/shaders/sprites.js');
  assert.ok(sp.includes('float near = clamp(1.5 / dist, 0.25, 1.0);') && sp.includes('float halo = mix(12.0, 28.0, beam) * near * near;'));
  assert.ok(readSrc('engine/shaders/composite.js').includes('vec3 led = vec3(0.92, 0.95, 1.0) * 0.6;'), 'a white LED window no brighter than a warm one');
});

// ---------------------------------------------------------------- a quick start: the shaders from the cache
// 2026-11-24 the user waited ~13 minutes on "Preparing the renderer" at every start: "if same version cache should
// stay for next start faster if new version then cache should be new and also mention in making wallpaper live new
// version found it will take much time than before"
test('while the shaders compile the start screen counts them, and the times of each are kept', () => {
  const h = load(RENDER_FILES);
  const r = new h.LE.Renderer({}, h.LE.config);
  let left = { bake: 3, volume: 2, sky: 0, fade: 1 }; // polls until each one is done
  r.prog = {};
  const finalized = [];
  for (const k of Object.keys(left)) r.prog[k] = { ready: () => left[k] <= 0, finalize: () => finalized.push(k) };
  r._makeNoise = () => {};
  r._compileT0 = Date.now();
  r.status = 'compiling';
  const seen = [];
  r.onStatus = (s, p) => seen.push([s, p]);
  let compiled = null;
  r.onCompiled = (times, ms) => (compiled = { times, ms });
  for (let i = 0; i < 6 && !r._pollCompile(); i++) for (const k in left) left[k]--;
  assert.ok(r._compiled && compiled, 'done');
  assert.deepEqual(seen.map(([s]) => s), seen.map(() => 'compiling'));
  const ps = seen.map(([, p]) => p);
  assert.ok(ps.length >= 2 && ps.every((p, i) => !i || p > ps[i - 1]) && ps[ps.length - 1] < 1, 'a count that keeps moving: ' + ps);
  assert.equal(r.compileDone, 4);
  assert.equal(r.compileTotal, 4);
  assert.deepEqual(Object.keys(compiled.times).sort(), ['bake', 'fade', 'sky', 'volume']);
  assert.ok(compiled.times.sky <= compiled.times.fade && compiled.times.fade <= compiled.times.volume && compiled.times.volume <= compiled.times.bake, 'in the order they were done');
  assert.deepEqual(finalized.sort(), ['bake', 'fade', 'sky', 'volume'], 'all checked once every one is done');
  assert.ok(r._pollCompile(), 'and stays done');
});

test('the first start of a new version says it takes longer; a start of the same version just counts', () => {
  const main = readSrc('main.js');
  const src = main.slice(main.indexOf('  function compileText('), main.indexOf('  LE.compileText = compileText;'));
  const compileText = vm.runInNewContext(src + '; compileText', {});
  const upd = compileText(7, 21, 'update', 5000, '2.9.0');
  assert.equal(upd, 'New version 2.9.0 found: this first start takes longer, up to 15 min. Later starts are much quicker. 7 of 21');
  assert.equal(compileText(7, 21, 'fresh', 5000, '2.9.0'), 'First start: preparing it for this PC, up to 15 min. Later starts are much quicker. 7 of 21');
  assert.equal(compileText(7, 21, null, 5000, '2.9.0'), 'Preparing the renderer… 7 of 21');
  assert.equal(compileText(7, 21, null, 61000, '2.9.0'), 'Preparing the renderer… 7 of 21, this can take a few minutes', 'a slow start of the same version never says "new version"');
  assert.ok(upd.length <= 110, 'one line on the small panel: ' + upd.length);
  // the Windows app says which start it is; Lively and a browser compare with the version that last went live
  for (const [q, want] of [['?host=1&firststart=update', 'update'], ['?host=1&firststart=fresh', 'fresh'], ['?host=1', null], ['?firststart=nonsense', null]]) {
    const c = load(['config.js'], { search: q }).LE.config;
    assert.equal(c.firstStart, want, q);
    assert.equal(c.hosted, q.includes('host=1'), q);
  }
  assert.ok(main.includes("const firstStart = cfg.firstStart || (!cfg.hosted && LE.storage.get(LIVE_KEY, cfg.version) !== cfg.version ? 'update' : null);"));
  assert.ok(main.includes("if (!cfg.hosted) LE.storage.set(LIVE_KEY, cfg.version);"), 'noted when it goes live');
  // the page tells the Windows app, through its title, how long the shaders took and when it is live (host.log)
  assert.ok(main.includes("if (cfg.hosted) document.title = 'LE ' + compiledNote;") && main.includes("if (cfg.hosted) document.title = 'LE ready ' + cfg.version + (compiledNote ? '; ' + compiledNote : '');"), 'only for the Windows app');
  const host = readFileSync(new URL('../host/LivingEarthHost.cs', import.meta.url), 'utf8');
  assert.ok(host.includes('string firstStart = saveSettings ? PrepareShaderCache(dataDir, AboutForm.VersionText, Log) : null;') && host.includes('if (firstStart != null) url += "&firststart=" + firstStart;'));
  assert.ok(host.includes('internal static readonly string[] ShaderCacheDirs = { @"Default\\GPUCache", "ShaderCache", "GrShaderCache", "GPUPersistentCache" };'));
  assert.ok(host.includes('StopEdge(true, handover ? 2000 : CleanCloseMs);') && host.includes('Native.PostMessage(wallpaper, Native.WM_CLOSE, IntPtr.Zero, IntPtr.Zero);'), 'Edge is asked to close before it is ended');
  // the cause: Edge's own kiosk (--edge-kiosk-type=fullscreen) is InPrivate and kept nothing; plain --kiosk keeps the
  // profile (start-probe.mjs, 2026-11-26: what the page stored was gone at the next start only with the kiosk type)
  assert.ok(host.includes(`cmd.Append(" --kiosk \\"").Append(url).Append('"');`) && !/cmd\.Append\([^)]*--edge-kiosk-type/.test(host), 'not InPrivate');
});
