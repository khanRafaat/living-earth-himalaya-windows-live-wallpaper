/*
 * The test panel (?debug=1): a slider for everything the wallpaper can do, so any scenario can be seen at once
 * instead of waiting for the hour or the weather. It tells the page what the clock, the weather service, Lively and
 * the Windows app would tell it, so what it shows is what those would show. Nothing is saved: a reload starts over.
 * Nothing here runs without ?debug=1.
 */
(function () {
  'use strict';
  const LE = (window.LE = window.LE || {});

  const pad = (n) => String(n).padStart(2, '0');
  const hhmm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const dayOfYear = (d) => Math.floor((d - new Date(d.getFullYear(), 0, 0)) / 864e5);
  const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  const compass = (deg) => COMPASS[Math.round(((deg % 360) + 360) / 45) % 8];
  const ON_OFF = [['Off', 0], ['On', 1]];
  const SLOW_FRAME_MS = 2000; // what the Windows app asks for while you work (src/services/host.js)

  // [from this many mm/h, weather code]. A code's own minimum is what its amount gives anyway, so the rain never jumps
  const RAIN = [[6.65, 65], [4.2, 63], [2.45, 61], [2.1, 55], [1.4, 53], [0, 51]];
  const SNOW = [[6.65, 75], [4.2, 73], [0, 71]];
  const DECIDE_THE_WEATHER = ['cloud', 'precip', 'temp', 'visibility', 'thunder'];
  const UPPER_WINDS = ['wind850', 'dir850', 'wind700', 'dir700', 'wind300', 'dir300'];

  /** The weather the sliders describe: base (a preset or the real weather) with the values in f on top. */
  LE.testWeather = function (base, f) {
    const r = { ...base, ...f };
    if (f.cloud != null) {
      delete r.cloudLow; // layers would decide the cover instead of this number
      delete r.cloudMid;
    }
    if (f.windSpeed != null || f.windDir != null) for (const k of UPPER_WINDS) delete r[k]; // the clouds follow this wind too
    if (!DECIDE_THE_WEATHER.some((k) => f[k] != null)) return r;
    r.exactCloud = true;
    const precip = r.precip ?? 0;
    const cloud = r.cloud ?? 30;
    if (f.thunder != null ? f.thunder : base.code >= 95) r.code = 95;
    else if (precip > 0.05) r.code = ((r.temp ?? 20) < 0.5 ? SNOW : RAIN).find(([from]) => precip >= from)[1];
    else if ((r.visibility ?? 20000) <= 400) r.code = 45;
    else r.code = cloud < 12 ? 0 : cloud < 35 ? 1 : cloud < 62 ? 2 : 3;
    return r;
  };

  /** Sets the clock from these overrides. Whatever isn't changing carries on from the time now showing. */
  LE.testClock = function (cfg, clock, change) {
    const o = cfg.overrides;
    const shown = clock.now();
    const real = new Date();
    Object.assign(o, change);
    if (!o.time && !o.date && !(o.timelapse > 0)) return clock.configure({});
    clock.configure({
      time: 'time' in change ? change.time || hhmm(real) : hhmm(shown),
      date: 'date' in change ? change.date || ymd(real) : ymd(shown),
      timelapse: o.timelapse,
    });
  };

  LE.DebugPanel = class {
    /** api: { cfg, env, life, overlay, renderer(), governor(), realWeather(), setWeather(rec, atOnce), poke(), resize() } */
    constructor(api) {
      this.api = api;
      const named = api.cfg.overrides.weather;
      this.preset = named && LE.weatherPresets[named] ? named : 'real';
      this.fields = {};
      this.weatherChange = 0;
      this.naturalChange = api.cfg.atmosphere.transitionSeconds;
      this.pace = 'live';
      this.realPlace = null;
      this.rows = [];
      this.notes = [];
      this._build();
      this._refresh();
      setInterval(() => this._refresh(), 1000);
      window.addEventListener('pointerup', () => this.rows.forEach((r) => (r.held = false)));
      window.addEventListener('pointercancel', () => this.rows.forEach((r) => (r.held = false)));
    }

    // ---------------------------------------------------------------- weather
    _base() {
      return LE.weatherPresets[this.preset] || this.api.realWeather() || LE.weatherPresets.partly;
    }
    _record() {
      return LE.testWeather(this._base(), this.fields);
    }
    _pushWeather() {
      const custom = Object.keys(this.fields).length > 0;
      const named = !!LE.weatherPresets[this.preset];
      this.api.cfg.overrides.weather = named && !custom ? this.preset : null;
      const rec = this.preset === 'none' ? null : named || custom ? this._record() : undefined;
      this.api.setWeather(rec, this.weatherChange === 0);
    }
    _field(key, value) {
      if (this.preset === 'none') this.preset = 'real';
      if (value == null) delete this.fields[key];
      else this.fields[key] = value;
      this._pushWeather();
    }
    _weatherRow(key, label, opts) {
      return {
        label,
        get: () => this._record()[key] ?? opts.none,
        set: (v) => this._field(key, v),
        changed: () => key in this.fields,
        reset: () => this._field(key, null),
        ...opts,
      };
    }

    // ---------------------------------------------------------------- things
    _clock(change) {
      LE.testClock(this.api.cfg, LE.clock, change);
    }
    _place(key, value) {
      const env = this.api.env;
      if (!this.realPlace) this.realPlace = { ...env.loc };
      env.setLocation({ ...env.loc, [key]: value });
    }
    _pace(pace) {
      this.pace = pace;
      window.leSetSlowFrames(pace === 'rest' ? SLOW_FRAME_MS : 0);
      window.livelyWallpaperPlaybackChanged({ IsPaused: pace === 'still' });
    }
    _setting(obj, key, label, opts) {
      return { label, get: () => obj[key], set: (v) => (obj[key] = v), ...opts };
    }
    _graphicsReset() {
      const gl = this.api.renderer().gl;
      const ext = gl.getExtension('WEBGL_lose_context');
      if (!ext) return;
      ext.loseContext();
      setTimeout(() => ext.restoreContext(), 1000);
    }

    _sections() {
      const { cfg, env, life, overlay, renderer, governor, resize } = this.api;
      const r = cfg.render;
      const a = cfg.atmosphere;
      const ui = cfg.ui;
      const o = cfg.overrides;
      const refreshPanel = (fn) => (v) => {
        fn(v);
        overlay.apply();
      };
      return [
        {
          title: 'Time and sky',
          open: true,
          note: () => {
            const s = env.state.astro;
            return s && s.sunAltDeg !== undefined
              ? `Sun ${s.sunAltDeg.toFixed(0)}° ${compass(s.sunAzDeg)}, moon ${s.moonAltDeg.toFixed(0)}° ${Math.round(s.moonFraction * 100)}% lit (${s.moonPhaseName}), ${s.phase ? s.phase.label : ''}`
              : '';
          },
          rows: [
            {
              label: 'Time of day',
              min: 0,
              max: 1435,
              step: 5,
              get: () => {
                const d = LE.clock.now();
                return d.getHours() * 60 + d.getMinutes();
              },
              set: (v) => this._clock({ time: `${pad(Math.floor(v / 60))}:${pad(v % 60)}` }),
              format: (v) => `${pad(Math.floor(v / 60))}:${pad(v % 60)}`,
              changed: () => !!o.time,
              reset: () => this._clock({ time: null }),
              tip: 'Sunrise, day, sunset, twilight, stars, moon, village lights',
            },
            {
              label: 'Day of the year',
              min: 1,
              max: 365,
              step: 1,
              get: () => dayOfYear(LE.clock.now()),
              set: (v) => this._clock({ date: ymd(new Date(LE.clock.now().getFullYear(), 0, v)) }),
              format: (v) => new Date(2026, 0, v).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }),
              changed: () => !!o.date,
              reset: () => this._clock({ date: null }),
              tip: 'Season, tree and ground colour, snow line, moon phase, geese, meteor showers',
            },
            {
              label: 'Time-lapse',
              stops: [['Off', 0], ['×60', 60], ['×240', 240], ['×720', 720], ['×1800', 1800], ['×3600', 3600]],
              get: () => o.timelapse,
              set: (v) => this._clock({ timelapse: v }),
              changed: () => o.timelapse > 0,
              reset: () => this._clock({ timelapse: 0 }),
              tip: '×720 is a whole day in 2 minutes',
            },
            {
              label: 'Latitude',
              min: -70,
              max: 70,
              step: 1,
              get: () => env.loc.lat,
              set: (v) => this._place('lat', v),
              format: (v) => `${Math.abs(v).toFixed(1)}° ${v >= 0 ? 'N' : 'S'}`,
              changed: () => !!this.realPlace,
              reset: () => {
                env.setLocation(this.realPlace);
                this.realPlace = null;
              },
              tip: 'Where the sun and moon rise and how high they go',
            },
            {
              label: 'Longitude',
              min: -180,
              max: 180,
              step: 1,
              get: () => env.loc.lon,
              set: (v) => this._place('lon', v),
              format: (v) => `${Math.abs(v).toFixed(1)}° ${v >= 0 ? 'E' : 'W'}`,
              changed: () => !!this.realPlace,
              reset: () => {
                env.setLocation(this.realPlace);
                this.realPlace = null;
              },
              tip: 'The clock stays on this PC, so moving east makes the sun earlier',
            },
          ],
        },
        {
          title: 'Weather',
          open: true,
          note: () => {
            const w = env.state.weather;
            return w && w.coverage !== undefined
              ? `On screen now: cloud ${Math.round(w.coverage * 100)}%, rain ${Math.round(w.rain * 100)}%, snow ${Math.round(w.snow * 100)}%, fog ${Math.round(w.fog * 100)}%, mist ${Math.round(w.mist * 100)}%`
              : '';
          },
          rows: [
            {
              label: 'Weather',
              stops: [['Real', 'real'], ['Clear', 'clear'], ['Partly cloudy', 'partly'], ['Overcast', 'overcast'], ['Rain', 'rain'], ['Heavy rain', 'heavyrain'], ['Storm', 'storm'], ['Fog', 'fog'], ['Snow', 'snow'], ['No data', 'none']],
              get: () => this.preset,
              set: (v) => {
                this.preset = v;
                this.fields = {};
                this._pushWeather();
              },
              format: (v) => {
                const stop = this.rows.find((x) => x.label === 'Weather').stops.find((s) => s[1] === v);
                return Object.keys(this.fields).length ? `${stop[0]} +` : stop[0];
              },
              changed: () => this.preset !== 'real' || Object.keys(this.fields).length > 0,
              reset: () => {
                this.preset = 'real';
                this.fields = {};
                this._pushWeather();
              },
              tip: 'Moves the sliders below. Then move any of them to change just that',
            },
            this._weatherRow('cloud', 'Cloud cover', { min: 0, max: 100, step: 1, none: 30, format: (v) => `${Math.round(v)}%` }),
            this._weatherRow('cloudHigh', 'High cloud', { min: 0, max: 100, step: 1, none: 15, format: (v) => `${Math.round(v)}%`, tip: 'Thin cirrus far above the clouds' }),
            this._weatherRow('precip', 'Rain or snow', { min: 0, max: 10, step: 0.1, none: 0, format: (v) => `${v.toFixed(1)} mm/h` }),
            this._weatherRow('temp', 'Temperature', { min: -20, max: 45, step: 1, none: 20, format: (v) => `${Math.round(v)}°C`, tip: 'Below 0.5°C rain falls as snow' }),
            this._weatherRow('humidity', 'Humidity', { min: 0, max: 100, step: 1, none: 65, format: (v) => `${Math.round(v)}%`, tip: 'Valley mist and haze' }),
            this._weatherRow('visibility', 'Visibility', {
              min: 0,
              max: 100,
              step: 1,
              none: 20000,
              toSlider: (v) => (100 * Math.log(v / 100)) / Math.log(500),
              fromSlider: (s) => 100 * Math.pow(500, s / 100),
              format: (v) => (v >= 1000 ? `${(v / 1000).toFixed(v >= 10000 ? 0 : 1)} km` : `${Math.round(v / 10) * 10} m`),
              tip: 'Haze, then fog below 2.5 km, thick fog below 400 m',
            }),
            {
              label: 'Thunder',
              stops: ON_OFF,
              get: () => this.fields.thunder ?? (this._base().code >= 95 ? 1 : 0),
              set: (v) => this._field('thunder', v),
              changed: () => 'thunder' in this.fields,
              reset: () => this._field('thunder', null),
              tip: 'Storm clouds and lightning',
            },
            {
              label: 'Weather change',
              stops: [['At once', 0], ['15 s', 15], ['30 s', 30], ['90 s, as real', 90], ['5 min', 300]],
              get: () => this.weatherChange,
              set: (v) => {
                this.weatherChange = v;
                a.transitionSeconds = v || this.naturalChange;
              },
              tip: 'Natural order: clouds build first, then rain falls, then the sky clears',
            },
          ],
        },
        {
          title: 'Wind',
          open: true,
          note: () => {
            const s = env.state;
            const R = renderer();
            const lean = R && R.fg && R.fg.treeWind ? R.fg.treeWind.lean[0] : 0;
            return `The air goes this way on screen. Now ${Math.round(s.treeKmh)} km/h, top of the tree moved ${lean.toFixed(2)} m`;
          },
          arrow: true,
          rows: [
            this._weatherRow('windSpeed', 'Wind speed', { min: 0, max: 130, step: 1, none: 8, format: (v) => `${Math.round(v)} km/h`, tip: 'Tree, grass, forest, clouds, rain' }),
            {
              ...this._weatherRow('gusts', 'Gusts', { min: 0, max: 160, step: 1, format: (v) => `${Math.round(v)} km/h` }),
              get: () => {
                const w = this._record();
                return w.gusts ?? (w.windSpeed ?? 8) * 1.5;
              },
            },
            this._weatherRow('windDir', 'Wind from', { min: 0, max: 359, step: 1, none: 270, format: (v) => `${Math.round(v)}° ${compass(v)}` }),
            this._setting(a, 'treeWind', 'Wind in the trees', { min: 0, max: 3, step: 0.1, format: (v) => (v === 0 ? 'Off' : `×${v.toFixed(1)}`) }),
            this._setting(a, 'cloudSpeed', 'Cloud speed', { min: 0.5, max: 10, step: 0.5, format: (v) => `×${v.toFixed(1)}`, tip: '1 is the real speed' }),
          ],
        },
        {
          title: 'On screen',
          rows: [
            {
              label: 'Tree on the rock',
              stops: ON_OFF,
              get: () => (r.tree !== false ? 1 : 0),
              set: (v) => {
                r.tree = !!v;
                const R = renderer();
                if (R && R.fg) R.fg.enabled = !!v;
              },
            },
            {
              label: 'Birds, smoke, lights',
              stops: ON_OFF,
              get: () => (cfg.life !== false ? 1 : 0),
              set: (v) => (cfg.life = !!v),
              tip: 'Also meteors and satellites',
            },
          ],
          buttons: [
            ['Raptor', () => life.summon('raptor'), 'Birds leave in rain, snow, fog and at night'],
            ['Flock', () => life.summon('flock'), 'Birds leave in rain, snow, fog and at night'],
            ['Geese', () => life.summon('geese'), 'Birds leave in rain, snow, fog and at night'],
            ['Meteor', () => life.summon('meteor'), 'Shows in a dark sky'],
            ['Satellite', () => life.summon('satellite'), 'Shows in a dark sky'],
            [
              'Lightning',
              () => {
                if (!this.rows.find((x) => x.label === 'Thunder').get()) this._field('thunder', 1);
                env._nextFlash = 0;
              },
              'Turns the thunder on if it is off',
            ],
          ],
        },
        {
          title: 'Picture and load',
          note: () => {
            const R = renderer();
            return R ? `Drawn at ${R.w}×${R.h}, ${R.gpuBusyMs.toFixed(0)} ms of GPU a frame, level ${governor().name()}` : '';
          },
          rows: [
            {
              label: 'Quality',
              stops: [['Auto', 'auto'], ['Eco', 'eco'], ['Balanced', 'balanced'], ['High', 'high'], ['Ultra', 'ultra']],
              get: () => r.quality,
              set: (v) => {
                r.quality = v;
                governor().setMode(v);
              },
            },
            this._setting(r, 'fpsCap', 'Frames a second', { min: 5, max: 60, step: 1, format: (v) => `${v} fps` }),
            this._setting(r, 'calmFps', 'When nothing is fast', { min: 5, max: 30, step: 1, format: (v) => `${v} fps`, tip: 'No birds, rain, snow or lightning on screen' }),
            {
              label: 'Smart frame rate',
              stops: ON_OFF,
              get: () => (r.smartFps ? 1 : 0),
              set: (v) => (r.smartFps = !!v),
              tip: 'Off also turns off the calm scene',
            },
            this._setting(r, 'calmSceneMs', 'Calm scene', {
              stops: [['Off', 0], ['Every 0.25 s', 250], ['Every 0.5 s', 500], ['Every 1 s', 1000], ['Every 2 s', 2000]],
              tip: 'With no rain or snow, how often the scene is drawn again. Between those it fades',
            }),
            this._setting(r, 'maxGpuShare', 'Most GPU it may use', { min: 0.1, max: 1, step: 0.05, format: (v) => `${Math.round(v * 100)}%` }),
            {
              label: 'Wallpaper state',
              stops: [['Live', 'live'], ['Rest, you work', 'rest'], ['Paused', 'still']],
              get: () => this.pace,
              set: (v) => this._pace(v),
              tip: 'What the Windows app does when a window covers the desktop, or the PC is locked',
            },
            {
              label: 'Picture size',
              min: 0.4,
              max: 1,
              step: 0.05,
              release: true,
              get: () => r.renderScale,
              set: (v) => {
                r.renderScale = v;
                resize();
              },
              format: (v) => `${Math.round(v * 100)}%`,
              tip: 'Redraws the mountains, which takes a while',
            },
            this._setting(r, 'heading', 'View direction', { min: 0, max: 359, step: 1, format: (v) => `${Math.round(v)}° ${compass(v)}`, tip: 'Where the sun and moon cross the view' }),
            this._setting(r, 'seed', 'Landscape', { min: 1, max: 20, step: 1, release: true, format: (v) => `No. ${v}`, tip: 'Redraws the mountains, which takes a while' }),
            this._setting(cfg, 'debugView', 'Layer', {
              stops: [['Picture', 0], ['Colour', 1], ['Surface', 2], ['Shadow', 3], ['Occlusion', 4], ['Depth', 5], ['Clouds', 6], ['Forest', 7]],
              tip: 'One part of the picture alone',
            }),
          ],
          buttons: [['Graphics reset', () => this._graphicsReset(), 'What happens when a graphics driver restarts. The picture comes back after a while']],
        },
        {
          title: 'Clock and weather panel',
          rows: [
            { label: 'Show it', stops: ON_OFF, get: () => (ui.showPanel ? 1 : 0), set: refreshPanel((v) => (ui.showPanel = !!v)) },
            {
              label: 'Where',
              stops: [['Right, bottom', 'right-bottom'], ['Right, top', 'right-top'], ['Left, bottom', 'left-bottom'], ['Left, top', 'left-top']],
              get: () => ui.panelPosition,
              set: refreshPanel((v) => (ui.panelPosition = v)),
            },
            { label: 'Clock', stops: [['12 hour', 0], ['24 hour', 1]], get: () => (ui.clock24h ? 1 : 0), set: (v) => (ui.clock24h = !!v) },
            { label: 'Temperature in', stops: [['°C', 'C'], ['°F', 'F']], get: () => ui.tempUnit, set: (v) => (ui.tempUnit = v) },
          ],
        },
      ];
    }

    // ---------------------------------------------------------------- slider ↔ value
    _sliderOf(row, v) {
      if (row.stops) {
        const exact = row.stops.findIndex((s) => s[1] === v);
        if (exact >= 0) return exact;
        let best = 0; // a value from the URL that isn't one of the stops
        row.stops.forEach((s, i) => {
          if (Math.abs(s[1] - v) < Math.abs(row.stops[best][1] - v)) best = i;
        });
        return best;
      }
      return row.toSlider ? row.toSlider(v) : v;
    }
    _valueOf(row, s) {
      if (row.stops) return row.stops[s][1];
      return row.fromSlider ? row.fromSlider(s) : s;
    }
    _text(row, v) {
      if (row.format) return row.format(v);
      return row.stops[this._sliderOf(row, v)][0];
    }

    // ---------------------------------------------------------------- the panel
    _build() {
      const el = (this.el = document.createElement('div'));
      el.id = 'test-panel';
      const make = (tag, cls, parent, text) => {
        const n = document.createElement(tag);
        if (cls) n.className = cls;
        if (text) n.textContent = text;
        parent.appendChild(n);
        return n;
      };
      const head = make('div', 'tp-head', el);
      make('b', '', head, 'Test panel');
      const button = (parent, text, fn, tip) => {
        const b = make('button', '', parent, text);
        b.type = 'button';
        if (tip) b.title = tip;
        b.addEventListener('click', fn);
        return b;
      };
      this.resetAll = button(head, 'Reset all', () => this._resetAll(), 'Everything back to the real time, the real weather and your settings');
      button(head, 'Move', () => el.classList.toggle('left'), 'To the other side of the screen');
      this.hideBtn = button(head, 'Hide', () => {
        const hidden = el.classList.toggle('hidden');
        this.hideBtn.textContent = hidden ? 'Show' : 'Hide';
      });
      make('div', 'tp-note', el, 'Hold the pointer over a name to see what it changes. Nothing here is saved.');

      for (const section of this._sections()) {
        const box = make('details', '', el);
        box.open = !!section.open;
        make('summary', '', box, section.title);
        for (const row of section.rows) this._addRow(box, row, make);
        if (section.buttons) {
          const line = make('div', 'tp-buttons', box);
          for (const [text, fn, tip] of section.buttons) {
            button(line, text, () => {
              fn();
              this._changed();
            }, tip);
          }
        }
        if (section.note) {
          const note = make('div', 'tp-note', box);
          const arrow = section.arrow ? make('span', 'tp-arrow', note, '↑') : null;
          const text = make('span', '', note);
          this.notes.push({ fn: section.note, text, arrow });
        }
      }
      document.body.appendChild(el);
    }

    _addRow(box, row, make) {
      const line = make('div', 'tp-row', box);
      const name = make('label', '', line, row.label);
      if (row.tip) name.title = row.tip;
      const input = make('input', '', line);
      input.type = 'range';
      input.min = row.stops ? 0 : row.min;
      input.max = row.stops ? row.stops.length - 1 : row.max;
      input.step = row.stops ? 1 : row.step;
      input.setAttribute('aria-label', row.label);
      const value = make('span', 'tp-value', line);
      const reset = make('button', 'tp-reset', line, '↺');
      reset.type = 'button';
      reset.title = 'Back to the start';
      Object.assign(row, { input, value, resetBtn: reset, held: false });
      // Without its own, a row goes back to the value it had when the page opened
      if (!row.changed) {
        const start = row.get();
        row.changed = () => row.get() !== start;
        row.reset = () => row.set(start);
      }
      this.rows.push(row);
      input.addEventListener('pointerdown', () => (row.held = true));
      input.addEventListener('input', () => {
        const v = this._valueOf(row, +input.value);
        if (row.release) {
          value.textContent = this._text(row, v);
          return;
        }
        row.set(v);
        this._changed();
      });
      input.addEventListener('change', () => {
        if (row.release) row.set(this._valueOf(row, +input.value));
        this._settled();
      });
      reset.addEventListener('click', () => {
        row.reset();
        this._settled();
      });
    }

    /** Full rate for a moment, so a change is seen at once. */
    _changed() {
      this.api.poke();
      this._refresh();
    }
    /** The pointer has let go: clouds and exposure go straight to the new values. */
    _settled() {
      const R = this.api.renderer();
      if (R) {
        R._volWarm = 0;
        R._adaptReset = true;
      }
      this._changed();
    }
    _resetAll() {
      // First, so the weather below goes straight back
      this.weatherChange = 0;
      this.api.cfg.atmosphere.transitionSeconds = this.naturalChange;
      for (const row of this.rows) if (row.changed()) row.reset();
      this._settled();
    }

    _refresh() {
      if (this.el.classList.contains('hidden')) return;
      for (const row of this.rows) {
        const v = row.get();
        if (!row.held) {
          row.input.value = this._sliderOf(row, v);
          row.value.textContent = this._text(row, v);
        } else if (!row.release) {
          row.value.textContent = this._text(row, v);
        }
        row.resetBtn.style.visibility = row.changed() ? 'visible' : 'hidden';
      }
      for (const n of this.notes) {
        n.text.textContent = n.fn();
        if (n.arrow && this.api.env.state.treeDir) {
          const [x, z] = this.api.env.state.treeDir;
          n.arrow.style.transform = `rotate(${(Math.atan2(x, z) * 180) / Math.PI}deg)`;
        }
      }
    }
  };
})();
