/*
 * Astronomy engine — sun and moon positions, rise/set times, twilight bands,
 * moon phase and local sidereal time (for a correctly rotating star field).
 * Based on the well-known SunCalc formulas (V. Agafonkin, BSD-2) with a
 * scan-and-bisect solver for event times so every threshold is handled the same way.
 * Compared with SunCalc: standard mean sidereal time, the sun's longitude of date, the moon's
 * main orbit perturbations (Meeus, Astronomical Algorithms, ch. 47) and lunar parallax.
 * Rise and set times match the US Naval Observatory to about a minute (see tests/logic.test.mjs).
 * Pure functions: no rendering code here.
 */
(function () {
  'use strict';
  const LE = (window.LE = window.LE || {});

  const PI = Math.PI;
  const rad = PI / 180;
  const deg = 180 / PI;
  const dayMs = 864e5;
  const J1970 = 2440588;
  const J2000 = 2451545;
  const e = rad * 23.4397; // obliquity of the ecliptic

  const toJulian = (date) => date.valueOf() / dayMs - 0.5 + J1970;
  const toDays = (date) => toJulian(date) - J2000;

  const rightAscension = (l, b) => Math.atan2(Math.sin(l) * Math.cos(e) - Math.tan(b) * Math.sin(e), Math.cos(l));
  const declination = (l, b) => Math.asin(Math.sin(b) * Math.cos(e) + Math.cos(b) * Math.sin(e) * Math.sin(l));
  const azimuth = (H, phi, dec) => Math.atan2(Math.sin(H), Math.cos(H) * Math.sin(phi) - Math.tan(dec) * Math.cos(phi));
  const altitude = (H, phi, dec) =>
    Math.asin(Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(H));
  const siderealTime = (d, lw) => rad * (280.46061837 + 360.98564736629 * d) - lw;

  function refraction(h) {
    // h in radians; tapers to zero 2° below the horizon so the sun never "jumps"
    const h0 = Math.max(h, 0);
    const r = 0.0002967 / Math.tan(h0 + 0.00312536 / (h0 + 0.08901179));
    return h >= 0 ? r : r * Math.max(0, 1 + h / 0.035);
  }

  const solarMeanAnomaly = (d) => rad * (357.5291 + 0.98560028 * d);
  function eclipticLongitude(M, d) {
    const C = rad * (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M));
    // the perihelion term drifts with precession, which keeps this "of date" like the sidereal time
    return M + C + rad * (102.9372 + 0.00004708 * d) + PI;
  }
  function sunCoords(d) {
    const L = eclipticLongitude(solarMeanAnomaly(d), d);
    return { dec: declination(L, 0), ra: rightAscension(L, 0) };
  }
  function moonCoords(d) {
    const L = rad * (218.316 + 13.176396 * d);
    const M = rad * (134.963 + 13.064993 * d);
    const F = rad * (93.272 + 13.22935 * d);
    const D = rad * (297.85 + 12.190749 * d); // mean elongation from the sun
    const Ms = solarMeanAnomaly(d);
    const l =
      L +
      rad *
        (6.289 * Math.sin(M) +
          1.274 * Math.sin(2 * D - M) +
          0.658 * Math.sin(2 * D) +
          0.214 * Math.sin(2 * M) -
          0.186 * Math.sin(Ms) -
          0.114 * Math.sin(2 * F));
    const b = rad * (5.128 * Math.sin(F) + 0.281 * Math.sin(M + F) + 0.278 * Math.sin(M - F) + 0.173 * Math.sin(2 * D - F));
    const dist = 385001 - 20905 * Math.cos(M) - 3699 * Math.cos(2 * D - M) - 2956 * Math.cos(2 * D) - 570 * Math.cos(2 * M);
    return { ra: rightAscension(l, b), dec: declination(l, b), dist };
  }

  // Compass azimuth (0 = north, clockwise) from SunCalc's south-based azimuth
  const compass = (az) => (((az * deg + 180) % 360) + 360) % 360;

  function sunGeometric(date, lat, lng) {
    const lw = rad * -lng;
    const phi = rad * lat;
    const d = toDays(date);
    const c = sunCoords(d);
    const H = siderealTime(d, lw) - c.ra;
    return { alt: altitude(H, phi, c.dec), az: azimuth(H, phi, c.dec) };
  }

  /** Sun position: altitude (rad, refraction applied), geometric altitude, compass azimuth (deg) */
  function sunPosition(date, lat, lng) {
    const g = sunGeometric(date, lat, lng);
    return { altitude: g.alt + refraction(g.alt), geometric: g.alt, azimuthDeg: compass(g.az) };
  }

  /** The moon as seen from the ground, before refraction. It is close enough to sit up to ~1° lower than from Earth's centre. */
  function moonGeometric(date, lat, lng) {
    const lw = rad * -lng;
    const phi = rad * lat;
    const d = toDays(date);
    const c = moonCoords(d);
    const H = siderealTime(d, lw) - c.ra;
    const centre = altitude(H, phi, c.dec);
    const alt = centre - Math.asin(Math.cos(centre) * (6378.14 / c.dist));
    return { alt, az: azimuth(H, phi, c.dec), dist: c.dist };
  }

  function moonPosition(date, lat, lng) {
    const g = moonGeometric(date, lat, lng);
    return { altitude: g.alt + refraction(g.alt), azimuthDeg: compass(g.az), distance: g.dist };
  }

  function moonIllumination(date) {
    const d = toDays(date);
    const s = sunCoords(d);
    const m = moonCoords(d);
    const sdist = 149598000;
    const phi = Math.acos(
      Math.sin(s.dec) * Math.sin(m.dec) + Math.cos(s.dec) * Math.cos(m.dec) * Math.cos(s.ra - m.ra)
    );
    const inc = Math.atan2(sdist * Math.sin(phi), m.dist - sdist * Math.cos(phi));
    const angle = Math.atan2(
      Math.cos(s.dec) * Math.sin(s.ra - m.ra),
      Math.sin(s.dec) * Math.cos(m.dec) - Math.cos(s.dec) * Math.sin(m.dec) * Math.cos(s.ra - m.ra)
    );
    return {
      fraction: (1 + Math.cos(inc)) / 2,
      phase: 0.5 + (0.5 * inc * (angle < 0 ? -1 : 1)) / PI,
    };
  }

  function moonPhaseName(phase) {
    const p = ((phase % 1) + 1) % 1;
    if (p < 0.03 || p > 0.97) return 'New moon';
    if (p < 0.22) return 'Waxing crescent';
    if (p < 0.28) return 'First quarter';
    if (p < 0.47) return 'Waxing gibbous';
    if (p < 0.53) return 'Full moon';
    if (p < 0.72) return 'Waning gibbous';
    if (p < 0.78) return 'Last quarter';
    return 'Waning crescent';
  }

  /** Local sidereal time in radians */
  function localSiderealTime(date, lng) {
    return siderealTime(toDays(date), rad * -lng);
  }

  /**
   * Event times for the local calendar day of `date`.
   * Scans the day in 5-minute steps and bisects every threshold crossing.
   */
  const _timesCache = new Map();
  function sunTimes(date, lat, lng) {
    const day = new Date(date);
    day.setHours(0, 0, 0, 0);
    const key = `${day.getTime()}|${lat.toFixed(3)}|${lng.toFixed(3)}`;
    if (_timesCache.has(key)) return _timesCache.get(key);

    const t0 = day.getTime();
    const step = 5 * 60e3;
    const n = Math.round((24 * 3600e3) / step);
    const altAt = (ms) => sunGeometric(new Date(ms), lat, lng).alt * deg;
    const samples = new Float64Array(n + 1);
    let noonIdx = 0;
    for (let i = 0; i <= n; i++) {
      samples[i] = altAt(t0 + i * step);
      if (samples[i] > samples[noonIdx]) noonIdx = i;
    }
    // refine solar noon
    let a = t0 + Math.max(0, noonIdx - 1) * step;
    let b = t0 + Math.min(n, noonIdx + 1) * step;
    for (let k = 0; k < 30; k++) {
      const m1 = a + (b - a) / 3;
      const m2 = b - (b - a) / 3;
      if (altAt(m1) < altAt(m2)) a = m1;
      else b = m2;
    }
    const solarNoon = new Date((a + b) / 2);

    const crossing = (thr, rising) => {
      const from = rising ? 0 : noonIdx;
      const to = rising ? noonIdx : n;
      for (let i = from; i < to; i++) {
        const y0 = samples[i] - thr;
        const y1 = samples[i + 1] - thr;
        if ((rising && y0 < 0 && y1 >= 0) || (!rising && y0 >= 0 && y1 < 0)) {
          let lo = t0 + i * step;
          let hi = lo + step;
          for (let k = 0; k < 22; k++) {
            const mid = (lo + hi) / 2;
            const ym = altAt(mid) - thr;
            if ((ym < 0) === rising) lo = mid;
            else hi = mid;
          }
          return new Date((lo + hi) / 2);
        }
      }
      return null;
    };

    const res = {
      solarNoon,
      noonAltitude: samples[noonIdx],
      sunrise: crossing(-0.833, true),
      sunset: crossing(-0.833, false),
      goldenMorningEnd: crossing(6, true),
      goldenEveningStart: crossing(6, false),
      blueMorningStart: crossing(-8, true),
      blueMorningEnd: crossing(-4, true),
      blueEveningStart: crossing(-4, false),
      blueEveningEnd: crossing(-8, false),
      civilDawn: crossing(-6, true),
      civilDusk: crossing(-6, false),
      nauticalDawn: crossing(-12, true),
      nauticalDusk: crossing(-12, false),
      astroDawn: crossing(-18, true),
      astroDusk: crossing(-18, false),
    };
    if (_timesCache.size > 8) _timesCache.clear();
    _timesCache.set(key, res);
    return res;
  }

  /**
   * Next moonrise and moonset within 24 h of `date` (scan every 10 min, then bisect).
   * Uses the almanac rule: the upper limb on the horizon, with 34′ of refraction.
   */
  let _moonCache = null;
  function moonEvents(date, lat, lng) {
    const t0 = date.getTime();
    if (_moonCache && Math.abs(_moonCache.t0 - t0) < 10 * 60e3 && _moonCache.lat === lat && _moonCache.lng === lng) {
      return _moonCache.res;
    }
    const altAt = (ms) => {
      const g = moonGeometric(new Date(ms), lat, lng);
      return (g.alt + Math.asin(1737.4 / g.dist)) * deg + 0.5667;
    };
    const step = 10 * 60e3;
    let rise = null;
    let set = null;
    let prev = altAt(t0);
    for (let i = 1; i <= 144 && (!rise || !set); i++) {
      const ms = t0 + i * step;
      const cur = altAt(ms);
      if ((prev < 0 && cur >= 0 && !rise) || (prev >= 0 && cur < 0 && !set)) {
        const rising = prev < 0;
        let lo = ms - step;
        let hi = ms;
        for (let k = 0; k < 18; k++) {
          const mid = (lo + hi) / 2;
          if ((altAt(mid) < 0) === rising) lo = mid;
          else hi = mid;
        }
        if (rising) rise = new Date((lo + hi) / 2);
        else set = new Date((lo + hi) / 2);
      }
      prev = cur;
    }
    const res = { rise, set };
    _moonCache = { t0, lat, lng, res };
    return res;
  }

  /**
   * Phase of day used by the panel and by atmospheric behaviour
   * (e.g. valley mist is thickest around dawn).
   */
  function dayPhase(date, sunAltDeg, times) {
    const morning = !times.solarNoon || date < times.solarNoon;
    const a = sunAltDeg;
    if (a < -18) return { key: 'night', label: 'Night' };
    if (morning) {
      if (a < -2) return { key: 'predawn', label: a > -8 ? 'Pre-dawn · blue hour' : 'Pre-dawn' };
      if (a < 6) return { key: 'sunrise', label: 'Sunrise' };
      return { key: 'morning', label: 'Morning' };
    }
    if (a >= 6) return { key: 'afternoon', label: date.getHours() < 12 ? 'Midday' : 'Afternoon' };
    if (a >= 0.5) return { key: 'golden', label: 'Golden hour' };
    if (a >= -4) return { key: 'sunset', label: 'Sunset' };
    return { key: 'twilight', label: a > -8 ? 'Twilight · blue hour' : 'Twilight' };
  }

  function compassName(azDeg) {
    const names = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
    return names[Math.round((((azDeg % 360) + 360) % 360) / 22.5) % 16];
  }

  LE.astronomy = {
    sunPosition,
    moonPosition,
    moonIllumination,
    moonPhaseName,
    localSiderealTime,
    sunTimes,
    moonEvents,
    dayPhase,
    compassName,
  };
})();
