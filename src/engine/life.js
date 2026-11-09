/*
 * Life — everything that moves on its own: birds, chimney smoke, meteors, satellites.
 * Pure simulation on the CPU (a few dozen objects); it writes one instance buffer
 * per frame for the sprite pass. Behaviour follows the real clock and local weather:
 *   • raptors soar in thermals on sunny, calm middays
 *   • chough flocks swoop near the ridge, busiest after sunrise and before sunset
 *   • geese/cranes cross in V-formation during the real migration seasons
 *   • all birds shelter in rain, fog, snow and storms, and roost at night
 *   • wood smoke rises from village houses through the day, most at cooking times, and leans with the wind
 *   • when the air is humid or the forest wet, mist lifts off the canopy here and there, billows and dissolves
 *   • now and then a field burns on a hill: a tall plume fanning out at the top, glowing at its foot by night
 *   • meteor rates follow the real annual shower calendar and need a dark, clear sky
 *   • satellites only show in twilight, when they are sunlit against a dark sky
 *   • buses, jeeps and motorcycles keep to the road, driving on the left, and slow down for bends. Most in the day,
 *     few at night. Faster ones overtake slow ones on straight stretches when nothing is coming, with indicators;
 *     buses stop now and then with their hazard lights on. At night they drive on main beam, dip it for oncoming
 *     traffic, flash it before a blind hairpin, light the road and the trees ahead, and show red tail lights,
 *     brighter when braking
 * Units: km, km/s; scene frame as in the renderer (+z = view centre, camera at origin).
 */
