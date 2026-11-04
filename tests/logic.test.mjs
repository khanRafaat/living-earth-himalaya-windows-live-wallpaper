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
