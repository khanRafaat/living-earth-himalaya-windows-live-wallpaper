/*
 * Information panel — clock, phase of day, local weather, sun and moon.
 * Updated once per second (not every frame) to keep CPU use negligible.
 */
(function () {
  'use strict';
  const LE = (window.LE = window.LE || {});

  const ICONS = {
    sun: '<circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M5.3 18.7l1.6-1.6M17.1 6.9l1.6-1.6"/>',
    moon: '<path d="M19.5 14.8A7.8 7.8 0 0 1 9.2 4.5a7.8 7.8 0 1 0 10.3 10.3z"/>',
    partly: '<path d="M8.5 4.2v1.6M3.2 9.5h1.6M4.8 5.8l1.1 1.1M12.2 5.8l-1.1 1.1"/><path d="M5.9 12.1a3.4 3.4 0 0 1 6.1-3.4"/><path d="M7.5 19.5h9.8a3.7 3.7 0 0 0 .3-7.4 5 5 0 0 0-9.6 1.3 3.1 3.1 0 0 0-.5 6.1z"/>',
    cloud: '<path d="M6.5 18.5h11a4 4 0 0 0 .4-8 5.5 5.5 0 0 0-10.6 1.4A3.4 3.4 0 0 0 6.5 18.5z"/>',
    rain: '<path d="M6.5 14.5h11a4 4 0 0 0 .4-8 5.5 5.5 0 0 0-10.6 1.4A3.4 3.4 0 0 0 6.5 14.5z"/><path d="M8 17.5l-1 2.5M12 17.5l-1 2.5M16 17.5l-1 2.5"/>',
    storm: '<path d="M6.5 13.5h11a4 4 0 0 0 .4-8 5.5 5.5 0 0 0-10.6 1.4A3.4 3.4 0 0 0 6.5 13.5z"/><path d="M12.5 13.5l-2.2 4h3l-2 4"/>',
    fog: '<path d="M4 9h16M3 13h18M5 17h14"/>',
    snow: '<path d="M12 3v18M4.2 7.5l15.6 9M4.2 16.5l15.6-9"/><path d="M9.8 4.5L12 6.5l2.2-2M9.8 19.5L12 17.5l2.2 2"/>',
  };

  function iconFor(code, isNight) {
    if (code === null || code === undefined) return isNight ? 'moon' : 'sun';
    if (code >= 95) return 'storm';
    if ((code >= 71 && code <= 77) || code === 85 || code === 86) return 'snow';
    if (code >= 51) return 'rain';
    if (code === 45 || code === 48) return 'fog';
    if (code === 3) return 'cloud';
    if (code === 2) return 'partly';
    return isNight ? 'moon' : 'sun';
  }

  class Overlay {
    constructor(root, cfg) {
      this.root = root;
      this.cfg = cfg;
      this.el = {};
      root.querySelectorAll('[data-k]').forEach((n) => (this.el[n.dataset.k] = n));
      this.apply();
    }

    apply() {
      const ui = this.cfg.ui;
      this.root.style.display = ui.showPanel ? '' : 'none';
      this.root.className = 'panel pos-' + ui.panelPosition;
    }

    _time(d, withSeconds) {
      if (!d) return '—';
      const h24 = this.cfg.ui.clock24h;
      let h = d.getHours();
      const m = String(d.getMinutes()).padStart(2, '0');
      if (h24) return `${String(h).padStart(2, '0')}:${m}`;
      const ap = h >= 12 ? 'PM' : 'AM';
      h = h % 12 || 12;
      return withSeconds ? { hm: `${h}:${m}`, ap } : `${h}:${m} ${ap}`;
    }

    _temp(c) {
      if (c === null || c === undefined) return '—';
      return this.cfg.ui.tempUnit === 'F' ? `${Math.round((c * 9) / 5 + 32)}°` : `${Math.round(c)}°`;
    }

    update(now, state, weather, info) {
      if (!this.cfg.ui.showPanel) return;
      const e = this.el;
      const a = state.astro || {};
      const t = this._time(now, true);
      if (typeof t === 'string') {
        e.clock.textContent = t;
        e.ampm.textContent = '';
      } else {
        e.clock.textContent = t.hm;
        e.ampm.textContent = t.ap;
      }
      e.date.textContent = now.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });

      const sunAz = a.sunAzDeg !== undefined ? LE.astronomy.compassName(a.sunAzDeg) : '';
      e.phase.textContent = a.phase ? a.phase.label : '';
      // real-time positions; a body below the horizon is simply not mentioned
      const parts = [];
      if (a.sunAltDeg !== undefined && a.sunAltDeg > -0.833) parts.push(`Sun ${Math.max(0, Math.round(a.sunAltDeg))}° ${sunAz}`);
      if (a.moonAltDeg !== undefined && a.moonAltDeg > -0.54) {
        parts.push(`Moon ${Math.max(0, Math.round(a.moonAltDeg))}° ${LE.astronomy.compassName(a.moonAzDeg)} · ${Math.round(a.moonFraction * 100)}%`);
      }
      if (!parts.length && a.moonPhaseName) parts.push(`${a.moonPhaseName} · below the horizon`);
      e.phaseDetail.textContent = parts.join(' · ');

      const times = a.times || {};
      e.sunrise.textContent = this._time(times.sunrise);
      e.sunset.textContent = this._time(times.sunset);
      e.moonrise.textContent = this._time(a.moonRise);
      e.moonset.textContent = this._time(a.moonSet);

      const isNight = (a.sunAltDeg ?? 10) < -0.8;
      if (weather) {
        e.icon.innerHTML = ICONS[iconFor(weather.code, isNight)];
        e.temp.textContent = this._temp(weather.temp);
        e.cond.textContent = LE.weatherText(weather.code);
        e.hum.textContent = weather.humidity !== null && weather.humidity !== undefined ? `${Math.round(weather.humidity)}%` : '—';
        const ws = weather.windSpeed;
        e.wind.textContent =
          ws !== null && ws !== undefined ? `${Math.round(ws)} km/h ${LE.astronomy.compassName(weather.windDir ?? 0)}` : '—';
        e.cloud.textContent = weather.cloud !== null && weather.cloud !== undefined ? `${Math.round(weather.cloud)}%` : '—';
        const v = weather.visibility;
        e.vis.textContent = v !== null && v !== undefined ? (v >= 10000 ? `${Math.round(v / 1000)} km` : `${(v / 1000).toFixed(1)} km`) : '—';
      } else {
        e.icon.innerHTML = ICONS[isNight ? 'moon' : 'sun'];
        e.temp.textContent = '—';
        e.cond.textContent = 'No weather data yet';
        e.hum.textContent = e.wind.textContent = e.cloud.textContent = e.vis.textContent = '—';
      }
      e.loc.textContent = info.locationName;
      e.status.textContent = info.status;
    }
  }

  LE.Overlay = Overlay;
})();
