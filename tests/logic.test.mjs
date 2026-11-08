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

test('with the same weather data the sky is the same at dawn and at noon', () => {
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
  for (const k of Object.keys(noon)) assert.equal(dawn[k], noon[k], k);
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
  const state = { time: 5, treeDir: [1, 0], treeKmh: 0, windAmt: 0 };
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
  near(panelWeather('clear', { visibility: 800 }).w.fog, 0.7, 1e-9, 'fog');
  near(panelWeather('clear', { visibility: 2000 }).w.fog, 0.3, 1e-9, 'thin fog');
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

function testLife(hour = 12, over = {}) {
  const { LE } = load(['engine/road.js', 'engine/life.js']);
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
  return { LE, life, road, state, view };
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
  assert.ok(life.includes('const lamp = lampOn * R.headlight(facing);'), 'the same call for all kinds');
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
  for (const kind of ['bus', 'jeep', 'motorcycle']) {
    const at = (i, dir) => {
      life.count = 0;
      life._pushVehicle(life._newVehicle(kind, dir, i * road.step), 1);
      const v = sprites(life).find((x) => x.type === 6);
      assert.ok(v, kind + ' is in view');
      return v;
    };
    assert.ok(at(toward, 1).f[14] > 0.5, kind + ' heading towards the viewer shows its light');
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
    assert.ok(a.v <= road.limit[i] + 0.002, `no faster than the bend allows: ${a.v} at ${road.limit[i]}`);
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
  morning.life._nextFire = 1e9;
  morning.run(200);
  const midMorning = morning.kinds()[0] || 0;
  assert.ok(midMorning >= 1, 'some smoke outside cooking times too: ' + midMorning);
  const cooking = hills(18, { mist: 0.2 });
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
      assert.ok(r > 0.01 && r <= 0.1 && amt > 0 && H > 0.03, 'a column: ' + [r, amt, H]);
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
  for (const k of ['mist', 'smoke', 'fires', 'lights', 'shootingStars', 'road', 'birds', 'leaves']) assert.equal(on[k], true, k + ' on to start with');
  assert.equal(on.render.tree, true);
  assert.equal(on.ui.showPanel, true);
  const off = load(['config.js'], { search: '?mist=0&smoke=0&fires=0&lights=0&stars=0&tree=0&panel=0' }).LE.config;
  for (const k of ['mist', 'smoke', 'fires', 'lights', 'shootingStars']) assert.equal(off[k], false, k + ' off from the address');
  assert.equal(off.render.tree, false);
  assert.equal(off.ui.showPanel, false);

  // from the app: each switch passed on once, on a change, under Lively's name for it
  const a = load(['config.js', 'services/host.js'], { search: '?host=1' });
  a.ctx.document.createElement = () => ({ remove() {} });
  a.ctx.document.head = { appendChild: (x) => x.onload() };
  const calls = [];
  a.ctx.livelyPropertyListener = (name, v) => calls.push([name, v]);
  const all = {
    quality: 'auto', road: true, traffic: 'normal', birds: true, leaves: true, tree: true, mist: true, smoke: true, fires: true,
    lights: true, stars: true, panel: true, corner: 'right-bottom', panelSize: 'medium',
  };
  a.ctx.leHostState('live', all);
  a.tick();
  assert.deepEqual(calls, []);
  a.ctx.leHostState('live', { ...all, tree: false, mist: false, smoke: false, fires: false, lights: false, stars: false, panel: false });
  a.tick();
  const names = calls.map((c) => c[0]).sort();
  assert.deepEqual(names, ['fires', 'lights', 'mist', 'showPanel', 'smoke', 'stars', 'tree']);
  assert.ok(calls.every((c) => c[1] === false));

  // Lively offers each one, on to start with, and the page knows each name
  const read = (f) => readFileSync(new URL(f, new URL('../', import.meta.url)), 'utf8');
  const lively = JSON.parse(read('LivelyProperties.json'));
  const main = read('src/main.js');
  for (const k of ['tree', 'mist', 'smoke', 'fires', 'lights', 'stars', 'birds', 'leaves', 'road', 'showPanel']) {
    assert.equal(lively[k] && lively[k].type, 'checkbox', 'Lively has ' + k);
    assert.equal(lively[k].value, true, k + ' on in Lively');
    assert.ok(main.includes(`case '${k}':`), 'main.js handles ' + k);
  }
  // the app keeps each one, and passes it to the page at start and while running
  const cs = read('host/LivingEarthHost.cs');
  for (const k of ['tree', 'mist', 'smoke', 'fires', 'lights', 'stars', 'panel']) {
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

test('a busy day on the road: nothing ever drives through anything, and overtaking and stops happen', () => {
  const { life, state, view } = testLife(12);
  let passes = 0;
  let stops = 0;
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
