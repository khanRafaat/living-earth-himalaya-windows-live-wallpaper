/*
 * Weather service — Open-Meteo (free, no API key).
 *
 *  • Fetches current conditions + a 48 h hourly forecast every 15 minutes.
 *  • Caches the last good response in localStorage, so a restart never needs the network.
 *  • Offline: keeps using the cached "current" for a while, then the cached hourly
 *    forecast for the present hour (clearly labelled), and finally reports "no data".
 *  • Failed requests back off (2 → 4 → 8 … 30 min). Coming back online triggers a refresh.
 *
 * It never invents weather: when nothing real is available, current() returns null.
 */
(function () {
  'use strict';
  const LE = (window.LE = window.LE || {});
  const KEY = 'le3840.weather.v2';
  const API = 'https://api.open-meteo.com/v1/forecast';

  // Winds at cloud height: 850 hPa ≈ 1.5 km (low cloud), 700 hPa ≈ 3 km (mid), 300 hPa ≈ 9 km (cirrus)
  const UPPER_WIND_VARS = [
    'wind_speed_850hPa',
    'wind_direction_850hPa',
    'wind_speed_700hPa',
    'wind_direction_700hPa',
    'wind_speed_300hPa',
    'wind_direction_300hPa',
  ];
  const CURRENT_VARS = [
    'temperature_2m',
    'relative_humidity_2m',
    'apparent_temperature',
    'is_day',
    'precipitation',
    'rain',
    'showers',
    'snowfall',
    'weather_code',
    'cloud_cover',
    'cloud_cover_low',
    'cloud_cover_mid',
    'cloud_cover_high',
    'visibility',
    'wind_speed_10m',
    'wind_direction_10m',
    'wind_gusts_10m',
    ...UPPER_WIND_VARS,
  ];
  const HOURLY_VARS = [
    'temperature_2m',
    'relative_humidity_2m',
    'precipitation',
    'snowfall',
    'weather_code',
    'cloud_cover',
    'cloud_cover_low',
    'cloud_cover_mid',
    'cloud_cover_high',
    'visibility',
    'wind_speed_10m',
    'wind_direction_10m',
    'wind_gusts_10m',
    ...UPPER_WIND_VARS,
  ];

  const finite = (v, f = null) => (typeof v === 'number' && isFinite(v) ? v : f);

  function hourlyRecord(h, i) {
    if (!h || !h.time || i < 0 || i >= h.time.length) return null;
    const g = (k) => (h[k] ? finite(h[k][i]) : null);
    return {
      time: h.time[i] * 1000,
      temp: g('temperature_2m'),
      humidity: g('relative_humidity_2m'),
      precip: g('precipitation') || 0,
      snowfall: g('snowfall') || 0,
      code: g('weather_code'),
      cloud: g('cloud_cover'),
      cloudLow: g('cloud_cover_low'),
      cloudMid: g('cloud_cover_mid'),
      cloudHigh: g('cloud_cover_high'),
      visibility: g('visibility'),
      windSpeed: g('wind_speed_10m'),
      windDir: g('wind_direction_10m'),
      gusts: g('wind_gusts_10m'),
      wind850: g('wind_speed_850hPa'),
      dir850: g('wind_direction_850hPa'),
      wind700: g('wind_speed_700hPa'),
      dir700: g('wind_direction_700hPa'),
      wind300: g('wind_speed_300hPa'),
      dir300: g('wind_direction_300hPa'),
    };
  }

  function nearestHourIndex(h, ms) {
    if (!h || !h.time || !h.time.length) return -1;
    let best = -1;
    let bestD = Infinity;
    for (let i = 0; i < h.time.length; i++) {
      const d = Math.abs(h.time[i] * 1000 - ms);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return bestD <= 90 * 60e3 ? best : -1;
  }

  function parse(json) {
    if (!json || typeof json !== 'object' || !json.current || !json.hourly) throw new Error('Unexpected response');
    const c = json.current;
    const code = finite(c.weather_code);
    if (code === null) throw new Error('Missing weather code');
    const currentMs = finite(c.time, Date.now() / 1000) * 1000;
    const hIdx = nearestHourIndex(json.hourly, currentMs);
    const hr = hourlyRecord(json.hourly, hIdx) || {};
    const current = {
      time: currentMs,
      temp: finite(c.temperature_2m),
      feelsLike: finite(c.apparent_temperature),
      humidity: finite(c.relative_humidity_2m, hr.humidity),
      isDay: finite(c.is_day),
      precip: finite(c.precipitation, 0),
      rain: (finite(c.rain, 0) || 0) + (finite(c.showers, 0) || 0),
      snowfall: finite(c.snowfall, 0),
      code,
      cloud: finite(c.cloud_cover, hr.cloud),
      cloudLow: finite(c.cloud_cover_low, hr.cloudLow),
      cloudMid: finite(c.cloud_cover_mid, hr.cloudMid),
      cloudHigh: finite(c.cloud_cover_high, hr.cloudHigh),
      visibility: finite(c.visibility, hr.visibility),
      windSpeed: finite(c.wind_speed_10m, hr.windSpeed),
      windDir: finite(c.wind_direction_10m, hr.windDir),
      gusts: finite(c.wind_gusts_10m, hr.gusts),
      wind850: finite(c.wind_speed_850hPa, hr.wind850),
      dir850: finite(c.wind_direction_850hPa, hr.dir850),
      wind700: finite(c.wind_speed_700hPa, hr.wind700),
      dir700: finite(c.wind_direction_700hPa, hr.dir700),
      wind300: finite(c.wind_speed_300hPa, hr.wind300),
      dir300: finite(c.wind_direction_300hPa, hr.dir300),
    };
    const daily = json.daily || {};
    return {
      current,
      hourly: json.hourly,
      daily: {
        time: daily.time || [],
        sunrise: daily.sunrise || [],
        sunset: daily.sunset || [],
      },
      timezone: json.timezone || '',
    };
  }

  class WeatherService {
    constructor(cfg) {
      this.cfg = cfg;
      this.data = null;
      this.status = 'idle'; // idle | loading | live | error | offline
      this.lastError = null;
      this.failures = 0;
      this.timer = null;
      this._request = null; // the request in flight, if any
      this._nextAt = 0; // wall-clock time of the next planned fetch
      this.listeners = new Set();
      this._onOnline = () => {
        if (this.ageMs() > 5 * 60e3) this._schedule(1500);
      };
      this._onVisible = () => {
        if (!document.hidden && this.ageMs() > this.cfg.refreshMinutes * 60e3) this._schedule(1500);
      };
    }

    onUpdate(fn) {
      this.listeners.add(fn);
      return () => this.listeners.delete(fn);
    }

    /** fresh: drop the saved forecast, so the only weather used is what the API says now. */
    start(lat, lon, fresh = false) {
      this.stop();
      this.lat = lat;
      this.lon = lon;
      // the previous location's weather must not stay on screen while this one loads
      this.data = null;
      this.status = 'idle';
      this.failures = 0;
      this.lastError = null;
      if (fresh) LE.storage.remove(KEY);
      const cache = LE.storage.get(KEY);
      if (cache && Math.abs(cache.lat - lat) < 0.1 && Math.abs(cache.lon - lon) < 0.1 && cache.current) {
        this.data = cache;
        this.status = 'cached';
      }
      const refreshMs = this.cfg.refreshMinutes * 60e3;
      const age = this.ageMs();
      this._schedule(age >= refreshMs ? 0 : refreshMs - age);
      window.addEventListener('online', this._onOnline);
      document.addEventListener('visibilitychange', this._onVisible);
      this._tick = setInterval(() => {
        // Timers can stop while the PC sleeps, so check the wall clock for an overdue fetch
        if (!this._request && Date.now() >= this._nextAt) this._schedule(0);
        // also re-evaluates the live → forecast fallback
        this._emit();
      }, 60e3);
      this._emit();
    }

    stop() {
      clearTimeout(this.timer);
      clearInterval(this._tick);
      if (this._request) {
        this._request.abort();
        this._request = null;
      }
      window.removeEventListener('online', this._onOnline);
      document.removeEventListener('visibilitychange', this._onVisible);
    }

    refreshNow() {
      this.failures = 0;
      this._schedule(0);
    }

    ageMs() {
      return this.data ? Math.max(0, Date.now() - this.data.fetchedAt) : Infinity;
    }

    url() {
      const p = new URLSearchParams({
        latitude: this.lat.toFixed(4),
        longitude: this.lon.toFixed(4),
        current: CURRENT_VARS.join(','),
        hourly: HOURLY_VARS.join(','),
        daily: 'sunrise,sunset',
        timezone: 'auto',
        timeformat: 'unixtime',
        forecast_days: '3',
        wind_speed_unit: 'kmh',
      });
      return `${API}?${p.toString()}`;
    }

    _schedule(ms) {
      clearTimeout(this.timer);
      this._nextAt = Date.now() + Math.max(0, ms);
      this.timer = setTimeout(() => this._fetch(), Math.max(0, ms));
    }

    _retryDelay() {
      const m = Math.min(this.cfg.retryMinMinutes * Math.pow(2, Math.max(0, this.failures - 1)), this.cfg.retryMaxMinutes);
      return m * 60e3;
    }

    async _fetch() {
      if (this._request) return; // one at a time; when this one finishes it plans the next
      if (navigator.onLine === false) {
        this.status = 'offline';
        this._emit();
        this._schedule(this._retryDelay());
        return;
      }
      this.status = this.data ? this.status : 'loading';
      const ctrl = new AbortController();
      this._request = ctrl;
      const to = setTimeout(() => ctrl.abort(), this.cfg.requestTimeoutMs);
      try {
        const res = await fetch(this.url(), { signal: ctrl.signal, cache: 'no-store' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const parsed = parse(await res.json());
        if (this._request !== ctrl) return; // the location changed while this was loading
        this.data = Object.assign({ lat: this.lat, lon: this.lon, fetchedAt: Date.now() }, parsed);
        LE.storage.set(KEY, this.data);
        this.failures = 0;
        this.status = 'live';
        this.lastError = null;
        this._schedule(this.cfg.refreshMinutes * 60e3);
      } catch (err) {
        if (this._request !== ctrl) return;
        this.failures++;
        this.lastError = err && err.name === 'AbortError' ? 'timeout' : (err && err.message) || 'error';
        this.status = navigator.onLine === false ? 'offline' : 'error';
        this._schedule(this._retryDelay());
      } finally {
        clearTimeout(to);
        if (this._request === ctrl) {
          this._request = null;
          this._emit();
        }
      }
    }

    /**
     * The nearest airport's report, handed over by the Windows app (host.js), or null. Returns whether it changed.
     * { id, name, km, t (ms), temp, dewp (°C), vis (m), wx (METAR weather, e.g. "BR" or "-RA BR") }
     */
    setObservation(obs) {
      const ok = obs && typeof obs === 'object' && typeof obs.t === 'number' && typeof obs.km === 'number' && isFinite(obs.t + obs.km);
      const key = ok ? JSON.stringify(obs) : '';
      if (key === (this._obsKey || '')) return false;
      this._obsKey = key;
      this.obs = ok ? obs : null;
      return true;
    }

    /**
     * WeatherAPI.com's weather now, when it is the source chosen in the Windows app, which fetches it with the user's
     * own key (host.js), or null. Returns whether it changed.
     * { t (ms), code (WeatherAPI's), text, cloud (%), vis (m), temp, dewp (°C), hum (%), wind (km/h), dir, gust, precip (mm),
     *   pm25, pm10 (µg/m³), aqi (US EPA index, 1 good to 6 hazardous) }
     */
    setWeatherApi(w) {
      const ok = w && typeof w === 'object' && typeof w.t === 'number' && isFinite(w.t);
      const key = ok ? JSON.stringify(w) : '';
      if (key === (this._wapiKey || '')) return false;
      this._wapiKey = key;
      this.wapi = ok ? w : null;
      return true;
    }

    /**
     * Best real weather for "now" (real clock), or null.
     * Adds: source ('live' | 'recent' | 'forecast'), ageMs. Over it: the ground weather from WeatherAPI.com when chosen
     * (LE.withWeatherApi), then what a recent airport report near by saw (LE.withObservation), which wins.
     */
    current(nowMs = Date.now()) {
      return LE.withObservation(LE.withWeatherApi(this._current(nowMs), this.wapi, nowMs), this.obs, nowMs);
    }

    _current(nowMs) {
      if (!this.data || !this.data.current) return null;
      const age = Math.max(0, nowMs - this.data.fetchedAt);
      const refreshMs = this.cfg.refreshMinutes * 60e3;
      if (age < this.cfg.staleAfterMinutes * 60e3) {
        return Object.assign({}, this.data.current, {
          source: age < refreshMs * 1.6 ? 'live' : 'recent',
          ageMs: age,
        });
      }
      if (age < this.cfg.forecastHorizonHours * 3600e3) {
        const i = nearestHourIndex(this.data.hourly, nowMs);
        const rec = hourlyRecord(this.data.hourly, i);
        if (rec && rec.code !== null) {
          return Object.assign(rec, { rain: rec.precip, source: 'forecast', ageMs: age });
        }
      }
      return null;
    }

    _emit() {
      for (const fn of this.listeners) {
        try {
          fn(this);
        } catch (e) {
          console.error(e);
        }
      }
    }
  }

  LE.WeatherService = WeatherService;

  /** Relative humidity (%) from the temperature and the dew point (°C), by the Magnus formula. */
  const humidityFrom = (t, td) => Math.min(100, (100 * Math.exp((17.625 * td) / (243.04 + td))) / Math.exp((17.625 * t) / (243.04 + t)));

  /**
   * What an airport near by actually saw, laid over the forecast: its visibility, temperature, humidity and any mist,
   * fog, haze, smoke or dust. Forecast models miss these: on 2026-11-18 at 09:00 Dhaka airport reported mist and
   * 1 km, the forecast 7.1 km and "overcast" (all of it thin high cloud). Only a report under 100 minutes old and from
   * within 60 km counts. Cloud stays with the forecast, and so do rain and snow, except where a close airport saw
   * none fall in the last hour: then it is dry. On 2026-11-22 at 14:30 WeatherAPI said "Patchy rain nearby" for
   * Uttara and the scene rained; Dhaka airport, 2.3 km away, saw haze and nothing falling.
   */
  const DRY_KM = 15; // a shower that misses an airport this close most likely misses here too
  const DRY_MINUTES = 60; // older than that, rain may have begun since
  const FALLING = ['DZ', 'RA', 'SN', 'SG', 'IC', 'PL', 'GR', 'GS', 'UP']; // METAR's drizzle, rain, snow, ice, hail, unknown
  LE.withObservation = function (rec, obs, nowMs = Date.now()) {
    if (!rec || !obs) return rec;
    const age = nowMs - obs.t;
    if (!(age > -15 * 60e3 && age < 100 * 60e3) || !(obs.km <= 60)) return rec;
    const out = Object.assign({}, rec);
    const num = (v) => typeof v === 'number' && isFinite(v); // a report may lack any of them (null)
    // a report says 9999 m (or "10+" miles) for anything clearer, so a larger forecast value stands
    if (num(obs.vis) && obs.vis > 0) out.visibility = obs.vis >= 9999 ? Math.max(rec.visibility ?? 10000, 10000) : obs.vis;
    if (num(obs.temp)) out.temp = obs.temp;
    if (num(obs.temp) && num(obs.dewp)) out.humidity = Math.round(humidityFrom(obs.temp, obs.dewp));
    // METAR weather groups: intensity (- +), VC (near by, not here), a descriptor (MI shallow, BC patches, PR partial,
    // FZ freezing ...), then two-letter phenomena
    const seen = new Set();
    let thin = false;
    let thunder = false;
    for (let g of String(obs.wx || '').toUpperCase().split(/\s+/)) {
      g = g.replace(/^[-+]/, '');
      if (!g || g.startsWith('VC')) continue;
      const d = /^(MI|BC|PR|DR|BL|SH|TS|FZ)/.exec(g);
      if (d && d[1] === 'TS') thunder = true; // a storm over the airport, rain or not
      if (d) g = g.slice(2);
      for (let i = 0; i + 1 < g.length; i += 2) {
        const p = g.slice(i, i + 2);
        seen.add(p);
        if (p === 'FG' && d && /MI|BC|PR/.test(d[1])) thin = true;
      }
    }
    // nothing falling at a close airport just now: no rain or snow here, whatever the forecast or WeatherAPI said
    const wasFalling = (rec.code ?? 0) >= 50 || rec.precip > 0 || rec.rain > 0 || rec.snowfall > 0;
    if (wasFalling && obs.km <= DRY_KM && age < DRY_MINUTES * 60e3 && !thunder && !FALLING.some((p) => seen.has(p))) {
      for (const k of ['precip', 'rain', 'snowfall']) if (out[k]) out[k] = 0;
      if ((rec.code ?? 0) >= 50) {
        out.code = codeFromCloud(rec.cloud);
        delete out.wapiText; // its words said rain
      }
    }
    // its words for the sky give way to what the airport saw, whenever it saw something in the air or WeatherAPI did
    if (seen.size || rec.obscured || rec.code === 45 || rec.code === 48) delete out.wapiText;
    if (seen.has('FG') && !thin) {
      out.obscured = 'fog';
      if ((out.code ?? 0) <= 3) out.code = 45;
    } else {
      // What it saw stands over what a forecast or WeatherAPI guessed: no fog there, no fog here
      if (rec.code === 45 || rec.code === 48) out.code = codeFromCloud(rec.cloud);
      if (seen.has('FG') || seen.has('BR')) out.obscured = 'mist';
      else if (seen.has('FU')) out.obscured = 'smoke';
      else if (seen.has('HZ')) out.obscured = 'haze';
      else if (seen.has('DU') || seen.has('SA')) out.obscured = 'dust';
      else delete out.obscured;
    }
    out.obs = { id: String(obs.id || '').slice(0, 8), t: obs.t };
    return out;
  };

  /** The weather code for a sky with this much cloud (%) and nothing falling. */
  const codeFromCloud = (c) => (c == null ? 2 : c >= 88 ? 3 : c >= 50 ? 2 : c >= 15 ? 1 : 0);

  /**
   * WeatherAPI.com's condition codes as the weather codes (WMO, as Open-Meteo's) the scene uses, or what they hide
   * the view with. Its "possible" and "nearby" codes (1063-1087) mean nothing is falling here: the sky as its cloud
   * says. Sleet falls as wet snow.
   */
  const WAPI_CODES = {
    1000: 0, 1003: 2, 1006: 3, 1009: 3, 1030: 'mist', 1036: 'haze', 1135: 45, 1147: 48,
    1063: null, 1066: null, 1069: null, 1072: null, 1087: null,
    1114: 73, 1117: 75, 1150: 51, 1153: 51, 1168: 56, 1171: 57,
    1180: 61, 1183: 61, 1186: 63, 1189: 63, 1192: 65, 1195: 65, 1198: 66, 1201: 67,
    1204: 71, 1207: 73, 1210: 71, 1213: 71, 1216: 73, 1219: 73, 1222: 75, 1225: 75,
    1237: 77, 1240: 80, 1243: 81, 1246: 82, 1249: 85, 1252: 86, 1255: 85, 1258: 86, 1261: 77, 1264: 77,
    1273: 95, 1276: 95, 1279: 95, 1282: 95,
  };
  LE.WAPI_CODES = WAPI_CODES;
  const WAPI_TRACE_MM = 0.1;

  /**
   * WeatherAPI.com's weather at the ground, laid over the forecast: temperature, humidity, wind, rain, visibility,
   * what the sky is doing and how much cloud. Only while under an hour old. Its total cloud rescales the forecast's
   * low, middle and high cloud in their own proportions, so the clouds keep their heights and move with the real
   * winds up there, which WeatherAPI does not give. With no forecast at all it stands alone.
   */
  LE.withWeatherApi = function (rec, w, nowMs = Date.now()) {
    if (!w) return rec;
    const age = nowMs - w.t;
    if (!(age > -15 * 60e3 && age < 60 * 60e3)) return rec;
    const num = (v) => typeof v === 'number' && isFinite(v);
    const out = Object.assign(rec ? {} : { source: 'live', ageMs: Math.max(0, age) }, rec);
    if (num(w.temp)) out.temp = w.temp;
    if (num(w.hum)) out.humidity = w.hum;
    else if (num(w.temp) && num(w.dewp)) out.humidity = Math.round(humidityFrom(w.temp, w.dewp));
    if (num(w.wind)) out.windSpeed = w.wind;
    if (num(w.dir)) out.windDir = w.dir;
    if (num(w.gust)) out.gusts = Math.max(w.gust, out.windSpeed ?? 0);
    const m = WAPI_CODES[w.code];
    // under 0.1 mm is a trace, less than a rain gauge measures: rain only when its own words say rain falls here
    // (2026-11-22, Uttara: "Patchy rain nearby" with 0.08 mm, a dry hazy afternoon, drew rain)
    const trace = num(w.precip) && w.precip < WAPI_TRACE_MM && !(typeof m === 'number' && m >= 50);
    if (num(w.precip)) out.precip = out.rain = trace ? 0 : w.precip;
    // it gives 10 km for anything clearer, so a larger forecast value stands
    if (num(w.vis) && w.vis > 0) out.visibility = w.vis >= 10000 ? Math.max(rec?.visibility ?? 10000, 10000) : w.vis;
    if (num(w.cloud)) {
      const c = Math.min(Math.max(w.cloud, 0), 100);
      const total = rec?.cloud;
      if (rec && num(total) && total >= 5 && num(rec.cloudLow) && num(rec.cloudMid)) {
        const k = c / total;
        out.cloudLow = Math.min(100, rec.cloudLow * k);
        out.cloudMid = Math.min(100, rec.cloudMid * k);
        if (num(rec.cloudHigh)) out.cloudHigh = Math.min(100, rec.cloudHigh * k);
      } else {
        // no layers to share it out by: the total alone
        out.cloudLow = out.cloudMid = null;
      }
      out.cloud = c;
    }
    // the air: fine particles make the smog that lies in the valleys (environment.js)
    if (num(w.pm25) && w.pm25 >= 0) out.pm25 = w.pm25;
    if (num(w.pm10) && w.pm10 >= 0) out.pm10 = w.pm10;
    if (num(w.aqi) && w.aqi >= 1 && w.aqi <= 6) out.aqi = Math.round(w.aqi);
    // and its own words for the sky, which say more than a weather code ("Smoky haze", "Patchy rain nearby")
    if (typeof w.text === 'string' && w.text.trim()) out.wapiText = w.text.trim().slice(0, 40);
    delete out.obscured;
    if (typeof m === 'number') out.code = m;
    else {
      // mist, haze, or "rain possible": the sky as its cloud says, light rain if more than a trace falls all the same
      out.code = num(w.precip) && !trace && w.precip > 0 ? 61 : codeFromCloud(out.cloud);
      if (typeof m === 'string') out.obscured = m;
      if (m === undefined && rec && rec.code != null) out.code = rec.code; // a code it added since: the forecast's
    }
    out.wapi = { t: w.t };
    return out;
  };

  /** The words for the weather now: the airport's mist or haze when it saw some, and thin high cloud as such. */
  LE.weatherLabel = function (rec) {
    if (!rec) return 'Unknown';
    if (rec.wapiText) return rec.wapiText;
    const c = rec.code;
    const ob = { mist: 'Mist', haze: 'Haze', smoke: 'Smoke', dust: 'Dust' }[rec.obscured];
    if (ob && (c == null || c <= 3)) return ob;
    if (c === 3 && rec.cloudLow != null && rec.cloudMid != null) {
      const deck = 1 - (1 - Math.min(Math.max(rec.cloudLow, 0), 100) / 100) * (1 - Math.min(Math.max(rec.cloudMid, 0), 100) / 100);
      if (deck < 0.2) return 'High cloud';
    }
    return LE.weatherText(c);
  };

  /** How the air is, from the US EPA index WeatherAPI.com gives with its weather, or ''. */
  LE.airText = function (rec) {
    const i = rec && rec.aqi;
    return i >= 1 && i <= 6 ? 'air ' + ['good', 'moderate', 'poor', 'unhealthy', 'very unhealthy', 'hazardous'][i - 1] : '';
  };

  LE.weatherText = function (code) {
    const map = {
      0: 'Clear sky',
      1: 'Mainly clear',
      2: 'Partly cloudy',
      3: 'Overcast',
      45: 'Fog',
      48: 'Freezing fog',
      51: 'Light drizzle',
      53: 'Drizzle',
      55: 'Dense drizzle',
      56: 'Freezing drizzle',
      57: 'Freezing drizzle',
      61: 'Light rain',
      63: 'Rain',
      65: 'Heavy rain',
      66: 'Freezing rain',
      67: 'Freezing rain',
      71: 'Light snow',
      73: 'Snow',
      75: 'Heavy snow',
      77: 'Snow grains',
      80: 'Rain showers',
      81: 'Rain showers',
      82: 'Violent showers',
      85: 'Snow showers',
      86: 'Heavy snow showers',
      95: 'Thunderstorm',
      96: 'Thunderstorm, hail',
      99: 'Thunderstorm, hail',
    };
    return map[code] || 'Unknown';
  };
})();