(function () {
  'use strict';
  const LE = (window.LE = window.LE || {});
  const D2R = Math.PI / 180;
  const TAU = Math.PI * 2;
  const FLOATS = 20;
  const MAX = 160;
  const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
  const smooth = (a, b, x) => {
    const t = clamp((x - a) / (b - a), 0, 1);
    return t * t * (3 - 2 * t);
  };
  const rand = (a, b) => a + Math.random() * (b - a);
  const G = 0.0098; // km/s²

  const SPECIES = {
    raptor: { type: 0, span: 0.0026, flapHz: 2.0 },
    chough: { type: 1, span: 0.0008, flapHz: 6.5 },
    goose: { type: 2, span: 0.0016, flapHz: 3.1 },
  };

  // Annual meteor showers: peak (month, day), ZHR, radiant RA/Dec (deg), half-width (days)
  const SHOWERS = [
    { name: 'Quadrantids', m: 1, d: 3.6, zhr: 110, ra: 230, dec: 49, w: 0.6 },
    { name: 'Lyrids', m: 4, d: 22.5, zhr: 18, ra: 271, dec: 34, w: 1.0 },
    { name: 'Eta Aquariids', m: 5, d: 6, zhr: 50, ra: 338, dec: -1, w: 3.0 },
    { name: 'Perseids', m: 8, d: 12.6, zhr: 100, ra: 48, dec: 58, w: 2.0 },
    { name: 'Orionids', m: 10, d: 21.5, zhr: 20, ra: 95, dec: 16, w: 2.5 },
    { name: 'Leonids', m: 11, d: 17.6, zhr: 15, ra: 152, dec: 22, w: 1.5 },
    { name: 'Geminids', m: 12, d: 14.2, zhr: 150, ra: 112, dec: 33, w: 1.2 },
  ];

  // Sizes in km, cruising speed in km/s. Paint: 5 bits each of red, green and blue. Each kind drives its own way: bend,
  // how fast it takes a bend against a car (a motorcycle leans in, a bus is heavy and tall); accel, how quickly it picks
  // up speed (km/s²).
  const SIZE_ON_SCREEN = 1.3; // a little larger than life, or at this distance a motorcycle would be under a pixel
  const rgb5 = (r, g, b) => r + g * 32 + b * 1024;
  const VEHICLES = {
    // lamp height, how much light it throws, and how far: dipped and on main beam (km), and the beam's spread (cosine)
    bus: {
      code: 0, len: 0.0105, wid: 0.0025, hgt: 0.0031, cruise: 0.0078, bend: 0.78, accel: 0.6e-3, lane: 0.0017,
      lampH: 0.0009, power: 1.0, low: 0.065, high: 0.16, cone: 0.8,
      paints: [rgb5(24, 5, 4), rgb5(5, 11, 22), rgb5(26, 19, 4), rgb5(25, 25, 24), rgb5(5, 16, 10)],
    },
    jeep: {
      code: 1, len: 0.0045, wid: 0.0018, hgt: 0.0019, cruise: 0.011, bend: 1.0, accel: 1.2e-3, lane: 0.0017,
      lampH: 0.0008, power: 0.8, low: 0.055, high: 0.14, cone: 0.82,
      paints: [rgb5(27, 27, 26), rgb5(6, 12, 7), rgb5(19, 20, 20), rgb5(16, 4, 5), rgb5(4, 5, 7)],
    },
    motorcycle: {
      code: 2, len: 0.0021, wid: 0.0008, hgt: 0.0016, cruise: 0.0145, bend: 1.22, accel: 2.0e-3, lane: 0.0022,
      lampH: 0.0009, power: 0.4, low: 0.035, high: 0.085, cone: 0.88,
      paints: [rgb5(22, 5, 4), rgb5(5, 7, 14), rgb5(24, 24, 22), rgb5(9, 12, 6)],
    },
  };
  const TRAFFIC_MAX = 14; // on the whole road, most of which is in view
  // what rises from the hills: wood smoke from a house, mist off wet forest, smoke from a burning field
  const SMOKE = { village: 0, mist: 1, fire: 2 };
  // how much traffic the viewer wants: light, normal or busy
  const TRAFFIC = { light: 0.45, normal: 1, busy: 1.8 };
  const PASS_LANE = 0.0017; // km right of the centre line, where an overtaking vehicle drives
  const V_PASS = 0.016; // km/s, the fastest anyone overtakes at
  const PASS_ROOM = 0.035; // km clear beyond the last one it passes, to get back in
  const PASS_GAIN = 0.0015; // km/s it must be able to gain on them, or it would sit out in the other lane for ages
  const PASS_BLIND = 0.009; // km/s: a bend that slows anyone below this (tighter than about 55 m in radius) it cannot see round
  const PASS_TIME = 35; // s, the longest it would be out in the other lane
  // s: anything coming the other way must still be this long off, at the speed the two close, when it is back in its
  // lane. With only a fixed 60 m spare a slower oncoming jeep 300 m away now and then let a motorcycle go (1 run in 20)
  const PASS_SPARE = 4;
  // the room (km) it needs in front of it at speed v to move back in ahead of o: a little distance, and enough to slow
  // to o's pace in, at the rate a following vehicle slows
  const cutInRoom = (v, o) => Math.max(0.012 + v * 1.5, (v * v - o.v * o.v) / (2 * 1.8e-3) + 0.008);
  const BLINK_LEFT = 1;
  const BLINK_RIGHT = 2;
  const BLINK_BOTH = 3; // hazard lights
  const TMP = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];

  class Life {
    constructor() {
      this.data = new Float32Array(MAX * FLOATS);
      this.count = 0;
      this.movers = 0;
      this.raptors = [];
      this.flock = null;
      this.geese = null;
      this.meteors = [];
      this.sats = [];
      this.smoke = [];
      this.smokeSources = []; // [{x,y,z}] world positions found after the bake
      this.forestSources = []; // the same, on the forested slopes
      this.plumeA = new Float32Array(64); // mist and smoke, for the volume pass (_writePlumes)
      this.plumeB = new Float32Array(64);
      this.plumeC = new Float32Array(64);
      this.plumeCount = 0;
      this._nextWisp = 0;
      this._nextHearth = 0; // the next village to light its fires, or let them die down, waits for this (s)
      this.pace = 1; // how much faster than real smoke and mist come and go (the demo, a year in two minutes, raises it)
      this._hearthsLit = false; // the villages' smoke already going when the scene first shows
      this._nextFire = rand(300, 2400); // the first one can come early
      this.road = null;
      this.vehicles = [];
      this._nextVehicle = 0;
      this._trafficSeeded = false;
      this.enabled = true;
      this.birds = true; // off: no birds, while the rest of life goes on
      this.mist = true; // mist rising off the forest
      this.villageSmoke = true; // smoke from the villages
      this.fires = true; // a field burning now and then
      this.shootingStars = true; // meteors and satellites
      this.traffic = 'normal'; // light | normal | busy
      this.t = 0;
      this._nextFlock = rand(20, 90);
      this._nextGeese = rand(60, 240);
      this._nextRaptorCheck = 0;
      this.activeShower = null;
    }

    setSmokeSources(list) {
      this.smokeSources = list || [];
      this.smoke = this.smoke.filter((s) => s.kind !== SMOKE.village);
      this._hearthsLit = false;
    }

    /** The weather's wind near the ground: which way it blows (unit, scene axes) and how far it carries the top of
     * smoke or mist downwind per km it rises. */
    _wind(state) {
      const wv = state.windVel || [0, 0, 0];
      const kmh = Math.hypot(wv[0], wv[2]) * 3600;
      return {
        dx: kmh > 0.1 ? (wv[0] * 3600) / kmh : 0,
        dz: kmh > 0.1 ? (wv[2] * 3600) / kmh : 0,
        lean: clamp(kmh / 12, 0.2, 1.5),
      };
    }

    /**
     * Mist off the forest and smoke from houses and burning fields are drawn in 3D by the volume pass, not as pictures:
     * the ones in view now, nearest first, up to 16 (8 of mist), four numbers each in three arrays (see uPlumeA..C in volume.js).
     * The last number says which: 0 mist, 1 smoke from a house, 2 a burning field, plus half the glow of its fire.
     */
    /**
     * How the air treats smoke now, from -1 (unstable: a strong sun heating the ground, smoke climbs high, loops and
     * thins out fast) through 0 (neutral: overcast or windy, it leans and spreads in a cone) to 1 (stable: a calm,
     * clear night and the first hours after sunrise, under an inversion it climbs a little and then spreads out flat in
     * a thin layer that drifts a long way). The plume shapes of the textbooks: looping, coning, fanning.
     */
    _stability(state) {
      const sun = state.astro.sunAltDeg;
      const w = state.weather;
      const cover = w.coverage || 0;
      const night = smooth(12, 0, sun) * (1 - 0.8 * smooth(0.5, 0.95, cover)); // the inversion lingers after sunrise
      const heating = smooth(15, 50, sun) * (1 - 0.7 * smooth(0.4, 0.95, cover));
      return clamp((night - heating) * (1 - smooth(10, 30, w.windSpeed || 0)), -1, 1);
    }

    _writePlumes(list, state) {
      const v = this._view;
      const { dx, dz, lean } = this._wind(state);
      const st = this._stability(state);
      const stable = Math.max(st, 0);
      const unstable = Math.max(-st, 0);
      const seen = [];
      for (const s of list) {
        if (s.alpha < 0.005) continue;
        const p = s.src;
        const pr = this._project(p.x, p.y, p.z);
        const dist = Math.hypot(p.x, p.y - v.camY, p.z);
        // how far from its foot it can show, in px: sideways as it spreads and leans, and upwards as it rises
        const reach = (s.width * 4 + s.rise * (lean + 1)) / (dist * v.pxAng);
        if (this._inView(pr, reach + 20)) seen.push({ s, pr, dist });
      }
      seen.sort((a, b) => a.dist - b.dist);
      // the nearest 8 patches of mist at most, as they are big on the picture, and smoke in the rest
      let mists = 0;
      let drawn = seen.filter(({ s }) => s.kind !== SMOKE.mist || ++mists <= 8);
      if (drawn.length > 16) drawn = drawn.sort((p, q) => q.s.alpha - p.s.alpha).slice(0, 16).sort((p, q) => p.dist - q.dist);
      const n = drawn.length;
      for (let i = 0; i < n; i++) {
        const { s, pr, dist } = drawn[i];
        const p = s.src;
        const mist = s.kind === SMOKE.mist;
        // Mist forms as a low patch over the canopy and rises to its full height over a minute or two. Smoke climbs
        // from its fire to where it stops rising in about the same time.
        let H = mist ? s.rise * (0.35 + 0.65 * (1 - Math.exp(-s.age / 70))) : s.rise * (0.2 + 0.8 * (1 - Math.exp(-s.age / 60)));
        let width = s.width;
        let alpha = s.alpha;
        let driftK = s.drift || 1;
        if (s.kind === SMOKE.village) {
          // A hearth: its smoke climbs at a few metres a second, so the column takes minutes to stand up; the fire puffs
          // as wood goes on, each on its own beat; and as it dies down the smoke thins and, cooler, stops rising lower.
          H = s.rise * (0.15 + 0.85 * (1 - Math.exp(-s.age / 150)));
          const puff = 1 + 0.2 * Math.sin(((s.t || 0) / s.beat[0]) * 2 * Math.PI + s.beat[2]) * (0.6 + 0.4 * Math.sin(((s.t || 0) / s.beat[1]) * 2 * Math.PI));
          alpha *= puff;
          H *= (0.55 + 0.45 * Math.min(1, s.alpha / s.target)) * (1 + 0.06 * (puff - 1) * 5);
          // and the air: trapped low and drawn out flat under an inversion, high, wide and thin in a hot afternoon
          H *= 1 - 0.3 * stable + 0.3 * unstable;
          driftK *= 1 + 0.6 * stable - 0.25 * unstable;
          width *= 1 - 0.1 * stable + 0.3 * unstable;
          alpha *= 1 - 0.25 * unstable - 0.15 * stable; // spread thin either way
          // far across the valley the haze takes most of it, and what reads from there is the whole village's smoke
          const farK = smooth(5, 15, dist);
          alpha *= 1 + 0.8 * farK;
          width *= 1 + 0.3 * farK;
        }
        const code = mist ? 0 : s.kind === SMOKE.fire ? 2 : 1;
        this.plumeA.set([p.x, p.y - (mist ? 0.015 : 0), p.z, H], i * 4);
        // a village's smoke stops rising low and drifts off further downwind than a fire's hot column
        const drift = H * lean * driftK;
        this.plumeB.set([width * 0.5, alpha, dx * drift, dz * drift], i * 4);
        this.plumeC.set([s.seed * 40, pr.sx, pr.sy, code + clamp(s.fire, 0, 1) * 0.5], i * 4);
      }
      this.plumeCount = n;
    }

    setForestSources(list) {
      this.forestSources = list || [];
      this.smoke = this.smoke.filter((s) => s.kind === SMOKE.village);
    }

    setRoad(road) {
      this.road = road || null;
      this.vehicles = [];
      this._trafficSeeded = false;
    }

    /** Fill the screen with life immediately (used by automated screenshot tests). */
    seedForTest(state, view) {
      this._view = view;
      this.state = state;
      for (let i = 0; i < 3; i++) this.raptors.push(this._newRaptor(true));
      this.flock = this._newFlock(true);
      this.geese = this._newGeese(state, true);
      if (state.astro.sunAltDeg < -12) {
        const me = this._newMeteor(null, state);
        me.dur = 120;
        this.meteors.push(me);
        this.sats.push({ az: 0.3, el: 0.25, heading: 0.4, speed: 0.0005, age: 5, life: 600, bright: 0.45 });
      }
    }

    /** Brings one on now, whatever the hour and the weather (the test panel). They then behave as any other would. */
    summon(kind) {
      if (!this._view || !this.state) return;
      if (!this.birds && (kind === 'raptor' || kind === 'flock' || kind === 'geese')) return;
      if (!this._smokeOn(kind === 'mist' ? SMOKE.mist : kind === 'smoke' ? SMOKE.village : kind === 'fire' ? SMOKE.fire : -1)) return;
      if (!this.shootingStars && (kind === 'meteor' || kind === 'satellite')) return;
      if (kind === 'raptor') this.raptors.push(this._newRaptor(true));
      else if (kind === 'flock') this.flock = this._newFlock(true);
      else if (kind === 'geese') this.geese = this._newGeese(this.state, true);
      else if (kind === 'meteor') this.meteors.push(this._newMeteor(null, this.state));
      else if (kind === 'mist' || kind === 'smoke') {
        // put up part way through their lives, so they show at once, and held: the weather or the hour does not take
        // them away early, only the end of their time or turning life off
        for (let i = 0; i < (kind === 'mist' ? 6 : 4); i++) {
          const s = this._newPlume(kind === 'mist' ? SMOKE.mist : SMOKE.village);
          if (!s) break;
          s.alpha = s.target;
          s.age = rand(0, s.life * 0.5);
          s.held = true;
          this.smoke.push(s);
        }
      } else if (kind === 'fire') {
        const s = this._newPlume(SMOKE.fire);
        if (s) {
          s.alpha = s.target;
          s.age = 180; // risen to its full height, so it shows at once
          s.held = true;
          this.smoke.push(s);
        }
      }
      else if (kind === 'satellite') this.sats.push({ az: rand(-0.4, 0.4), el: 0.25, heading: 0.4, speed: 0.0005, age: 5, life: 600, bright: 0.45 });
      else if (VEHICLES[kind] && this.road) this.vehicles.push(this._newVehicle(kind, Math.random() < 0.5 ? 1 : -1, this._roadInView()));
    }

    // ------------------------------------------------------------ geometry helpers
    _project(x, y, z) {
      const v = this._view;
      const r = Math.hypot(x, z);
      const a = Math.atan2(x, z);
      return { sx: v.w / 2 + a / v.pxAng, sy: v.horizonY * v.h + ((y - v.camY) / Math.max(r, 1e-4)) / v.pxAng, r, a };
    }
    _inView(pr, marginPx = 40) {
      const v = this._view;
      return Math.abs(pr.a) < v.hfov / 2 + 0.1 && pr.sx > -marginPx && pr.sx < v.w + marginPx && pr.sy > -marginPx && pr.sy < v.h + marginPx;
    }
    /** A point inside the panorama: azimuth as a fraction of the half-width, distance (km), elevation (deg). */
    _pointInView(azFrac, dist, elDeg) {
      const az = azFrac * this._view.hfov * 0.5;
      return [Math.sin(az) * dist, this._view.camY + dist * Math.tan(elDeg * D2R), Math.cos(az) * dist];
    }
    _exitPoint(p) {
      // fly out sideways past the nearest edge of the panorama
      const side = Math.atan2(p[0], p[2]) >= 0 ? 1 : -1;
      const az = side * (this._view.hfov / 2 + 25 * D2R);
      const d = Math.hypot(p[0], p[2]) * rand(1.0, 1.4);
      return [Math.sin(az) * d, p[1] + rand(-0.03, 0.08), Math.cos(az) * d];
    }

    // ------------------------------------------------------------ species
    _newRaptor(inView) {
      const v = this._view;
      const c = this._pointInView(rand(-0.8, 0.8), rand(0.15, 0.6), rand(-3, 14));
      const startAz = (Math.random() < 0.5 ? -1 : 1) * (v.hfov / 2 + 10 * D2R);
      const d0 = Math.hypot(c[0], c[2]);
      const start = inView ? c.slice() : [Math.sin(startAz) * d0, c[1] - 0.05, Math.cos(startAz) * d0];
      const R = rand(0.035, 0.09);
      return {
        sp: SPECIES.raptor,
        mode: inView ? 'circle' : 'glide',
        pos: start,
        vel: [0, 0, 0],
        target: c,
        center: [c[0], c[2]],
        y: c[1],
        R,
        theta: rand(0, TAU),
        omega: (Math.random() < 0.5 ? -1 : 1) * (0.012 / R),
        circleTime: rand(60, 200),
        phase: rand(0, TAU),
        flapLeft: 0,
        nextFlap: rand(5, 25),
        bank: 0,
        alpha: inView ? 1 : 0,
      };
    }

    _newFlock(inView) {
      const n = Math.floor(rand(7, 17));
      const v = this._view;
      const side = Math.random() < 0.5 ? -1 : 1;
      const tgt = this._pointInView(rand(-0.6, 0.6), rand(0.06, 0.22), rand(-3, 12));
      const startAz = side * (v.hfov / 2 + 12 * D2R);
      const d0 = Math.hypot(tgt[0], tgt[2]);
      const base = inView ? tgt : [Math.sin(startAz) * d0, tgt[1], Math.cos(startAz) * d0];
      const birds = [];
      for (let i = 0; i < n; i++) {
        birds.push({
          sp: SPECIES.chough,
          pos: [base[0] + rand(-0.02, 0.02), base[1] + rand(-0.01, 0.01), base[2] + rand(-0.02, 0.02)],
          vel: [rand(-0.004, 0.004) - side * 0.008, 0, rand(-0.004, 0.004)],
          phase: rand(0, TAU),
          flapping: true,
          stateLeft: rand(0.2, 1.0),
          bank: 0,
          alpha: inView ? 1 : 0,
        });
      }
      return { birds, target: tgt, retarget: rand(3, 7), life: rand(70, 200), leaving: false };
    }

    _newGeese(state, inView) {
      const v = this._view;
      const doy = state.astro.dayOfYear;
      // autumn: Tibet → India (towards SW); spring: back towards NE; otherwise random waterfowl
      const autumn = doy >= 255 && doy <= 340;
      const spring = doy >= 55 && doy <= 125;
      const compass = autumn ? rand(195, 240) : spring ? rand(15, 60) : rand(0, 360);
      const rel = (compass - state.heading) * D2R;
      const dir = [Math.sin(rel), 0, Math.cos(rel)];
      const mid = this._pointInView(rand(-0.5, 0.5), rand(0.3, 0.6), rand(6, 16));
      const L = inView ? 0.0 : 1.6;
      const lead = [mid[0] - dir[0] * L, mid[1], mid[2] - dir[2] * L];
      const n = 2 * Math.floor(rand(3, 9)) + 1;
      const birds = [];
      for (let i = 0; i < n; i++) {
        birds.push({ sp: SPECIES.goose, pos: lead.slice(), vel: [0, 0, 0], phase: rand(0, 0.4), bank: 0, alpha: 1, idx: i });
      }
      return { birds, lead, dir, speed: 0.017, age: 0, maxAge: (2 * 1.6 + 0.6) / 0.017 };
    }

    // ------------------------------------------------------------ update
    update(dt, state, view) {
      this._view = view;
      this.state = state;
      this.t += dt;
      // In short steps, so birds keep real time and keep arriving even when frames are seconds apart
      if (dt > 0) {
        const steps = Math.min(Math.ceil(dt / 0.1), 300);
        const step = Math.min(dt / steps, 0.1);
        for (let i = 0; i < steps; i++) this._step(step, state);
      }
      this._write(state);
    }

    _step(dt, state) {
      const a = state.astro;
      const w = state.weather;
      const sunAlt = a.sunAltDeg;
      const daylight = smooth(-5, 3, sunAlt);
      const shelter = (1 - smooth(0.1, 0.4, w.rain)) * (1 - smooth(0.35, 0.75, w.fog)) * (1 - w.storm) * (1 - smooth(0.2, 0.6, w.snow));
      // Turned off: the birds go at once rather than flying away, since that is what was asked
      if (!this.birds) {
        this.raptors = [];
        this.flock = null;
        this.geese = null;
      }
      const birdOK = this.enabled && this.birds ? daylight * shelter : 0;
      const thermals = smooth(14, 32, sunAlt) * (1 - 0.85 * w.overcast) * (1 - smooth(28, 50, w.windSpeed));
      // dawn/dusk activity for small birds
      let dawnDusk = 0;
      const tm = a.times || {};
      if (tm.sunrise && tm.sunset) {
        const now = state.now.getTime();
        const hS = (now - tm.sunrise.getTime()) / 3600e3;
        const hE = (tm.sunset.getTime() - now) / 3600e3;
        dawnDusk = Math.max(Math.exp(-((hS - 1) ** 2) / 2), Math.exp(-((hE - 1) ** 2) / 2));
      }

      // ---- raptors ----
      const raptorTarget = Math.round(4 * birdOK * thermals * (0.6 + 0.4 * Math.sin(this.t / 600)));
      this._nextRaptorCheck -= dt;
      if (this._nextRaptorCheck <= 0) {
        this._nextRaptorCheck = rand(20, 60);
        const active = this.raptors.filter((r) => r.mode !== 'leave').length;
        if (active < raptorTarget) this.raptors.push(this._newRaptor(false));
        else if (active > raptorTarget) {
          const r = this.raptors.find((x) => x.mode !== 'leave');
          if (r) this._leave(r);
        }
      }
      for (const r of this.raptors) this._stepRaptor(r, dt, state);
      this.raptors = this.raptors.filter((r) => !r.dead);

      // ---- chough flock ----
      const flockRate = birdOK * (0.25 + 0.75 * dawnDusk);
      if (!this.flock) {
        this._nextFlock -= dt * Math.max(flockRate, 0.0);
        if (this._nextFlock <= 0 && flockRate > 0.15) {
          this.flock = this._newFlock(false);
          this._nextFlock = rand(150, 420);
        }
      } else {
        if (birdOK < 0.2) this.flock.leaving = true;
        this._stepFlock(this.flock, dt);
        if (this.flock.dead) this.flock = null;
      }

      // ---- migrating geese / cranes ----
      if (!this.geese) {
        const doy = a.dayOfYear;
        const season = (doy >= 255 && doy <= 340) || (doy >= 55 && doy <= 125);
        this._nextGeese -= dt * birdOK * (sunAlt > 2 ? 1 : 0);
        if (this._nextGeese <= 0) {
          this.geese = this._newGeese(state, false);
          this._nextGeese = season ? rand(900, 2400) : rand(5400, 14400);
        }
      } else {
        this._stepGeese(this.geese, dt);
        if (this.geese.dead) this.geese = null;
      }

      // ---- chimney smoke, meteors, satellites, the road ----
      this._stepTraffic(dt, state);
      this._stepSmoke(dt, state);
      this._stepMeteors(dt, state);
      this._stepSatellites(dt, state);
    }

    _leave(b) {
      b.mode = 'leave';
      b.target = this._exitPoint(b.pos);
    }

    _stepRaptor(r, dt, state) {
      const w = state.weather;
      const sp = 0.0125;
      if (r.mode === 'circle') {
        r.theta += r.omega * dt;
        // thermals drift downwind and lift the bird slowly
        r.center[0] += state.windVel[0] * 0.3 * dt;
        r.center[1] += state.windVel[2] * 0.3 * dt;
        const cd = Math.hypot(r.center[0], r.center[1]);
        r.y = Math.min(r.y + 0.0012 * dt, this._view.camY + cd * Math.tan(18 * D2R));
        const nx = r.center[0] + Math.cos(r.theta) * r.R;
        const nz = r.center[1] + Math.sin(r.theta) * r.R;
        r.vel = [(nx - r.pos[0]) / dt, (r.y - r.pos[1]) / dt, (nz - r.pos[2]) / dt];
        r.pos = [nx, r.y, nz];
        r.bank = Math.sign(r.omega) * Math.atan((sp * sp) / (G * r.R));
        r.circleTime -= dt;
        if (r.circleTime <= 0) {
          if (Math.random() < 0.5) this._leave(r);
          else {
            r.mode = 'glide';
            r.target = this._pointInView(rand(-0.8, 0.8), rand(0.15, 0.6), rand(-3, 12));
          }
        }
      } else {
        const tg = r.target;
        const dx = tg[0] - r.pos[0];
        const dy = tg[1] - r.pos[1];
        const dz = tg[2] - r.pos[2];
        const d = Math.hypot(dx, dz);
        const speed = r.mode === 'leave' ? sp * 1.3 : sp * 1.1;
        const vx = (dx / Math.max(d, 1e-6)) * speed;
        const vz = (dz / Math.max(d, 1e-6)) * speed;
        // smooth turning
        const k = 1 - Math.exp(-dt * 0.6);
        r.vel[0] += (vx - r.vel[0]) * k;
        r.vel[2] += (vz - r.vel[2]) * k;
        r.vel[1] = clamp(dy * 0.05, -0.001, 0.0008);
        r.pos[0] += r.vel[0] * dt;
        r.pos[1] += r.vel[1] * dt;
        r.pos[2] += r.vel[2] * dt;
        r.bank *= Math.exp(-dt);
        if (r.mode === 'glide' && d < 0.04) {
          r.mode = 'circle';
          r.center = [tg[0], tg[2]];
          r.y = r.pos[1];
          r.R = rand(0.035, 0.09);
          r.theta = Math.atan2(r.pos[2] - tg[2], r.pos[0] - tg[0]);
          r.omega = (Math.random() < 0.5 ? -1 : 1) * (sp / r.R);
          r.circleTime = rand(60, 220);
        }
        if (r.mode === 'leave' && !this._inView(this._project(...r.pos), 80) && d < 0.15) r.dead = true;
        if (r.mode === 'leave' && d < 0.02) r.dead = true;
      }
      // occasional bursts of heavy wingbeats, otherwise soaring on still wings
      r.nextFlap -= dt;
      if (r.nextFlap <= 0) {
        r.flapLeft = rand(1.2, 2.4);
        r.nextFlap = rand(15, 45);
      }
      if (r.flapLeft > 0) {
        r.flapLeft -= dt;
        r.phase += TAU * r.sp.flapHz * dt;
        r.amp = Math.min(1, (r.amp || 0) + dt * 4);
      } else {
        r.amp = Math.max(0, (r.amp || 0) - dt * 2);
        r.phase = r.phase % TAU;
      }
      r.alpha = Math.min(1, r.alpha + dt * 0.5);
      r.dihedral = 0.1;
    }

    _stepFlock(f, dt) {
      const birds = f.birds;
      f.life -= dt;
      f.retarget -= dt;
      if (!f.leaving && f.life <= 0) f.leaving = true;
      if (f.leaving && !f.exit) f.exit = this._exitPoint(f.target);
      if (!f.leaving && f.retarget <= 0) {
        f.retarget = rand(3, 8);
        f.target = this._pointInView(rand(-0.7, 0.7), rand(0.06, 0.24), rand(-4, 13));
      }
      const tg = f.leaving ? f.exit : f.target;
      const cen = [0, 0, 0];
      const avg = [0, 0, 0];
      for (const b of birds) for (let i = 0; i < 3; i++) {
        cen[i] += b.pos[i] / birds.length;
        avg[i] += b.vel[i] / birds.length;
      }
      let anyVisible = false;
      for (const b of birds) {
        const acc = [0, 0, 0];
        for (let i = 0; i < 3; i++) {
          acc[i] += (cen[i] - b.pos[i]) * 0.25 + (avg[i] - b.vel[i]) * 0.8 + (tg[i] - b.pos[i]) * (f.leaving ? 0.12 : 0.06);
        }
        for (const o of birds) {
          if (o === b) continue;
          const dx = b.pos[0] - o.pos[0];
          const dy = b.pos[1] - o.pos[1];
          const dz = b.pos[2] - o.pos[2];
          const d2 = dx * dx + dy * dy + dz * dz;
          if (d2 < 0.00006 && d2 > 1e-12) {
            const k = 0.000004 / d2;
            acc[0] += dx * k;
            acc[1] += dy * k;
            acc[2] += dz * k;
          }
        }
        acc[0] += rand(-0.002, 0.002);
        acc[1] += rand(-0.001, 0.001);
        acc[2] += rand(-0.002, 0.002);
        for (let i = 0; i < 3; i++) b.vel[i] += acc[i] * dt;
        const sp = Math.hypot(b.vel[0], b.vel[1], b.vel[2]);
        const tgtSp = clamp(sp, 0.008, 0.017);
        for (let i = 0; i < 3; i++) b.vel[i] *= tgtSp / Math.max(sp, 1e-6);
        b.vel[1] = clamp(b.vel[1], -0.006, 0.004);
        for (let i = 0; i < 3; i++) b.pos[i] += b.vel[i] * dt;
        // turning banks the bird into the curve
        const turn = (b.vel[0] * acc[2] - b.vel[2] * acc[0]) / Math.max(sp * sp, 1e-6);
        b.bank += (clamp(turn * 0.03, -0.9, 0.9) - b.bank) * (1 - Math.exp(-dt * 3));
        // flap bursts and short glides
        b.stateLeft -= dt;
        if (b.stateLeft <= 0) {
          b.flapping = !b.flapping;
          b.stateLeft = b.flapping ? rand(0.4, 1.3) : rand(0.25, 0.9);
        }
        if (b.flapping) {
          b.phase += TAU * b.sp.flapHz * dt;
          b.amp = Math.min(1, (b.amp || 0) + dt * 6);
        } else b.amp = Math.max(0.08, (b.amp || 0) - dt * 5);
        b.dihedral = b.flapping ? 0 : -0.05;
        b.alpha = Math.min(1, b.alpha + dt * 0.8);
        if (this._inView(this._project(...b.pos), 60)) anyVisible = true;
      }
      if (f.leaving && !anyVisible) f.dead = true;
    }

    _stepGeese(g, dt) {
      g.age += dt;
      g.lead = [g.lead[0] + g.dir[0] * g.speed * dt, g.lead[1] + 0.0001 * Math.sin(g.age * 0.3) * dt, g.lead[2] + g.dir[2] * g.speed * dt];
      const perp = [g.dir[2], 0, -g.dir[0]];
      for (const b of g.birds) {
        const i = b.idx;
        const rank = Math.ceil(i / 2);
        const side = i % 2 === 1 ? 1 : -1;
        const wob = Math.sin(g.age * 0.7 + i * 1.3) * 0.0015;
        b.pos = [
          g.lead[0] - g.dir[0] * rank * 0.011 + perp[0] * side * rank * (0.0085 + wob),
          g.lead[1] - rank * 0.0007 + Math.sin(g.age * 0.9 + i) * 0.0006,
          g.lead[2] - g.dir[2] * rank * 0.011 + perp[2] * side * rank * (0.0085 + wob),
        ];
        b.vel = [g.dir[0] * g.speed, 0, g.dir[2] * g.speed];
        b.phase += TAU * b.sp.flapHz * dt * (1 + 0.04 * Math.sin(i));
        b.amp = 0.85;
        b.dihedral = 0.02;
      }
      if (g.age > g.maxAge) g.dead = true;
    }

    // ------------------------------------------------------------ the road
    /** How many vehicles the road holds now: by the hour, and fewer when the weather is bad. */
    _trafficWanted(state) {
      if (!this.enabled || !this.road) return 0;
      const h = state.now.getHours() + state.now.getMinutes() / 60;
      const w = state.weather;
      const byHour = 0.08 + 0.92 * smooth(4.5, 7.5, h) * (1 - smooth(19.5, 23.5, h));
      const byWeather = (1 - 0.6 * smooth(0.2, 0.7, w.snow)) * (1 - 0.5 * smooth(0.3, 0.8, w.fog)) * (1 - 0.4 * w.storm);
      return Math.round(TRAFFIC_MAX * (TRAFFIC[this.traffic] || 1) * byHour * byWeather);
    }

    /** A point of the road inside the picture. */
    _roadInView() {
      const road = this.road;
      for (let tries = 0; tries < 40; tries++) {
        const s = rand(0, road.length);
        const i = Math.floor(s / road.step);
        if (Math.abs(Math.atan2(road.x[i], road.z[i])) < this._view.hfov * 0.42) return s;
      }
      return road.length / 2;
    }

    _newVehicle(kind, dir, s) {
      const k = VEHICLES[kind];
      const paints = k.paints;
      const bend = k.bend * rand(0.92, 1.08);
      // it comes in no faster than the bend where it appears allows (it used to come into a hairpin at 70% of its
      // cruising speed and brake hard through it)
      const road = this.road;
      const here = road && road.limit ? road.limit[Math.max(0, Math.min(Math.round(s / road.step), road.n - 1))] * bend : Infinity;
      return {
        kind,
        code: k.code,
        dir,
        s,
        len: k.len * SIZE_ON_SCREEN,
        wid: k.wid * SIZE_ON_SCREEN,
        hgt: k.hgt * SIZE_ON_SCREEN,
        // and every driver a little their own way
        cruise: k.cruise * rand(0.85, 1.15),
        bend,
        accel: k.accel * rand(0.85, 1.15),
        v: Math.min(k.cruise * 0.7, here),
        paint: paints[Math.floor(Math.random() * paints.length)],
        lane: k.lane,
        side: 0, // 0 its own lane, 1 out in the other to overtake, below 0 pulled in to the edge
        sideTarget: 0,
        pass: null, // the overtaking under way
        cool: rand(3, 12), // seconds before it may think of overtaking
        stopIn: kind === 'bus' ? rand(0.4, 3) : Infinity, // km to its next stop
        stopping: false,
        stopFor: 0,
        blink: 0,
        blinkFor: 0,
        brake: 0,
        brakeHold: 0, // seconds the brake lights stay on, so small changes of speed don't make them flicker
        beam: 1, // 1 main beam, 0 dipped
        flash: 0, // seconds left of a double flash of the main beam
        flashedAt: -1,
        seed: Math.random(),
      };
    }

    /** How far left of the centre line it drives, in km: its own lane, out to overtake, or in at a stop. */
    _offset(c) {
      return c.side >= 0 ? c.lane + (-PASS_LANE - c.lane) * c.side : c.lane * (1 - c.side);
    }

    /** Headlights come on as the light goes, and in thick weather. */
    _lightsLevel(state) {
      const w = state.weather;
      return Math.max(1 - smooth(-4, 3, state.astro.sunAltDeg), smooth(0.35, 0.7, Math.max(w.fog, w.rain, w.snow)) * 0.8);
    }

    _signal(c, blink, seconds = 2.5) {
      c.blink = blink;
      c.blinkFor = seconds;
    }

    _pickVehicleKind() {
      const x = Math.random();
      return x < 0.25 ? 'bus' : x < 0.65 ? 'jeep' : 'motorcycle';
    }

    /**
     * Drives an overtake ahead of time along the road. It signals and moves out (2.5 s, keeping their pace), then
     * picks up speed towards its passing speed, held down on the bends, until it has gained `gain` km on the slow ones;
     * they go at `lineV` at most, and slow on the bends too (as well as `lineBend` lets them; `lead` km ahead of it is
     * the front of them). Then it needs 30 m more to get back in. Returns the road it takes and the time (s), or null
     * where it should not go: the road ends, a bend it can't see round, a bend where it would hardly gain on them and sit
     * beside them, or a pass that would take too long.
     */
    _planPass(c, gain, lead, lineV, lineBend, vPass) {
      const road = this.road;
      const STEP = 0.5;
      const OUT = 2.5;
      const limitAt = (d) => {
        const s = c.s + c.dir * d;
        return s <= 0 || s >= road.length ? -1 : road.limit[clamp(Math.round(s / road.step), 0, road.n - 1)];
      };
      let x = lineV * OUT; // its way along the road
      let y = x; // theirs
      let v = c.v;
      let t = OUT;
      while (x - y < gain) {
        const lim = limitAt(x);
        if (lim < PASS_BLIND) return null;
        const u = Math.min(vPass, lim * c.bend);
        const w = Math.min(lineV, Math.max(limitAt(y + lead), 0) * lineBend);
        if (u < w + PASS_GAIN * 0.5) return null;
        v = v < u ? Math.min(v + c.accel * STEP, u) : Math.max(v - 2.4e-3 * STEP, u);
        x += v * STEP;
        y += w * STEP;
        t += STEP;
        if (t > PASS_TIME) return null;
      }
      for (let d = x; d < x + 0.03; d += road.step) if (limitAt(d) < PASS_BLIND) return null;
      return { reach: x + 0.03, time: t };
    }

    _stepTraffic(dt, state) {
      const road = this.road;
      if (!road) return;
      const want = this._trafficWanted(state);
      // the road isn't empty when the picture first appears
      if (!this._trafficSeeded && this._view) {
        this._trafficSeeded = true;
        for (let i = 0; i < want; i++) {
          const dir = Math.random() < 0.5 ? 1 : -1;
          for (let tries = 0; tries < 20; tries++) {
            const s = rand(0.02, road.length - 0.02);
            if (this.vehicles.every((o) => o.dir !== dir || Math.abs(o.s - s) > 0.05)) {
              this.vehicles.push(this._newVehicle(this._pickVehicleKind(), dir, s));
              break;
            }
          }
        }
      }
      this._nextVehicle -= dt;
      if (this._nextVehicle <= 0) {
        this._nextVehicle = rand(6, 45) / (TRAFFIC[this.traffic] || 1);
        if (this.vehicles.length < want) {
          const dir = Math.random() < 0.5 ? 1 : -1;
          const s = dir > 0 ? 0.001 : road.length - 0.001;
          // clear in its lane: nothing near going its way, nor overtaking towards the end of the road in it
          if (this.vehicles.every((o) => (o.dir !== dir && o.side < 0.3) || Math.abs(o.s - s) > 0.06)) this.vehicles.push(this._newVehicle(this._pickVehicleKind(), dir, s));
        }
      }
      const w = state.weather;
      const careful = 1 - 0.3 * smooth(0.1, 0.6, Math.max(w.rain, w.snow, w.fog));
      const night = this._lightsLevel(state) > 0.3;
      const idx = (s) => clamp(Math.round(s / road.step), 0, road.n - 1);
      // which lanes it takes up: its own below 0.7, the other above 0.3, both while it moves across
      const inOwn = (c) => c.side < 0.7;
      const inOut = (c) => c.side > 0.3;
      for (const c of this.vehicles) {
        const i = idx(c.s);
        const cruise = Math.min(c.cruise * careful, road.limit[i] * c.bend);
        let target = cruise;
        // what is around it: the nearest in front in each lane, and the nearest coming the other way
        let ahead = null; // in its own lane
        let aheadGap = 1e9;
        let aheadOut = null; // in the other lane
        let outGap = 1e9;
        let onGap = 1e9; // anything coming, in either lane: for the beams and for overtaking
        let headOn = 1e9; // coming the other way in a lane it takes up now
        let mirror = true; // nobody beside it or coming up behind in the other lane
        let passedBy = false; // someone is out overtaking it
        let beside = null; // alongside it in its own lane: it can't move back in there
        for (const o of this.vehicles) {
          if (o === c) continue;
          if (o.dir === c.dir && inOwn(o) && Math.abs(o.s - c.s) < (o.len + c.len) / 2 + 0.004) beside = o;
          if (o.pass && o.pass.of === c && o.pass.phase === 1) passedBy = true;
          const gap = (o.s - c.s) * c.dir - (o.len + c.len) / 2;
          if (o.dir === c.dir && inOut(o) && gap < 0.004 && gap > -(o.len + c.len) - 0.04) mirror = false;
          if (o.dir !== c.dir && inOwn(o) && Math.abs(o.s - c.s) < (o.len + c.len) / 2 + 0.006) mirror = false; // alongside, coming
          if (gap <= 0) continue;
          if (o.dir === c.dir) {
            if (inOwn(o) && gap < aheadGap) {
              ahead = o;
              aheadGap = gap;
            }
            if (inOut(o) && gap < outGap) {
              aheadOut = o;
              outGap = gap;
            }
          } else {
            onGap = Math.min(onGap, gap);
            // the other's own lane is the far lane for this one
            if ((inOwn(o) && inOut(c)) || (inOut(o) && inOwn(c))) headOn = Math.min(headOn, gap);
          }
        }
        // keeps its distance from the one in front, in each lane it takes up
        const follow = (o, gap) => {
          if (!o || gap > 0.12) return;
          // never faster than it could slow to the other's speed from, in the room there is: a fast motorcycle coming up
          // on a bus at a stop starts braking in time
          target = Math.min(target, Math.sqrt(o.v * o.v + 2 * 1.8e-3 * Math.max(gap - 0.008, 0)));
          if (gap < 0.012 + c.v * 2) target = Math.min(target, o.v * 0.95);
          if (gap < 0.006) target = 0;
        };
        if (inOwn(c)) follow(ahead, aheadGap);
        if (inOut(c)) follow(aheadOut, outGap);
        // one overtaking towards it in its lane: slow down, and stop if it must
        if (!inOut(c) && headOn < 0.06) target = Math.min(target, headOn < 0.02 ? 0 : cruise * 0.5);
        // being overtaken: a courteous driver does not speed up meanwhile
        if (passedBy) target = Math.min(target, Math.max(c.v, 1e-4));
        // out overtaking with something coming: slow down too, so it can drop back in behind
        if (inOut(c) && headOn < 0.04) target = Math.min(target, headOn < 0.015 ? 0 : cruise * 0.4);

        // ---- a bus stop: pull in, hazard lights while it waits, indicate and pull out
        if (c.kind === 'bus' && !c.pass) {
          c.stopIn -= c.v * dt;
          if (c.stopIn <= 0 && !c.stopping && c.stopFor <= 0 && road.limit[i] > 0.007 && c.s > 0.2 && c.s < road.length - 0.2) {
            c.stopping = true;
            c.sideTarget = -0.5;
            this._signal(c, BLINK_LEFT, 99);
          }
          if (c.stopping) {
            target = 0;
            if (c.v < 0.0003) {
              c.stopping = false;
              c.stopFor = rand(12, 40);
              this._signal(c, BLINK_BOTH, 99);
            }
          } else if (c.stopFor > 0) {
            target = 0;
            c.stopFor -= dt;
            if (c.stopFor < 3 && c.blink === BLINK_BOTH) this._signal(c, BLINK_RIGHT, 99);
            if (c.stopFor <= 0 && headOn > 0.03) {
              c.sideTarget = 0;
              c.stopIn = rand(1.5, 4);
              this._signal(c, BLINK_RIGHT, 2);
            } else if (c.stopFor <= 0) c.stopFor = 0.5; // something is passing it: wait a moment more
          }
        }

        // ---- overtaking a slower one, or a line of them, where it can see the road ahead and nothing is coming. Any
        // faster vehicle that has caught up looks for its chance and takes it as soon as the way is clear: it never sits
        // for minutes behind a bus on an empty road. What stops it are the things that would cause a crash: something
        // coming, someone already out beside it, no room to get back in, a bend it can't see round.
        c.cool -= dt;
        // it starts looking once it has caught up: a little further out than it keeps its distance
        if (!c.pass && c.cool <= 0 && mirror && ahead && aheadGap < 0.02 + c.v * 3 && c.side < 0.05 && !c.stopping && c.stopFor <= 0) {
          const vPass = Math.min(c.cruise * careful * 1.15, V_PASS);
          // holding it back: slower than it would go here, or standing at a stop
          const parked = (o) => o.stopFor > 0 || o.stopping;
          const slow = (o) => parked(o) || o.v < Math.min(cruise * 0.9, vPass - PASS_GAIN);
          // the line it would pass: the one in front, and any slow one too close beyond it to get back in between,
          // up to three, then room after the last
          let last = ahead;
          let lineV = parked(ahead) ? 0 : ahead.v;
          let lineBend = ahead.bend;
          let ok = slow(ahead) && !ahead.pass;
          for (let n = 1; ok; n++) {
            let next = null;
            let g = 1e9;
            for (const o of this.vehicles) {
              if (o === c || o === last || o.dir !== c.dir || !inOwn(o)) continue;
              const og = (o.s - last.s) * c.dir - (o.len + last.len) / 2;
              if (og > 0 && og < g) {
                next = o;
                g = og;
              }
            }
            // room to get back in before the next: enough to slow to its pace too (a bus standing at a stop needs most)
            if (!next || g > Math.max(PASS_ROOM, cutInRoom(vPass, next) + 0.02)) break;
            if (n >= 3 || next.pass || !slow(next)) ok = false;
            else {
              last = next;
              lineV = Math.max(lineV, parked(next) ? 0 : next.v);
              lineBend = Math.max(lineBend, next.bend);
            }
          }
          if (ok && vPass - lineV >= PASS_GAIN) {
            // ground to gain to be clear in front of the last of them
            const gain = (last.s - c.s) * c.dir + (last.len + c.len) / 2 + 0.02;
            const pass = this._planPass(c, gain, (last.s - c.s) * c.dir, lineV, lineBend, vPass);
            // what comes the other way covers ground meanwhile too, each at up to its own speed
            const clear =
              pass &&
              this.vehicles.every((o) => {
                if (o.dir === c.dir) return true;
                const g = (o.s - c.s) * c.dir - (o.len + c.len) / 2;
                const oV = Math.max(o.v, o.cruise);
                return g <= 0 || g > pass.reach + oV * pass.time + 0.06 + (vPass + oV) * PASS_SPARE;
              });
            if (clear) {
              c.pass = { of: ahead, phase: 0, wait: 1.5, vPass };
              this._signal(c, BLINK_RIGHT, 99);
              if (night) c.flash = 1.2; // "coming past"
            } else c.cool = rand(1.5, 4); // not here, not now: it keeps watching for a chance
          } else c.cool = rand(1.5, 4);
        }
        if (c.pass) {
          const p = c.pass;
          const of = p.of;
          const gone = !this.vehicles.includes(of);
          const behindBy = gone ? -1 : (of.s - c.s) * c.dir + (of.len + c.len) / 2; // still to gain to be clear of its front
          if (p.phase === 0) {
            // signalling, then out
            p.wait -= dt;
            if (!mirror) p.wait = Math.max(p.wait, 0.3); // someone is passing it: wait
            if (onGap < 0.15) p.phase = 3;
            else if (p.wait <= 0) p.phase = 1;
          } else if (p.phase === 1) {
            c.sideTarget = 1;
            if (c.side > 0.5) {
              // its passing speed, as far as the bend allows it, and still behind anyone out ahead of it
              target = Math.min(p.vPass, road.limit[i] * c.bend);
              follow(aheadOut, outGap);
              if (headOn < 0.04) target = Math.min(target, headOn < 0.015 ? 0 : cruise * 0.4);
            }
            // how long until it is past: at the speed it is picking up to, not the one it pulled out at (still theirs)
            const vt = Math.max(Math.min(p.vPass, road.limit[i] * c.bend), c.v);
            const up = vt - c.v;
            const rest = (behindBy + 0.008 + (up * up) / (2 * c.accel)) / Math.max(vt - (gone ? 0 : of.v), 5e-4);
            // and anything coming in the lane it is out in, at up to its own speed, that would be there first
            const meets = () =>
              this.vehicles.some((o) => {
                if (o.dir === c.dir || !inOwn(o)) return false;
                const g = (o.s - c.s) * c.dir - (o.len + c.len) / 2;
                return g > 0 && g < (vt + Math.max(o.v, o.cruise)) * rest + 0.04;
              });
            p.out = (p.out || 0) + dt;
            if (p.out > 5 && !gone && c.v - of.v < 4e-4) p.phase = 3; // not gaining on it: give up
            if (c.side < 0.5 && !mirror) p.phase = 3; // someone came up in that lane after all
            const next = beside && beside !== of ? beside : ahead && ahead !== of && (ahead.s - c.s) * c.dir > 0 ? ahead : null;
            if (behindBy < -0.008 && (!next || (next !== beside && aheadGap > cutInRoom(c.v, next)))) {
              p.phase = 2; // past it, with room: back in
              c.sideTarget = 0;
              this._signal(c, BLINK_LEFT, 99);
            } else if (behindBy < -0.008) {
              p.of = next; // the next one is close: past that one too, as long as the way stays clear
              if (headOn < 0.12) {
                p.phase = 2; // no time: back in behind it
                c.sideTarget = 0;
                this._signal(c, BLINK_LEFT, 99);
              }
            } else if (meets()) {
              p.phase = 3; // something is coming after all: drop back
            }
          }
          if (p.phase === 2 && beside && c.side > 0.3) {
            // something alongside in its lane after all: stay out and pass that one as well
            p.phase = 1;
            p.of = beside;
            c.sideTarget = 1;
          }
          if (p.phase === 3) {
            // back behind it before moving in, slowing down meanwhile
            if ((behindBy > of.len + c.len + 0.003 || gone) && !beside) c.sideTarget = 0;
            if (!gone) target = Math.min(target, of.v * 0.7);
            if (c.blink !== BLINK_LEFT) this._signal(c, BLINK_LEFT, 99);
          }
          if ((p.phase === 2 || p.phase === 3) && c.sideTarget === 0 && c.side < 0.03) {
            c.pass = null;
            c.blinkFor = 0.8;
            c.cool = rand(3, 10); // a breath before it looks again: the next slow one may be just ahead
          }
        }

        // ---- lights: main beam on an empty road, dipped for anyone near, a double flash before a blind hairpin
        if (night) {
          const dip = onGap < 0.25 || (ahead && aheadGap < 0.1);
          c.beam += clamp((dip ? 0 : 1) - c.beam, -dt * 6, dt * 6);
          const j = idx(c.s + c.dir * 0.07);
          if (road.limit[j] < 0.0045 && road.limit[j] < road.limit[i] * 0.6 && Math.abs(c.s - c.flashedAt) > 0.25) {
            c.flashedAt = c.s;
            c.flash = 1.2;
          }
        }
        c.flash = Math.max(c.flash - dt, 0);
        if (c.blinkFor < 50) {
          c.blinkFor -= dt;
          if (c.blinkFor <= 0) c.blink = 0;
        }

        // ---- speed, braking, and the move across the road
        const dv = c.accel * dt;
        // braking: a real slowing down (about 3 km/h below its speed), or standing still. Held a moment, as a driver
        // keeps a foot on the pedal, instead of flickering with every small change of speed.
        if (target < c.v - 8e-4 || (c.v < 3e-4 && target < 1e-4)) c.brakeHold = 1.2;
        else c.brakeHold = Math.max(c.brakeHold - dt, 0);
        c.brake += clamp((c.brakeHold > 0 ? 1 : 0) - c.brake, -dt * 4, dt * 8);
        c.v += clamp(target - c.v, -2.4e-3 * dt, dv); // all brake alike; they pick up speed their own way
        c.s += c.dir * c.v * dt;
        c.side += clamp(c.sideTarget - c.side, -dt * 0.5, dt * 0.5); // a lane in two seconds
      }
      this.vehicles = this.vehicles.filter((c) => c.s > 0 && c.s < road.length);
    }

    _pushVehicle(c, lights) {
      const v = this._view;
      const road = this.road;
      const R = LE.Road;
      const off = -c.dir * this._offset(c); // left of its own direction, unless it is out overtaking
      const p = R.at(road, c.s, off, TMP[0]);
      const pr = this._project(p[0], p[1], p[2]);
      if (!this._inView(pr, 30)) return;
      const f = R.at(road, c.s + (c.dir * c.len) / 2, off, TMP[1]);
      const b = R.at(road, c.s - (c.dir * c.len) / 2, off, TMP[2]);
      const pf = this._project(f[0], f[1], f[2]);
      const pb = this._project(b[0], b[1], b[2]);
      const fx = f[0] - b[0];
      const fy = f[1] - b[1];
      const fz = f[2] - b[2];
      const fl = Math.hypot(fx, fy, fz) || 1;
      const flat = Math.hypot(fx, fz) || 1;
      const hw = c.wid / 2;
      const ps = this._project(p[0] + (fz / flat) * hw, p[1], p[2] - (fx / flat) * hw);
      const ax = (pf.sx - pb.sx) / 2;
      const ay = (pf.sy - pb.sy) / 2;
      const bx = ps.sx - pr.sx; // towards its right side
      const by = ps.sy - pr.sy;
      const halfH = Math.max(c.hgt / pr.r / v.pxAng, 0.9) / 2;
      const toCam = [-p[0], v.camY - p[1], -p[2]];
      const dist = Math.hypot(toCam[0], toCam[1], toCam[2]);
      const facing = (fx * toCam[0] + fy * toCam[1] + fz * toCam[2]) / (fl * dist);
      // a flash of the main beam shows by day as well
      const flashing = c.flash > 0.85 || (c.flash > 0.25 && c.flash < 0.6) ? 1 : 0;
      const lampOn = Math.max(lights, flashing * 0.6);
      const lamp = lampOn * R.headlight(facing);
      const beam = Math.max(c.beam, flashing);
      // tail lights: on whenever the headlights are, and brighter when braking, by day as well
      const rear = R.taillight(facing);
      const tail = rear * Math.max(lights * 0.5, c.brake * (0.3 + 0.7 * lights)); // by day a brake light is a small red point
      const braking = rear * c.brake;
      const blinkLit = c.blink && ((this.t * 1.4 + c.seed) % 1) < 0.55 ? c.blink : 0;
      let qx = Math.abs(ax) + Math.abs(bx) + 1.5;
      let qy = Math.abs(ay) + Math.abs(by) + halfH + 1.5;
      // room for the whole glow, so it fades out before the edge of the patch it is drawn on
      if (lamp > 0.003) {
        qx = Math.max(qx, Math.abs(ax) + Math.abs(bx) + 12 + 8 * beam);
        qy = Math.max(qy, Math.abs(ay) + Math.abs(by) + halfH + 12 + 8 * beam);
      }
      if (tail > 0.003 || blinkLit) {
        qx = Math.max(qx, Math.abs(ax) + Math.abs(bx) + 12);
        qy = Math.max(qy, Math.abs(ay) + Math.abs(by) + halfH + 12);
      }
      // the light it throws on the road and the trees ahead: seen from any side, so before the vehicle itself
      if (lights > 0.02) this._pushBeam(c, f, [fx / fl, fy / fl, fz / fl], lights, beam, dist);
      this._push([
        pr.sx, pr.sy + halfH, qx, qy,
        0, 6, 1, dist,
        ax, ay, bx, by,
        halfH, c.paint, lamp, c.code,
        tail, beam, blinkLit, braking,
      ]);
    }

    /** Type 7: the patch of light ahead of a vehicle, longer and narrower on main beam, small for a motorcycle. */
    _pushBeam(c, front, fwd, lights, beam, dist) {
      const k = VEHICLES[c.kind];
      const lampP = [front[0], front[1] + k.lampH, front[2]];
      const range = k.low + (k.high - k.low) * beam;
      const cone = k.cone + (1 - k.cone) * 0.45 * beam;
      // the light fades to nothing at this angle off its axis: the same as the shader
      const outer = Math.max(cone - 0.22, 0.35);
      const spread = Math.sqrt(1 - outer * outer) / outer;
      const sl = Math.hypot(fwd[0], fwd[2]) || 1;
      const rx = fwd[2] / sl;
      const rz = -fwd[0] / sl;
      let x0 = 1e9;
      let x1 = -1e9;
      let y0 = 1e9;
      let y1 = -1e9;
      // everything it can light: the road, and the slope falling away below it or rising with its trees above it
      for (const along of [0, 0.25, 0.5, 0.75, 1]) {
        const half = range * along * spread + 0.004;
        for (const across of [-half, 0, half]) {
          for (const up of [-k.lampH - 0.03, 0.02]) {
            const q = this._project(lampP[0] + fwd[0] * range * along + rx * across, lampP[1] + fwd[1] * range * along + up, lampP[2] + fwd[2] * range * along + rz * across);
            x0 = Math.min(x0, q.sx);
            x1 = Math.max(x1, q.sx);
            y0 = Math.min(y0, q.sy);
            y1 = Math.max(y1, q.sy);
          }
        }
      }
      const v = this._view;
      if (x1 < -10 || x0 > v.w + 10 || y1 < -10 || y0 > v.h + 10) return;
      const w = this.state ? this.state.weather : { fog: 0, rain: 0, snow: 0 };
      const haze = Math.max(w.fog, w.rain * 0.7, w.snow * 0.8);
      this._push([
        (x0 + x1) / 2, (y0 + y1) / 2, (x1 - x0) / 2 + 6, (y1 - y0) / 2 + 6,
        0, 7, lights * k.power * (0.8 + 0.7 * beam), dist,
        lampP[0], lampP[1], lampP[2], range,
        fwd[0], fwd[1], fwd[2], cone,
        haze, 0, 0, 0,
      ]);
    }

    /** Is this kind of smoke or mist turned on? (Anything else: yes.) */
    _smokeOn(kind) {
      if (kind === SMOKE.mist) return this.enabled && this.mist;
      if (kind === SMOKE.village) return this.enabled && this.villageSmoke;
      if (kind === SMOKE.fire) return this.enabled && this.fires;
      return true;
    }

    _stepSmoke(realDt, state) {
      const dt = realDt * this.pace;
      const a = state.astro;
      const w = state.weather;
      const h = state.now.getHours() + state.now.getMinutes() / 60;
      // smoke and mist are blown apart by a strong wind, washed out by heavy rain, and hidden in thick fog
      const calm = (1 - smooth(25, 45, w.windSpeed)) * (1 - smooth(0.3, 0.7, w.fog));

      // ---- village smoke. Each village keeps its own hours: one cooks early and one late, one keeps a fire in all day
      // and one lights it only for meals, more of them in the cold months, and a few keep one in through the night. Its
      // mind about it drifts slowly through the day, each on its own beat. So around the cooking times the villages light
      // their fires one after another across the valley and let them die down one by one after, and through the day
      // some smoke for a while and then not: never all together, and never flickering (a fire once lit burns at least
      // eight minutes, and a margin each way keeps one from going on and off). Room is left for the mist: the volume pass
      // draws 16 at most.
      const winter = 0.8 + 0.2 * Math.cos((2 * Math.PI * (a.dayOfYear - 15)) / 365);
      const allow = (this._smokeOn(SMOKE.village) ? 1 : 0) * winter * calm * (1 - smooth(0.05, 0.3, w.rain));
      const misty = Math.min(8, this.smoke.filter((s) => s.kind === SMOKE.mist && !s.fading).length);
      const room = Math.min(10, 15 - misty);
      const T = state.now.getTime() / 1000;
      for (const src of this.smokeSources) {
        let k = src.habit;
        if (!k) {
          const wake = rand(5.2, 6.6); // up with the light, or well before it
          k = src.habit = {
            wake,
            sleep: rand(21, 23),
            morning: wake + rand(0.4, 1.3),
            evening: 18.3 + rand(-0.6, 0.7),
            day: rand(0.2, 0.85),
            night: Math.random() < 0.3 ? rand(0.1, 0.45) : 0,
            beat: [rand(2400, 7200), rand(900, 2000), rand(0, 2 * Math.PI), rand(0, 2 * Math.PI)],
          };
        }
        const awake = smooth(k.wake - 0.3, k.wake + 0.3, h) * (1 - smooth(k.sleep - 0.5, k.sleep + 0.5, h));
        k.cook = Math.max(Math.exp(-((h - k.morning) ** 2) / 1.0), Math.exp(-((h - k.evening) ** 2) / 0.9));
        k.need = Math.min(1, 0.06 + k.day * awake + k.night * (1 - awake) + k.cook) * allow;
        k.bar = 0.45 + 0.22 * Math.sin((2 * Math.PI * T) / k.beat[0] + k.beat[2]) + 0.08 * Math.sin((2 * Math.PI * T) / k.beat[1] + k.beat[3]);
        k.want = k.need > k.bar;
      }
      const burning = this.smoke.filter((s) => s.kind === SMOKE.village && !s.fading && !s.held);
      const used = new Set(this.smoke.map((s) => s.src));
      this._nextHearth -= dt;
      if (!this._hearthsLit && this.smokeSources.length) {
        // When the scene first shows, the villages that would be smoking already are, each at its own stage: some just
        // lit and still climbing, some long going.
        this._hearthsLit = true;
        for (const src of this.smokeSources) {
          if (burning.length >= room || used.has(src) || !src.habit.want) continue;
          const s = this._newPlume(SMOKE.village, src);
          s.age = rand(0, 0.7) * s.life;
          s.alpha = s.target * Math.min(1, 0.3 + s.age / 200);
          this.smoke.push(s);
          burning.push(s);
        }
        this._nextHearth = rand(15, 75);
      } else if (this._nextHearth <= 0) {
        // one village at a time lights its fires, or lets them die down, a quarter of a minute to a minute or so apart
        const light = burning.length < room ? this.smokeSources.filter((src) => src.habit.need > src.habit.bar + 0.06 && !used.has(src)) : [];
        const out = burning.filter((s) => (s.src.habit.need < s.src.habit.bar - 0.06 && s.age > 480) || burning.length > room);
        const all = [...light.map((src) => ({ src })), ...out.map((s) => ({ s }))];
        if (all.length) {
          this._nextHearth = rand(15, 75);
          const pick = all[Math.floor(Math.random() * all.length)];
          if (pick.s) pick.s.fading = true;
          else this.smoke.push(this._newPlume(SMOKE.village, pick.src));
        }
      }
      for (const s of this.smoke) if (s.kind === SMOKE.village) s.fire = (0.25 + 0.25 * (s.src.habit ? s.src.habit.cook : 1)) * smooth(-2, -8, a.sunAltDeg);

      // ---- mist off the forest: when the air is humid or the canopy wet, most in the morning and the evening
      const tod = 0.55 + 0.45 * Math.max(Math.exp(-((h - 7.5) ** 2) / 4), Math.exp(-((h - 18) ** 2) / 3));
      const humid = Math.max(w.wet || 0, smooth(0.5, 0.95, w.mist || 0), 0.8 * smooth(0.05, 0.3, w.rain));
      const steamy = humid * (1 - smooth(0.6, 0.95, w.rain)) * calm;
      const wantMist = (this._smokeOn(SMOKE.mist) ? 1 : 0) * Math.round(Math.min(this.forestSources.length, 8) * steamy * tod);
      const wisps = this.smoke.filter((s) => s.kind === SMOKE.mist && !s.fading && !s.held).length;
      this._nextWisp -= dt;
      if (wisps < wantMist && this._nextWisp <= 0) {
        // one at a time, so they come and go here and there rather than all at once
        this._nextWisp = rand(8, 30);
        const s = this._newPlume(SMOKE.mist);
        if (s) this.smoke.push(s);
      } else if (wisps > wantMist) {
        const s = this.smoke.find((x) => x.kind === SMOKE.mist && !x.fading && !x.held);
        if (s) s.fading = true;
      }

      // ---- a field burning on a hill: now and then, more in the dry months, never in rain
      const dryMonths = 0.5 + 0.5 * Math.cos((2 * Math.PI * (a.dayOfYear - 60)) / 365);
      const dry = dryMonths * (1 - smooth(0.4, 0.9, w.mist || 0)) * (1 - (w.wet || 0)) * (1 - smooth(0.02, 0.2, w.rain));
      this._nextFire -= dt;
      if (this._nextFire <= 0) {
        this._nextFire = rand(2400, 9000);
        const burning = this.smoke.some((s) => s.kind === SMOKE.fire);
        if (this._smokeOn(SMOKE.fire) && !burning && h > 9 && h < 19.5 && Math.random() < 0.25 + 0.75 * dry) {
          const s = this._newPlume(SMOKE.fire);
          if (s) this.smoke.push(s);
        }
      }
      for (const s of this.smoke) if (s.kind === SMOKE.fire && w.rain > 0.3) s.fading = true; // put out by the rain

      // ---- each one grows, lives its time, and dissolves
      for (const s of this.smoke) {
        if (!this._smokeOn(s.kind)) s.fading = s.off = true; // turned off: gone in a minute or two, not burnt out slowly
        s.age += dt;
        s.t = (s.t || 0) + realDt; // real seconds, for its puffs: not hurried in the demo
        if (s.age > s.life && !(s.kind === SMOKE.village && !s.held)) s.fading = true;
        const goal = s.fading ? 0 : s.target * (s.kind === SMOKE.village ? 1 : calm);
        s.alpha += (goal - s.alpha) * (1 - Math.exp(-dt / (s.off ? Math.min(s.ease, 25) : s.fading && s.easeOut ? s.easeOut : s.ease)));
      }
      this.smoke = this.smoke.filter((s) => !(s.fading && s.alpha < 0.01));
    }

    /** A new plume of this kind at a free place for it, or null if there is none. */
    _newPlume(kind, at = null) {
      const list = at ? [at] : kind === SMOKE.village ? this.smokeSources : this.forestSources;
      const used = new Set(this.smoke.map((s) => s.src));
      let free = list.filter((s) => !used.has(s));
      if (!free.length) return null;
      if (kind !== SMOKE.village && this._view) {
        // A field on the slopes a few km off, where its smoke reads: one far across the valley is only a grey thread,
        // and one right below fills the view. Failing that, the forest nearest to 5 km. Mist within 7 km: further out
        // the valley mist takes over, and a patch of it on its own looks like a cloud that has lost its way.
        const camY = this._view.camY;
        const dist = (s) => Math.hypot(s.x, s.y - camY, s.z);
        const [lo, hi] = kind === SMOKE.fire ? [3, 8] : [1.2, 7];
        const near = free.filter((s) => dist(s) > lo && dist(s) < hi);
        if (near.length) free = near;
        else if (kind === SMOKE.fire) free = [free.reduce((a, b) => (Math.abs(dist(a) - 5) < Math.abs(dist(b) - 5) ? a : b))];
        else return null;
      }
      const src = free[Math.floor(Math.random() * free.length)];
      const base = { src, kind, alpha: 0, seed: Math.random(), age: 0, fire: 0, fading: false };
      // mist: a low patch, wider than it is tall, a few hundred metres across
      if (kind === SMOKE.mist) return Object.assign(base, { target: rand(0.55, 0.85), rise: rand(0.12, 0.32), width: rand(0.3, 0.7), life: rand(240, 720), ease: 30 });
      // a field: a broad front of fire, its smoke pouring up a few hundred metres and spreading
      if (kind === SMOKE.fire) return Object.assign(base, { target: rand(0.8, 0.95), rise: rand(0.45, 0.8), width: rand(0.12, 0.2), life: rand(1500, 4000), ease: 60, fire: 1 });
      // A village's hearths: their smoke rises together and spreads in a layer over the roofs, the wider the bigger the
      // village looks from here (one far across the valley is seen as a whole, not as a single chimney). Each village
      // its own: a thin thread from a hearth or two, an ordinary plume, or a thick one where many are cooking, each
      // with its own height, spread, drift and pattern (seed), and lit in its own time (_nextHearth).
      // drift: how far the wind carries it for its height, as some stop rising lower than others
      const far = this._view ? smooth(3, 12, Math.hypot(src.x, src.y - this._view.camY, src.z)) : 0;
      const kind3 = Math.random();
      const look =
        kind3 < 0.3
          ? { target: rand(0.3, 0.45), rise: rand(0.14, 0.3), width: rand(0.05, 0.09) }
          : kind3 < 0.8
            ? { target: rand(0.45, 0.65), rise: rand(0.2, 0.42), width: rand(0.08, 0.15) }
            : { target: rand(0.65, 0.8), rise: rand(0.35, 0.55), width: rand(0.13, 0.2) };
      look.width *= 1 + 0.7 * far;
      // a fire catches over a few minutes and dies down over a quarter of an hour or more; beat: how it puffs (s, s, phase)
      return Object.assign(base, look, {
        drift: rand(0.8, 2.6),
        life: rand(1200, 5400),
        ease: rand(90, 240),
        easeOut: rand(240, 600),
        beat: [rand(35, 90), rand(150, 420), rand(0, 2 * Math.PI)],
      });
    }

    _stepMeteors(dt, state) {
      const a = state.astro;
      const w = state.weather;
      const dark = smooth(-10, -16, a.sunAltDeg) * (1 - 0.6 * smooth(0, 15, a.moonAltDeg) * a.moonFraction);
      const clear = 1 - 0.95 * smooth(0.3, 0.9, w.coverage);
      // radiant altitudes from the star matrix (celestial → scene = transpose)
      const m = state.starMat;
      const date = state.now;
      const doyFrac = this._dayOfYearFrac(date);
      let rate = 8 * 2.5; // sporadic background (slightly generous so they are seen)
      let best = null;
      for (const sh of SHOWERS) {
        const peak = this._dayOfYearFrac(new Date(date.getFullYear(), sh.m - 1, Math.floor(sh.d), (sh.d % 1) * 24));
        let dd = Math.abs(doyFrac - peak);
        dd = Math.min(dd, 365 - dd);
        const act = Math.exp(-(dd * dd) / (2 * sh.w * sh.w));
        if (act < 0.01) continue;
        const rd = this._celestialToScene(sh.ra, sh.dec, m);
        const z = sh.zhr * act * Math.max(rd[1], 0);
        rate += z;
        if (!best || z > best.z) best = { sh, z, rd, act };
      }
      this.activeShower = best && best.act > 0.2 ? best.sh.name : null;
      const perSec = (rate * 0.18 * dark * clear * (this.enabled && this.shootingStars ? 1 : 0)) / 3600;
      if (Math.random() < perSec * dt && this.meteors.length < 4) {
        const fromShower = best && Math.random() < best.z / rate;
        this.meteors.push(this._newMeteor(fromShower ? best.rd : null, state));
      }
      for (const me of this.meteors) me.age += dt;
      this.meteors = this.meteors.filter((me) => me.age < me.dur + 0.7);
    }

    _newMeteor(radiant, state) {
      const v = this._view;
      // start somewhere in the sky part of the panorama
      const az = rand(-0.48, 0.48) * v.hfov;
      const topTan = (1 - v.horizonY) * v.h * v.pxAng;
      const el = Math.atan(rand(0.25, 0.95) * topTan);
      const P = [Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el)];
      let T;
      if (radiant) {
        const dot = P[0] * radiant[0] + P[1] * radiant[1] + P[2] * radiant[2];
        T = [P[0] - radiant[0] * dot, P[1] - radiant[1] * dot, P[2] - radiant[2] * dot]; // away from the radiant
        const n = Math.hypot(...T) || 1;
        T = T.map((x) => x / n);
        T = T.map((x, i) => x - P[i] * (T[0] * P[0] + T[1] * P[1] + T[2] * P[2]));
      } else {
        const ang = rand(-Math.PI, 0) + (Math.random() < 0.5 ? 0 : Math.PI * 0.15);
        const right = [Math.cos(az), 0, -Math.sin(az)];
        const up = [-Math.sin(az) * Math.sin(el), Math.cos(el), -Math.cos(az) * Math.sin(el)];
        T = right.map((r, i) => r * Math.cos(ang) + up[i] * Math.sin(ang));
      }
      const nT = Math.hypot(...T) || 1;
      T = T.map((x) => x / nT);
      const mag = Math.pow(Math.random(), 2.2) * 5 - 1.5; // mostly faint, a few bright
      // a short scratch across the sky: a faint one a degree or two, the brightest up to about six. Longer looked
      // like a comet across a sky only some 25 degrees tall on the picture.
      const lenRad = (1.5 + 4.5 * clamp((3.5 - mag) / 5, 0, 1) * rand(0.6, 1)) * D2R;
      const p0 = this._projectDir(P);
      const P1 = P.map((x, i) => x + T[i] * lenRad);
      const p1 = this._projectDir(P1);
      return {
        p0, p1, age: 0, dur: rand(0.2, 0.7), bright: 0.9 * Math.pow(2.512, -mag),
        trail: rand(0.35, 0.75), // how much of its path still glows behind the head
        flareAt: rand(0.5, 0.95), // where along its path it flares, if it does
        flare: Math.random() < 0.35 ? rand(0.6, 2) : 0,
      };
    }

    _stepSatellites(dt, state) {
      const a = state.astro;
      const w = state.weather;
      // sunlit satellites against a dark sky: roughly the first/last ~2 h of night
      const window = smooth(-6, -10, a.sunAltDeg) * (1 - smooth(-24, -32, a.sunAltDeg));
      const clear = 1 - 0.95 * smooth(0.3, 0.9, w.coverage);
      const perSec = (window * clear * (this.enabled && this.shootingStars ? 1 : 0)) / 200;
      if (Math.random() < perSec * dt && this.sats.length < 3) {
        const v = this._view;
        const az = rand(-0.5, 0.5) * v.hfov;
        const topTan = (1 - v.horizonY) * v.h * v.pxAng;
        const el = Math.atan(rand(0.3, 0.95) * topTan);
        const heading = rand(0, TAU);
        const speed = rand(0.4, 1.0) * D2R; // rad/s
        this.sats.push({ az, el, heading, speed, age: 0, life: rand(25, 80), bright: rand(0.15, 0.5) });
      }
      for (const s of this.sats) {
        s.age += dt;
        s.az += Math.cos(s.heading) * s.speed * dt / Math.max(Math.cos(s.el), 0.2);
        s.el += Math.sin(s.heading) * s.speed * dt;
      }
      this.sats = this.sats.filter((s) => s.age < s.life && Math.abs(s.az) < this._view.hfov / 2 + 0.1 && s.el > -0.02);
    }

    // ------------------------------------------------------------ helpers
    _dayOfYearFrac(d) {
      const start = new Date(d.getFullYear(), 0, 1);
      return (d - start) / 864e5;
    }
    _celestialToScene(raDeg, decDeg, m) {
      const ra = raDeg * D2R;
      const dec = decDeg * D2R;
      const e = [Math.cos(dec) * Math.cos(ra), Math.cos(dec) * Math.sin(ra), Math.sin(dec)];
      // starMat is column-major scene→celestial; its transpose maps celestial→scene
      return [
        m[0] * e[0] + m[1] * e[1] + m[2] * e[2],
        m[3] * e[0] + m[4] * e[1] + m[5] * e[2],
        m[6] * e[0] + m[7] * e[1] + m[8] * e[2],
      ];
    }
    _projectDir(P) {
      const v = this._view;
      const a = Math.atan2(P[0], P[2]);
      const r = Math.hypot(P[0], P[2]);
      return [v.w / 2 + a / v.pxAng, v.horizonY * v.h + (P[1] / Math.max(r, 1e-4)) / v.pxAng];
    }

    // ------------------------------------------------------------ instance buffer
    _push(vals) {
      if (this.count >= MAX) return;
      const at = this.count * FLOATS;
      this.data.set(vals, at);
      if (vals.length < FLOATS) this.data.fill(0, at + vals.length, at + FLOATS);
      this.count++;
    }

    _pushBird(b) {
      const v = this._view;
      const p = b.pos;
      const pr = this._project(p[0], p[1], p[2]);
      if (!this._inView(pr, 30)) return;
      const dx = p[0];
      const dy = p[1] - v.camY;
      const dz = p[2];
      const dist = Math.hypot(dx, dy, dz);
      const halfSpanPx = b.sp.span / 2 / dist / v.pxAng;
      const sizeFade = smooth(0.3, 1.1, halfSpanPx);
      if (sizeFade <= 0.01) return;
      // screen axes at the bird: right = d(azimuth), up ≈ world up
      const az = pr.a;
      const right = [Math.cos(az), 0, -Math.sin(az)];
      let fx = b.vel[0];
      let fz = b.vel[2];
      const fl = Math.hypot(fx, fz) || 1;
      fx /= fl;
      fz /= fl;
      // wing axis, tilted by the bank angle
      const wx = fz;
      const wz = -fx;
      const cb = Math.cos(b.bank || 0);
      const sb = Math.sin(b.bank || 0);
      let sx = (wx * right[0] + wz * right[2]) * cb;
      let sy = sb;
      if (sx < 0) {
        sx = -sx;
        sy = -sy;
      }
      const spanF = Math.max(Math.hypot(sx, sy), 0.24);
      const roll = Math.atan2(sy, sx);
      // body direction on screen (rotated into the wing frame)
      const bx = fx * right[0] + fz * right[2];
      const by = clamp(b.vel[1] / Math.max(Math.hypot(b.vel[0], b.vel[1], b.vel[2]), 1e-6), -0.6, 0.6);
      const cr = Math.cos(-roll);
      const sr = Math.sin(-roll);
      const lbx = bx * cr - by * sr;
      const lby = bx * sr + by * cr;
      const topSeen = smooth(0.0, 0.08, -dy / dist);
      const hs = Math.max(halfSpanPx, 1.2) * 1.3;
      this._push([
        pr.sx, pr.sy, hs, hs,
        roll, b.sp.type, (b.alpha ?? 1) * sizeFade, dist,
        b.phase || 0, b.amp || 0, spanF, b.dihedral || 0,
        lbx, lby, topSeen, 0,
      ]);
    }

    _write(state) {
      this.count = 0;
      // Vehicles are too slow on the picture to need a higher frame rate, and their indicators blink well within it.
      const lights = this._lightsLevel(state);
      for (const c of this.vehicles) this._pushVehicle(c, lights);
      const vehiclesInView = this.count;
      for (const r of this.raptors) this._pushBird(r);
      if (this.flock) for (const b of this.flock.birds) this._pushBird(b);
      if (this.geese) for (const b of this.geese.birds) this._pushBird(b);
      const birdsInView = this.count - vehiclesInView;

      // mist and smoke rising from the hills go to the volume pass; only the glow of a fire where it burns is drawn
      // here, a small patch round its foot (the shader shows it by night only)
      const v = this._view;
      this._writePlumes(this.smoke, state);
      for (const s of this.smoke) {
        if (s.kind === SMOKE.mist || s.fire < 0.01) continue;
        const p = s.src;
        const pr = this._project(p.x, p.y, p.z);
        if (!this._inView(pr, 30)) continue;
        const dist = Math.hypot(p.x, p.y - v.camY, p.z);
        const R = 24;
        this._push([
          pr.sx, pr.sy + R, R, R,
          0, 5, s.alpha, dist,
          0, s.seed, 0, s.kind,
          s.fire, 0, 0, 0,
        ]);
      }

      const skyFrom = this.count;

      // meteors: a hair-thin line growing from where it starts, brightest at its head, sometimes flaring once, and
      // ending at once; the faint train it leaves behind fades in a moment
      for (const me of this.meteors) {
        const k = clamp(me.age / me.dur, 0, 1);
        const head = [me.p0[0] + (me.p1[0] - me.p0[0]) * k, me.p0[1] + (me.p1[1] - me.p0[1]) * k];
        const tk = clamp(k - me.trail, 0, 1);
        const tail = [me.p0[0] + (me.p1[0] - me.p0[0]) * tk, me.p0[1] + (me.p1[1] - me.p0[1]) * tk];
        const len = Math.max(Math.hypot(head[0] - tail[0], head[1] - tail[1]), 2);
        const burning = me.age < me.dur ? 1 : 0;
        const glow = smooth(0, 0.05, me.age) * (1 + me.flare * Math.exp(-((k - me.flareAt) ** 2) / 0.006) * burning);
        const train = Math.exp(-Math.max(me.age - me.dur, 0) / 0.18);
        const ang = Math.atan2(head[1] - tail[1], head[0] - tail[0]);
        this._push([
          (head[0] + tail[0]) / 2, (head[1] + tail[1]) / 2, len / 2 + 3, 3,
          ang, 3, 1, 0,
          burning, Math.min(me.bright * glow * train * state.starVis * 2, 2.5), 0, 0.55,
          0, 0, 0, 0,
        ]);
      }

      // satellites
      for (const s of this.sats) {
        const P = [Math.sin(s.az) * Math.cos(s.el), Math.sin(s.el), Math.cos(s.az) * Math.cos(s.el)];
        const p = this._projectDir(P);
        const fade = smooth(0, 3, s.age) * (1 - smooth(s.life - 4, s.life, s.age));
        this._push([p[0], p[1], 3, 3, 0, 4, 1, 0, s.bright * fade * state.starVis * 3, 0, 0, 0, 0, 0, 0, 0]);
      }
      // Things in view that move fast enough to need a higher frame rate. Smoke only drifts.
      this.movers = birdsInView + this.count - skyFrom;
    }
  }

  LE.Life = Life;
  LE.Life.MAX = MAX;
  LE.Life.FLOATS = FLOATS;
})();
