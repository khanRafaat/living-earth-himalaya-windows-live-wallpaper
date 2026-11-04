/*
 * Location service — browser geolocation when Windows allows it, Dhaka otherwise.
 * Never blocks for longer than geoTimeoutMs; the last good fix is cached.
 */
(function () {
  'use strict';
  const LE = (window.LE = window.LE || {});
  const KEY = 'le3840.location.v2';

  function distanceKm(aLat, aLon, bLat, bLon) {
    const r = Math.PI / 180;
    const dLat = (bLat - aLat) * r;
    const dLon = (bLon - aLon) * r;
    const s = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * r) * Math.cos(bLat * r) * Math.sin(dLon / 2) ** 2;
    return 6371 * 2 * Math.asin(Math.min(1, Math.sqrt(s)));
  }

  function label(lat, lon, cfg) {
    return distanceKm(lat, lon, cfg.lat, cfg.lon) < 40 ? cfg.name : 'Your area';
  }

  LE.location = {
    distanceKm,

    resolve(cfg) {
      const fallback = { lat: cfg.lat, lon: cfg.lon, name: cfg.name, source: 'default' };
      const cached = LE.storage.get(KEY);
      const cachedOk = cached && cached.source === 'geo' && Date.now() - cached.at < 7 * 864e5;

      if (!cfg.useGeolocation || !('geolocation' in navigator)) return Promise.resolve(fallback);

      return new Promise((resolve) => {
        let done = false;
        const finish = (v) => {
          if (!done) {
            done = true;
            resolve(v);
          }
        };
        const timer = setTimeout(() => finish(cachedOk ? cached : fallback), cfg.geoTimeoutMs);
        try {
          navigator.geolocation.getCurrentPosition(
            (pos) => {
              clearTimeout(timer);
              const lat = Math.round(pos.coords.latitude * 1000) / 1000;
              const lon = Math.round(pos.coords.longitude * 1000) / 1000;
              const v = { lat, lon, name: label(lat, lon, cfg), source: 'geo', at: Date.now() };
              LE.storage.set(KEY, v);
              finish(v);
            },
            () => {
              clearTimeout(timer);
              finish(cachedOk ? cached : fallback);
            },
            { enableHighAccuracy: false, timeout: cfg.geoTimeoutMs, maximumAge: 6 * 3600e3 }
          );
        } catch (e) {
          clearTimeout(timer);
          finish(fallback);
        }
      });
    },
  };
})();
