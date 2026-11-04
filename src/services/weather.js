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
     * Best real weather for "now" (real clock), or null.
     * Adds: source ('live' | 'recent' | 'forecast'), ageMs.
     */
    current(nowMs = Date.now()) {
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
