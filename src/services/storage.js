/* Safe localStorage wrapper — works (or fails silently) under file://, WebView2 and private windows. */
(function () {
  'use strict';
  const LE = (window.LE = window.LE || {});

  LE.storage = {
    get(key, fallback = null) {
      try {
        const s = window.localStorage.getItem(key);
        return s ? JSON.parse(s) : fallback;
      } catch (e) {
        return fallback;
      }
    },
    set(key, value) {
      try {
        window.localStorage.setItem(key, JSON.stringify(value));
        return true;
      } catch (e) {
        return false;
      }
    },
    remove(key) {
      try {
        window.localStorage.removeItem(key);
      } catch (e) {
        /* ignore */
      }
    },
  };
})();
