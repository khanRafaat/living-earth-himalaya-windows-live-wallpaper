/*
 * While the scene is being worked on: a page opened straight from disk reloads itself when dev/stamp.js
 * changes, so an open browser tab shows each update without pressing F5.
 *
 * dev/stamp.js holds one line, `window.leDevStamp && leDevStamp('<any text>')`, and is rewritten after
 * every change. It is not part of a release: without the file this script stops after its first look.
 * Never active under the host app (?host=1) or in automated tests (?test=1).
 */
(function () {
  'use strict';
  const q = new URLSearchParams(window.location.search);
  if (q.get('host') === '1' || q.get('test') === '1' || q.get('reload') === '0') return;

  const POLL_MS = 1500;
  let first = null;
  let seen = null;

  window.leDevStamp = function (stamp) {
    seen = String(stamp);
  };

  function look() {
    seen = null;
    const s = document.createElement('script');
    s.src = `dev/stamp.js?${Date.now()}`;
    s.onload = () => {
      s.remove();
      if (seen === null) return setTimeout(look, POLL_MS);
      if (first === null) first = seen;
      else if (seen !== first) return window.location.reload();
      setTimeout(look, POLL_MS);
    };
    s.onerror = () => {
      s.remove();
      if (first !== null) setTimeout(look, POLL_MS); // mid-write: try again
    };
    document.head.appendChild(s);
  }

  look();
})();
