/*
 * The wind test: index.html?windtest=1
 *
 * A small panel for watching the tree answer the wind in real time. It starts on the real wind, and moving a
 * slider or pressing a button takes over from it. The values go in as a weather record, the same way real weather
 * arrives, so this shows what real wind of that speed and direction would do.
 */
(function () {
  'use strict';
  const LE = (window.LE = window.LE || {});

  const PRESETS = [
    ['Still', 0, 0],
    ['Light', 8, 12],
    ['Breeze', 20, 30],
    ['Windy', 40, 60],
    ['Gale', 70, 95],
    ['Storm', 100, 130],
  ];
  const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  const compass = (deg) => COMPASS[Math.round(((deg % 360) + 360) / 45) % 8];

  LE.WindTest = class {
    /** real(): the real wind now, or null. onChange(override): override is null for the real wind. */
    constructor(real, onChange) {
      this.real = real;
      this.onChange = onChange;
      this.override = null;
      const el = (this.el = document.createElement('div'));
      el.style.cssText =
        'position:fixed;top:16px;left:50%;transform:translateX(-50%);z-index:50;width:340px;max-width:calc(100vw - 32px);box-sizing:border-box;padding:14px 16px;' +
        'background:rgba(10,16,24,.82);color:#eef3f8;border-radius:10px;font:13px/1.45 "Segoe UI",system-ui,sans-serif;pointer-events:auto;user-select:none';
      const row = 'display:flex;align-items:center;gap:10px;margin-top:8px';
      const button = 'flex:1;padding:5px 0;border:1px solid #3a4f68;border-radius:6px;background:#1c2c3f;color:inherit;font:inherit;cursor:pointer';
      el.innerHTML =
        `<div style="font-weight:600">Wind test</div>` +
        `<div data-k="source" style="color:#b4c3d3"></div>` +
        `<div style="${row}"><label style="width:62px">Speed</label><input data-k="speed" type="range" min="0" max="130" step="1" style="flex:1"><span data-k="speedV" style="width:62px;text-align:right"></span></div>` +
        `<div style="${row}"><label style="width:62px">Gusts</label><input data-k="gust" type="range" min="0" max="160" step="1" style="flex:1"><span data-k="gustV" style="width:62px;text-align:right"></span></div>` +
        `<div style="${row}"><label style="width:62px">From</label><input data-k="dir" type="range" min="0" max="359" step="1" style="flex:1"><span data-k="dirV" style="width:62px;text-align:right"></span></div>` +
        `<div style="${row};gap:4px" data-k="presets"></div>` +
        `<div style="${row}"><button data-k="realBtn" style="${button}">Use the real wind</button></div>` +
        `<div style="${row}"><span data-k="arrow" style="display:inline-block;font-size:18px;line-height:1;width:18px;text-align:center">↑</span><span data-k="now" style="color:#b4c3d3"></span></div>`;
      this.k = {};
      el.querySelectorAll('[data-k]').forEach((n) => (this.k[n.dataset.k] = n));
      for (const [name, speed, gust] of PRESETS) {
        const b = document.createElement('button');
        b.textContent = name;
        b.style.cssText = button;
        b.addEventListener('click', () => this._set({ speed, gust, dir: +this.k.dir.value }));
        this.k.presets.appendChild(b);
      }
      const read = () => this._set({ speed: +this.k.speed.value, gust: Math.max(+this.k.gust.value, +this.k.speed.value), dir: +this.k.dir.value });
      for (const name of ['speed', 'gust', 'dir']) this.k[name].addEventListener('input', read);
      this.k.realBtn.addEventListener('click', () => this._set(null));
      document.body.appendChild(el);
      this._show();
    }

    _set(override) {
      this.override = override;
      this.onChange(override);
      this._show();
    }

    _show() {
      const real = this.real();
      const v = this.override || { speed: real ? real.windSpeed : 0, gust: real ? real.gusts : 0, dir: real ? real.windDir : 0 };
      this.k.speed.value = v.speed;
      this.k.gust.value = v.gust;
      this.k.dir.value = v.dir;
      this.k.speedV.textContent = `${Math.round(v.speed)} km/h`;
      this.k.gustV.textContent = `${Math.round(v.gust)} km/h`;
      this.k.dirV.textContent = `${Math.round(v.dir)}° ${compass(v.dir)}`;
      const wind = real ? `${Math.round(real.windSpeed)} km/h from ${compass(real.windDir)}, gusts ${Math.round(real.gusts)}` : 'not known yet';
      this.k.source.textContent = this.override ? `Test values. Real wind: ${wind}` : `Showing the real wind: ${wind}`;
      this.k.realBtn.disabled = !this.override;
      this.k.realBtn.style.opacity = this.override ? '1' : '0.5';
    }

    /** Each second: what the tree feels at this moment. treeDir is where the air goes on screen (x right, z ahead). */
    update(state, leanM) {
      if (!this.override) this._show();
      if (!state) return;
      const [x, z] = state.treeDir;
      this.k.arrow.style.transform = `rotate(${(Math.atan2(x, z) * 180) / Math.PI}deg)`;
      this.k.now.textContent = `The air goes this way on screen. Now ${Math.round(state.treeKmh)} km/h, top of the tree moved ${leanM.toFixed(2)} m`;
    }
  };
})();
