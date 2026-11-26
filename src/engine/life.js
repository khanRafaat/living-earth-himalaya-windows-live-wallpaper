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
  // goats: where round a spot the rock must be seen and even (m, across and away), and their coats (shaders/goat.js coat)
  const GOAT_AROUND = [[0.7, 0], [-0.7, 0], [0, 0.5], [0, -0.5]];
  const GOAT_COATS = [0, 0, 0, 1, 1, 2, 2, 3, 4, 4, 5];
  const G = 0.0098; // km/s²

  const SPECIES = {
    raptor: { type: 0, span: 0.0026, flapHz: 2.0 },
    // the one that sits on the tree: a small falcon, 75 cm across and 32 cm tall sitting. A big soaring bird 30 m
    // from the eye was a huge flat shape with nothing to it
    falcon: { type: 0, span: 0.00075, flapHz: 5.5, tall: 0.00032 },
    chough: { type: 1, span: 0.0008, flapHz: 6.5 },
    // the black kite that hangs over every village in these hills: half a vulture's size, and it beats its wings more
    kite: { type: 0, span: 0.0015, flapHz: 2.8 },
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
  // the colours of the light that flashing lamps throw on what is round them (_pushGlow)
  const GLOW_AMBER = [1.0, 0.55, 0.1];
  const GLOW_RED = [1.0, 0.08, 0.05];
  const GLOW_BLUE = [0.15, 0.35, 1.0];
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
    // a lorry: a coloured cab and a covered load, slow, and slower still on the bends
    lorry: {
      code: 3, len: 0.0075, wid: 0.0025, hgt: 0.0032, cruise: 0.0072, bend: 0.74, accel: 0.5e-3, lane: 0.0017,
      lampH: 0.001, power: 0.95, low: 0.065, high: 0.16, cone: 0.8,
      paints: [rgb5(23, 8, 4), rgb5(5, 10, 21), rgb5(25, 18, 4), rgb5(6, 15, 9), rgb5(22, 22, 20), rgb5(24, 12, 3)],
    },
    // an army column: olive lorries behind a jeep (see _newConvoy). They come only together.
    armyLorry: {
      code: 4, len: 0.0075, wid: 0.0025, hgt: 0.0032, cruise: 0.0068, bend: 0.74, accel: 0.5e-3, lane: 0.0017,
      lampH: 0.001, power: 0.95, low: 0.065, high: 0.16, cone: 0.8,
      paints: [rgb5(9, 11, 6), rgb5(10, 12, 7), rgb5(8, 10, 6)],
    },
    armyJeep: {
      code: 5, len: 0.0045, wid: 0.0018, hgt: 0.0019, cruise: 0.0068, bend: 0.74, accel: 0.5e-3, lane: 0.0017,
      lampH: 0.0008, power: 0.8, low: 0.055, high: 0.14, cone: 0.82,
      paints: [rgb5(9, 11, 6), rgb5(10, 12, 7)],
    },
    // an ambulance on a call: white with a red stripe, a red and blue light on its roof, about 60 km/h where the road
    // lets it, and it overtakes faster than anyone else may. Everyone makes way for it.
    ambulance: {
      code: 6, len: 0.0055, wid: 0.002, hgt: 0.0024, cruise: 0.0165, bend: 1.05, accel: 1.6e-3, lane: 0.0017,
      lampH: 0.0009, power: 0.9, low: 0.06, high: 0.15, cone: 0.82,
      paints: [rgb5(29, 29, 28)], spread: 0.05, vPass: 0.019, beacon: true,
    },
  };
  const PLANE_V = 0.23; // km/s, an airliner at cruise
  // km: further off it is behind the mountains, which stand 4 to 15 degrees high on the picture (seen on the first
  // renders: an aircraft 90 to 120 km away never showed above them)
  const PLANE_FAR = 120;
  const TRAIL_W0 = 0.01; // km, how wide a new contrail is, and how fast it spreads (km/s)
  const TRAIL_SPREAD = 0.0008;
  // km: over a village further off a kite (1.5 m across) is under two pixels. It was 3.2 km, where one is under a pixel,
  // and a landscape with no village that near had none at all, not even from the test panel (user, 2026-11-18: "in debug
  // black kite also not working")
  const KITE_FAR = 1.2;
  // gold, red, green and silver-white: the small rockets sold for Tihar
  // gold, red, green, violet, silver: pure, so that bright as they are the night's tone curve does not wash them white
  const FIREWORK_COLOURS = [[1.0, 0.5, 0.08], [1.0, 0.08, 0.04], [0.12, 1.0, 0.15], [0.7, 0.12, 1.0], [0.75, 0.8, 1.0]];
  const HELI_V = 0.045; // km/s, a helicopter making its way up the valley
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
  const BEACON_RED = 4; // an ambulance's roof light, which of its two colours is lit now: sent with the indicators
  const BEACON_BLUE = 8;
  const CONVOY_GAP = 0.014; // km between the vehicles of an army column
  const SIREN_BEHIND = 0.2; // km: those ahead of an ambulance make way for it from here
  const SIREN_AHEAD = 0.25; // km: those coming towards it slow down from here
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
      this._recentFires = []; // where the last two fires burned: the next one is somewhere else
      this.road = null;
      this.vehicles = [];
      this._nextVehicle = 0;
      this._trafficSeeded = false;
      this._nextConvoy = rand(500, 2400); // an army column, now and then by day
      this._nextAmbulance = rand(600, 3600); // an ambulance, at any hour
      this._convoy = null; // a column still driving on to the road, one after the other
      this._groups = 0;
      this.enabled = true;
      this.birds = true; // off: no birds, while the rest of life goes on
      this.mist = true; // mist rising off the forest
      this.villageSmoke = true; // smoke from the villages
      this.fires = true; // a field burning now and then
      this.shootingStars = true; // meteors and satellites
      // Where a bird of prey can sit: perchAt(i) gives where place i on the tree is now (km, scene axes), or null when
      // there is no tree; perchCount() how many there are; perchOut(i) the way out of the crown there (main.js sets them
      // from the foreground). Now and then a falcon comes in to one of them, never the same one twice running.
      this.perchAt = null;
      this.perchCount = null;
      this.perchOut = null;
      this._lastSite = null;
      this._nextPerch = rand(240, 900);
      this.nearFrom = 0; // sprites from here on are close to the tree and are drawn after it, in front (renderer.js)
      this.planes = true; // an airliner crossing high above, with its contrail
      this.aircraft = [];
      this._nextPlane = rand(120, 900);
      this.fireworks = [];
      this._nextFirework = rand(5, 40);
      this.lights = true; // the village lights' switch: festival fireworks belong to it
      this.festForce = 0; // the test panel: a festival night now
      this._nextKite = rand(20, 120);
      this.animals = true; // herds grazing on the meadows by day (the switch)
      this.pastures = []; // [{x, y, z, n}] meadows found after the bake, and the herd on each
      this.herds = [];
      this.gompa = null; // {x, y, z}: a monastery on a ridge, whose lamp burns at night
      this.ledge = null; // the top of the rock by the tree as the eye sees it (Renderer.ledgeMap), where goats graze
      this.goats = [];
      this._goatsSeen = false;
      this._goatsAway = 0;
      this._goatStay = 0;
      this.heli = null;
      this._nextHeli = rand(300, 900);
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

    /** Meadows where animals can graze: a small herd on each, every animal with its own colour and its own wandering. */
    setPastures(list) {
      this.pastures = list || [];
      this.herds = this.pastures.map((at) => {
        const n = Math.floor(rand(4, 9));
        const animals = [];
        for (let i = 0; i < n; i++) {
          const a = rand(0, TAU);
          const r = Math.sqrt(Math.random()) * 0.025;
          animals.push({ x: Math.cos(a) * r, z: Math.sin(a) * r, tx: 0, tz: 0, wait: rand(0, 40), shade: Math.random(), face: 1 });
          animals[i].tx = animals[i].x;
          animals[i].tz = animals[i].z;
        }
        return { at, animals };
      });
    }

    setGompa(at) {
      this.gompa = at || null;
    }

    setRoad(road) {
      this.road = road || null;
      this.vehicles = [];
      this._convoy = null;
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
      if (kind === 'perch') {
        // one comes in to the tree from a little way off
        const f = this._sites() ? this._newFalcon(this._pickSite(), true) : null;
        if (!f) return;
        this.raptors = this.raptors.filter((x) => x.sp !== SPECIES.falcon);
        this.raptors.push(f);
      } else if (kind === 'raptor') this.raptors.push(this._newRaptor(true));
      else if (kind === 'kite') {
        const homes = this._kiteHomes();
        if (homes.length) this.raptors.push(this._newKite(homes[Math.floor(Math.random() * homes.length)], true));
      } else if (kind === 'goats') {
        // grazing on the rock at once (by night or in heavy rain they then walk off)
        if (this.ledge && this.animals && this.enabled) {
          this._goatsSeen = true;
          this._goatHerd(false);
        }
      } else if (kind === 'helicopter') {
        if (this.planes) this.heli = this._newHeli(true);
      }
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
      else if (kind === 'firework') {
        const f = this._newFirework();
        if (f) this.fireworks.push(f);
      } else if (kind === 'plane') {
        if (this.planes) this.aircraft.push(this._newPlane(this.state, true));
      } else if (kind === 'satellite') this.sats.push({ az: rand(-0.4, 0.4), el: 0.25, heading: 0.4, speed: 0.0005, age: 5, life: 600, bright: 0.45 });
      else if (kind === 'convoy' && this.road) {
        // the whole column at once, on the road in view
        const q = this._newConvoy(Math.random() < 0.5 ? 1 : -1);
        const s = this._roadInView();
        for (let back = 0; q.left > 0; ) {
          const c = this._convoyMember(q, s - q.dir * back);
          back += c.len / 2 + CONVOY_GAP + (VEHICLES.armyLorry.len * SIZE_ON_SCREEN) / 2;
          if (c.s > 0.01 && c.s < this.road.length - 0.01) this.vehicles.push(c);
        }
      } else if (VEHICLES[kind] && this.road) this.vehicles.push(this._newVehicle(kind, Math.random() < 0.5 ? 1 : -1, this._roadInView()));
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

    /**
     * A skein of geese. Most cross the view from one side to the other on a straight course that passes 0.3-0.7 km
     * off, so they come in low over the peaks at one edge, rise across the sky and go down to the other edge; some
     * come out of the distance over the peaks and leave past a side, or come in at a side and go off into the peaks.
     * They come in past an edge or too far off to see, and leave the same way: none appears or vanishes in open sky.
     * The side they come from changes more often than not, and never three times running; in the migration seasons
     * the side whose course heads the season's way (towards SW in autumn, NE in spring) comes up a little more often.
     * Before 2.9.0 the season fixed the compass course itself, so with the view facing NE every autumn skein came
     * from the same place, straight at the viewer.
     */
    _newGeese(state, inView) {
      const v = this._view;
      const doy = state.astro.dayOfYear;
      const autumn = doy >= 255 && doy <= 340;
      const spring = doy >= 55 && doy <= 125;
      // which side it comes in at: +1 on the right, flying to the left (a course of about heading - 90°)
      const last = this._lastGeeseSide || (Math.random() < 0.5 ? -1 : 1);
      let pOther = 0.65;
      if (autumn || spring) {
        const want = autumn ? 217 : 37;
        const off = (c) => Math.abs((((c - want) % 360) + 540) % 360 - 180);
        const fav = off((state.heading || 0) - 90) < off((state.heading || 0) + 90) ? 1 : -1;
        pOther += last === fav ? -0.05 : 0.05;
      }
      let side = Math.random() < pOther ? -last : last;
      if ((this._geeseRun || 0) >= 2 && side === last) side = -last;
      this._geeseRun = side === this._lastGeeseSide ? (this._geeseRun || 0) + 1 : 1;
      this._lastGeeseSide = side;

      const kind = inView ? 'cross' : Math.random() < 0.8 ? 'cross' : Math.random() < 0.5 ? 'toward' : 'away';
      const edge = v.hfov / 2 + 6 * D2R; // just out of the frame (it ends 30 px past the edge)
      const at = (az, d) => [Math.sin(az) * d, 0, Math.cos(az) * d];
      const closest = (a, b) => {
        // how near the course from a to b passes the viewer (km, on the ground)
        const dx = b[0] - a[0];
        const dz = b[2] - a[2];
        const s = clamp(-(a[0] * dx + a[2] * dz) / (dx * dx + dz * dz), 0, 1);
        return Math.hypot(a[0] + dx * s, a[2] + dz * s);
      };
      let a;
      let b;
      let near;
      for (let k = 0; k < 8; k++) {
        if (kind === 'cross') {
          const r = rand(0.3, 0.7) / Math.cos(edge);
          a = at(side * edge, r * rand(0.75, 1.3));
          b = at(-side * edge, r * rand(0.75, 1.3));
        } else {
          // one end far off over the peaks, too far to see a goose; the other just past a side
          const far = at(rand(-0.35, 0.35) * v.hfov * 0.5, rand(4, 5));
          const by = at((kind === 'toward' ? -side : side) * edge, rand(0.5, 1.0));
          [a, b] = kind === 'toward' ? [far, by] : [by, far];
        }
        near = closest(a, b);
        if (near > 0.3) break;
      }
      // a level course, 6-16° up where it passes nearest
      const y = v.camY + Math.max(near, 0.3) * Math.tan(rand(6, 16) * D2R);
      a[1] = b[1] = y;
      const len = Math.hypot(b[0] - a[0], b[2] - a[2]);
      const dir = [(b[0] - a[0]) / len, 0, (b[2] - a[2]) / len];
      const speed = 0.017;
      const lead = inView ? [a[0] + (b[0] - a[0]) * 0.45, y, a[2] + (b[2] - a[2]) * 0.45] : a.slice();
      const n = 2 * Math.floor(rand(3, 9)) + 1;
      const birds = [];
      for (let i = 0; i < n; i++) {
        birds.push({ sp: SPECIES.goose, pos: lead.slice(), vel: [0, 0, 0], phase: rand(0, 0.4), bank: 0, alpha: 1, idx: i });
      }
      const g = {
        birds, lead, dir, speed, kind, side, age: 0, seen: false, hidden: 0,
        // the far end fades as well as shrinking: in from it over 5 s, or out over the last 5 s before it
        fadeIn: kind === 'toward' ? 5 : 0,
        fadeOutAt: kind === 'away' ? len / speed : 0,
        maxAge: len / speed + 60, // only a safety cap: it ends when every bird has been out of sight for 3 s
      };
      this._stepGeese(g, 0); // the V in its places at once
      return g;
    }

    /**
     * How much the weather lets birds (and the helicopter) fly, 0 to 1. Fog grounds them, mist does not: the valley fog
     * from a short visibility (mist, METAR "BR") stays at 0.75 or less and lies below the viewpoint, and birds fly over
     * it; only fog reported as fog (0.8, 0.9) takes them in. Before, mist at 1.4 km at Dhaka airport (2026-11-18) left
     * 12 % of the birds, which rounded to none.
     */
    static shelter(w) {
      return (1 - smooth(0.1, 0.4, w.rain)) * (1 - smooth(0.76, 0.88, w.fog)) * (1 - w.storm) * (1 - smooth(0.2, 0.6, w.snow));
    }

    // ------------------------------------------------------------ update
    /**
     * Held still while you work (main.js holdPicture) the scene's own time stands still, so the birds, the tree, the
     * traffic and the goats stay where they were; but aircraft go on in real time, `dt` being the real seconds since the
     * last held picture. Before, they counted only the minutes the desktop was in sight, and with an app in front most
     * of the day no flight was ever seen (2026-11-22, the user: "no single plane flown in wallpaper"). Now each minute's
     * picture has the flight further along, and new ones come at their own rate.
     */
    catchUpAir(dt, state, view) {
      this._view = view;
      this.state = state;
      if (dt > 0) {
        this._stepPlanes(dt, state);
        this._stepHeli(dt, state, smooth(-5, 3, state.astro.sunAltDeg) * Life.shelter(state.weather));
      }
      this._write(state);
    }

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
      const shelter = Life.shelter(w);
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
        const active = this.raptors.filter((r) => r.mode !== 'leave' && r.sp === SPECIES.raptor).length;
        if (active < raptorTarget) this.raptors.push(this._newRaptor(false));
        else if (active > raptorTarget) {
          const r = this.raptors.find((x) => x.mode !== 'leave' && x.sp === SPECIES.raptor);
          if (r) this._leave(r);
        }
      }
      // Now and then a small falcon comes in to sit on the top of the tree for a while: by day in fair weather only,
      // and one at a time
      this._nextPerch -= dt;
      if (this._nextPerch <= 0) {
        this._nextPerch = rand(300, 900);
        const busy = this.raptors.some((r) => r.sp === SPECIES.falcon);
        if (this._sites() && !busy && birdOK > 0.5 && this._perchWeather(state)) {
          const f = this._newFalcon(this._pickSite());
          if (f) this.raptors.push(f);
        }
      }
      // Black kites: one or two over the villages near enough to see them, whenever birds fly at all. They need no
      // thermals: they hang over the houses all day
      this._nextKite -= dt;
      if (this._nextKite <= 0) {
        this._nextKite = rand(30, 90);
        const homes = this._kiteHomes();
        const kites = this.raptors.filter((r) => r.sp === SPECIES.kite && r.mode !== 'leave');
        const want = homes.length ? Math.round(2 * birdOK) : 0;
        if (kites.length < want) this.raptors.push(this._newKite(homes[Math.floor(Math.random() * homes.length)], false));
        else if (kites.length > want) this._leave(kites[0]);
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
      this._stepPlanes(dt, state);
      this._stepFireworks(dt, state);
      this._stepHerds(dt, daylight);
      this._stepGoats(dt, state);
      this._stepHeli(dt, state, daylight * shelter);
    }

    /** The villages a kite can be seen over. */
    _kiteHomes() {
      const villages = this.smokeSources.filter((s) => Math.hypot(s.x, s.z) < KITE_FAR);
      return villages.length ? villages : this._slopeHomes();
    }

    /**
     * With no village that near, kites hang over the slopes just below the viewpoint, 0.25 to 0.45 km out and 60 to 150 m
     * below the eye (_overVillage), seen from above against the forest: five to nine pixels across. Clear of the rock and
     * the tree on the left.
     */
    _slopeHomes() {
      const v = this._view;
      if (!v) return [];
      return [[-0.35, 0.28], [0.15, 0.36], [0.6, 0.32]].map(([f, d]) => {
        const az = (f * v.hfov) / 2;
        return { x: Math.sin(az) * d, y: v.camY - 0.2, z: Math.cos(az) * d, slope: true };
      });
    }

    /**
     * Where a kite circles over a village: 50 to 140 m above its roofs. Over the slopes, nearer the middle of each, and
     * (`_kiteRadius`) in smaller circles, so it keeps 0.19 to 0.45 km out: before, a wide circle off the nearest of them
     * now and then came within 140 m of the eye.
     */
    _overVillage(home) {
      const s = home.slope ? 0.03 : 0.05;
      return [home.x + rand(-s, s), home.y + rand(0.05, 0.14), home.z + rand(-s, s)];
    }

    _kiteRadius(r, wide) {
      return r.slopeHome ? rand(0.03, 0.05) : rand(0.03, wide);
    }

    /** A black kite on its way to a village from out of sight, or (the test panel) already circling over it. */
    _newKite(home, shown) {
      const r = this._newRaptor(shown);
      const c = this._overVillage(home);
      r.sp = SPECIES.kite;
      r.slopeHome = !!home.slope;
      r.target = c;
      r.center = [c[0], c[2]];
      r.y = c[1];
      r.R = this._kiteRadius(r, 0.07);
      r.omega = Math.sign(r.omega) * (0.0125 / r.R);
      r.circleTime = rand(120, 400);
      r.nextFlap = rand(4, 12);
      if (shown) r.pos = [c[0] + Math.cos(r.theta) * r.R, c[1], c[2] + Math.sin(r.theta) * r.R];
      else {
        const d0 = Math.hypot(c[0], c[2]);
        const az = (Math.random() < 0.5 ? -1 : 1) * (this._view.hfov / 2 + 10 * D2R);
        r.pos = [Math.sin(az) * d0, c[1] + 0.03, Math.cos(az) * d0];
      }
      return r;
    }

    _leave(b) {
      b.mode = 'leave';
      b.target = this._exitPoint(b.pos);
    }

    /** How many places on the tree a bird can sit on (0 without a tree). */
    _sites() {
      if (!this.perchAt) return 0;
      return this.perchCount ? this.perchCount() : 1;
    }

    /** Which of them the next falcon goes to: any, but not the one the last one sat on. */
    _pickSite() {
      const n = this._sites();
      if (n <= 1) return 0;
      if (this._lastSite == null || this._lastSite >= n) return Math.floor(Math.random() * n);
      const i = Math.floor(Math.random() * (n - 1));
      return i >= this._lastSite ? i + 1 : i;
    }

    /** Where this bird is to sit now (km), or null. */
    _siteAt(r) {
      return this.perchAt ? this.perchAt(r.site || 0) : null;
    }

    /**
     * Does the straight line from a to b come within m km of the eye? 20 m: the flight curves off the straight line
     * (it takes off the way it faces and turns), and must still keep 15 m from the eye.
     */
    _passesEye(a, b, m = 0.02) {
      const e = [0, this._view.camY, 0];
      const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
      const l2 = ab[0] * ab[0] + ab[1] * ab[1] + ab[2] * ab[2] || 1e-12;
      const t = clamp(((e[0] - a[0]) * ab[0] + (e[1] - a[1]) * ab[1] + (e[2] - a[2]) * ab[2]) / l2, 0, 1);
      return Math.hypot(a[0] + ab[0] * t - e[0], a[1] + ab[1] * t - e[1], a[2] + ab[2] * t - e[2]) < m;
    }

    /**
     * The side of the crown a bird may come in to place `site` from, as an azimuth and how wide (cos): out from the
     * place, or for the top of the crown the eye's side. Near the tree the bird is drawn over it, so it must not pass
     * behind the leaves on its last stretch.
     */
    _openSide(site, at) {
      const out = this.perchOut ? this.perchOut(site) : null;
      const oh = out ? Math.hypot(out[0], out[2]) : 0;
      if (oh > 0.35) return { az: Math.atan2(out[0], out[2]), cos: 0.2 };
      return { az: Math.atan2(-at[0], -at[2]), cos: -0.35 };
    }

    /**
     * The falcon that comes to place `site` on the tree. It sets out from anywhere round it: from out over the valley,
     * from either side, from behind the viewer, higher or a little lower than the tree. One that would come out of the
     * leaves' far side first swings round to the open side. One setting out in plain view starts so far off that it
     * is too small to see and grows out of nothing; the test panel's one comes from a few hundred metres.
     */
    _newFalcon(site, summoned = false) {
      const at = this.perchAt ? this.perchAt(site) : null;
      if (!at) return null;
      const open = this._openSide(site, at);
      const toEye = Math.atan2(-at[0], -at[2]);
      let start = null;
      let via = null;
      for (let k = 0; k < 24 && !start; k++) {
        const az = rand(0, TAU);
        // Gliding down to it at up to 7 degrees, or rising to it from a little below; a steeper dive would reach the
        // perch from above instead of swooping up on to it. (On the eye's side of the tree the hill rises behind the
        // viewer: not from below there.)
        const eyeSide = Math.cos(az - toEye) > 0;
        const slope = rand(eyeSide ? 0.01 : -0.05, 0.125);
        let d = summoned ? rand(0.2, 0.32) : rand(0.35, 0.7);
        let p = [at[0] + Math.sin(az) * d, at[1] + slope * d, at[2] + Math.cos(az) * d];
        if (!summoned && this._inView(this._project(...p), 40)) {
          d = rand(1.8, 2.4);
          p = [at[0] + Math.sin(az) * d, at[1] + slope * d, at[2] + Math.cos(az) * d];
        }
        let v = null;
        if (Math.cos(az - open.az) < open.cos) {
          // round to the open side first, 70 m out from the tree and a little above it
          const side = Math.sin(az - open.az) >= 0 ? 1 : -1;
          const va = open.az + side * 70 * D2R;
          v = [at[0] + Math.sin(va) * 0.07, at[1] + 0.008, at[2] + Math.cos(va) * 0.07];
        }
        if (v ? this._passesEye(p, v) || this._passesEye(v, at) : this._passesEye(p, at)) continue;
        start = p;
        via = v;
      }
      if (!start) {
        // (nowhere clear found: in from the open side)
        start = [at[0] + Math.sin(open.az) * 0.3, at[1] + 0.04, at[2] + Math.cos(open.az) * 0.3];
      }
      const r = this._newRaptor(true);
      r.sp = SPECIES.falcon;
      r.site = site;
      r.pos = start;
      r.via = via;
      const aim = via || at;
      const al = Math.hypot(aim[0] - start[0], aim[2] - start[2]) || 1;
      r.vel = [((aim[0] - start[0]) / al) * 0.012, 0, ((aim[2] - start[2]) / al) * 0.012];
      r.mode = 'approach';
      r.nextFlap = 1;
      r.alpha = summoned ? 1 : 0; // a far speck fades in rather than appearing
      this._lastSite = site;
      return r;
    }

    /**
     * Away from the tree in any direction it can take from where it faces: across the picture, out over the valley,
     * back past the viewer or out past an edge, climbing or dropping. One that heads out into the picture keeps going
     * until it is too small to see (_stepRaptor), so it never vanishes in plain view.
     */
    _leaveTree(r) {
      const fx = r.face ? r.face[0] : r.vel[0];
      const fz = r.face ? r.face[1] : r.vel[2];
      const f0 = Math.hypot(fx, fz) > 1e-9 ? Math.atan2(fx, fz) : rand(0, TAU);
      r.mode = 'leave';
      r.via = null;
      for (let k = 0; k < 24; k++) {
        const az = f0 + rand(-1.9, 1.9);
        const dy = rand(-0.08, 0.15);
        let d = rand(0.6, 1.5);
        let tg = [r.pos[0] + Math.sin(az) * d, r.pos[1] + dy, r.pos[2] + Math.cos(az) * d];
        if (this._inView(this._project(...tg), 40)) {
          d = rand(2.2, 3);
          tg = [r.pos[0] + Math.sin(az) * d, r.pos[1] + dy * 1.5, r.pos[2] + Math.cos(az) * d];
        }
        if (this._passesEye(r.pos, tg)) continue;
        r.target = tg;
        return;
      }
      // (nowhere clear: out past the nearer edge of the picture)
      const side = Math.atan2(r.pos[0], r.pos[2]) >= 0 ? 1 : -1;
      const az = side * (this._view.hfov / 2 + 25 * D2R);
      const d = rand(0.5, 0.9);
      r.target = [Math.sin(az) * d, r.pos[1] + rand(0.02, 0.08), Math.cos(az) * d];
    }

    /** Weather a bird would sit out in the open in: no rain or snow, and not much wind. */
    _perchWeather(state) {
      const w = state.weather;
      return w.rain < 0.05 && w.snow < 0.05 && w.storm < 0.05 && w.windSpeed < 32;
    }

    /** Off the perch: it drops forward, beats its wings hard a few times and is away, out of the picture. */
    _takeOff(r) {
      const l = Math.hypot(r.face[0], r.face[1]) || 1;
      this._leaveTree(r);
      // (from a standstill: it leans off the perch at walking pace, its wings opening, and gathers speed from there)
      r.vel = [(r.face[0] / l) * 0.0012, 0, (r.face[1] / l) * 0.0012];
      r.fold = 1;
      r.pos[1] += Life.perchBody(r);
      r.flapLeft = rand(2.2, 3);
      r.nextFlap = rand(15, 45);
      r.amp = 1;
      this._nextPerch = Math.max(this._nextPerch, rand(300, 900));
    }

    _stepRaptor(r, dt, state) {
      const w = state.weather;
      const sp = 0.0125;
      const at = r.mode === 'approach' || r.mode === 'settle' || r.mode === 'perched' ? this._siteAt(r) : null;
      // its wings open again after it leaves the perch
      if (r.mode !== 'settle') r.fold = Math.max(0, (r.fold || 0) - dt * 2.5);
      if (r.mode === 'settle') {
        // Under a second from its feet touching to sitting still: it is drawn on to the perch, its wings beat a last
        // time or two and close. Nothing jumps: the sitting bird takes over only when the wings are shut.
        if (!at) this._leaveTree(r);
        else {
          r.settle += dt / 0.7;
          // Drawn to the perch as by a spring that does not swing back, from the speed it arrived with. Worked out in
          // the perch's own frame, so a branch swaying in the wind does not leave it trailing behind (it then had to be
          // put on to the perch with a jump of a few pixels when it sat).
          const W = 6;
          const h = Math.min(dt, 0.1);
          const body = Life.perchBody(r);
          if (!r.rel) r.rel = [r.pos[0] - at[0], r.pos[1] - at[1] - body, r.pos[2] - at[2]];
          for (let i = 0; i < 3; i++) {
            r.vel[i] += (-W * W * r.rel[i] - 2 * W * r.vel[i]) * h;
            r.rel[i] += r.vel[i] * h;
          }
          r.pos = [at[0] + r.rel[0], at[1] + body + r.rel[1], at[2] + r.rel[2]];
          r.fold = Math.min(1, r.settle);
          r.bank = 0;
          r.phase += TAU * r.sp.flapHz * dt;
          r.amp = Math.max(0, 1 - r.settle * 1.4);
          r.alpha = 1;
          // sitting once its wings are shut and it is still on the perch (within 5 mm)
          if (r.settle >= 1 && (Math.hypot(r.rel[0], r.rel[1], r.rel[2]) < 5e-6 || r.settle >= 2)) {
            r.rel = null;
            r.mode = 'perched';
            r.sit = rand(6, 25) * (1 + smooth(14, 4, w.windSpeed));
            r.lookIn = rand(1, 3);
            r.look = 0;
            r.pos = at.slice();
            r.vel = [0, 0, 0];
            r.amp = 0;
            r.flapLeft = 0;
          }
          return;
        }
      }
      if (r.mode === 'perched') {
        // it sits exactly on the snag, wherever the wind has it; longer in calm air, and off at once in rain or a gale
        r.sit -= dt;
        if (!at || r.sit <= 0 || !this._perchWeather(state)) this._takeOff(r);
        else {
          r.pos = at.slice();
          r.vel = [0, 0, 0];
          r.bank = 0;
          r.amp = 0;
          r.flapLeft = 0;
          // its head turns now and then
          r.lookIn -= dt;
          if (r.lookIn <= 0) {
            r.lookIn = rand(1.5, 6);
            r.look = rand(-1, 1);
          }
          r.alpha = 1;
          return;
        }
      }
      if (r.mode === 'approach') {
        if (!at || !this._perchWeather(state)) this._leaveTree(r);
        else {
          const dx = at[0] - r.pos[0];
          const dy = at[1] + Life.perchBody(r) - r.pos[1]; // its body, not its feet
          const dz = at[2] - r.pos[2];
          const d = Math.hypot(dx, dz);
          const d3 = Math.hypot(dx, dy, dz);
          const speedNow = Math.hypot(r.vel[0], r.vel[1], r.vel[2]);
          if (d3 < Math.max(0.0002, speedNow * 0.33) || (d3 < 0.003 && d3 < speedNow * dt * 1.5)) {
            // its feet reach the perch: it settles on to it and folds its wings (below), facing the way it came in
            r.mode = 'settle';
            r.settle = 0;
            r.rel = null;
            r.face =Math.hypot(r.vel[0], r.vel[2]) > 1e-6 ? [r.vel[0], r.vel[2]] : [dx || 1, dz];
            // On the side of the crown it turns as it folds its wings, to sit facing out, the way it will drop off
            // again (it would otherwise face into the leaves). On the top it sits facing the way it came.
            const out = this.perchOut ? this.perchOut(r.site || 0) : null;
            if (out && Math.hypot(out[0], out[2]) > 0.35) {
              const fa = Math.atan2(out[0], out[2]) + rand(-0.6, 0.6);
              r.face = [Math.sin(fa), Math.cos(fa)];
            }
          } else {
            // The way in, as one smooth line. It flies at a point below its perch that rises to it over the last
            // metres, so it comes in low and swoops up on to it, as a bird does to lose its speed. That speed falls
            // as under even braking (3 m/s2) to a walking pace at the perch. It turns gently far out and closely
            // near the tree, and beats its wings to brake over the last 15 m. One that set out behind the tree first
            // swings round to the open side (r.via), and no turn pulls harder than 1.4 g.
            if (r.via && Math.hypot(r.via[0] - r.pos[0], r.via[1] - r.pos[1], r.via[2] - r.pos[2]) < 0.025) r.via = null;
            const low = Math.min(0.0012, d3 * 0.12);
            const ax = r.via ? r.via[0] - r.pos[0] : dx;
            const ay = r.via ? r.via[1] - r.pos[1] : dy - low;
            const az = r.via ? r.via[2] - r.pos[2] : dz;
            const al = Math.hypot(ax, ay, az) || 1;
            const speed = Math.min(sp * 1.1, Math.sqrt(0.0006 * 0.0006 + 2 * 0.003 * Math.max(d3 - speedNow * 0.25, 0)));
            const k = 1 - Math.exp(-dt * (0.8 + 5 * smooth(0.06, 0.01, d3)));
            const dv = [((ax / al) * speed - r.vel[0]) * k, ((ay / al) * speed - r.vel[1]) * k, ((az / al) * speed - r.vel[2]) * k];
            const dl = Math.hypot(dv[0], dv[1], dv[2]);
            const lim = dl > 0.014 * dt ? (0.014 * dt) / dl : 1;
            for (let i = 0; i < 3; i++) r.vel[i] += dv[i] * lim;
            r.bank *= Math.exp(-dt * 2);
            if (d3 < 0.015) r.flapLeft = Math.max(r.flapLeft, 0.3);
          }
          r.pos[0] += r.vel[0] * dt;
          r.pos[1] += r.vel[1] * dt;
          r.pos[2] += r.vel[2] * dt;
        }
      } else if (r.mode === 'circle') {
        r.theta += r.omega * dt;
        if (r.sp !== SPECIES.kite) {
          // thermals drift downwind and lift the bird slowly (a kite stays low over its village)
          r.center[0] += state.windVel[0] * 0.3 * dt;
          r.center[1] += state.windVel[2] * 0.3 * dt;
          const cd = Math.hypot(r.center[0], r.center[1]);
          r.y = Math.min(r.y + 0.0012 * dt, this._view.camY + cd * Math.tan(18 * D2R));
        }
        const nx = r.center[0] + Math.cos(r.theta) * r.R;
        const nz = r.center[1] + Math.sin(r.theta) * r.R;
        r.vel = [(nx - r.pos[0]) / dt, (r.y - r.pos[1]) / dt, (nz - r.pos[2]) / dt];
        r.pos = [nx, r.y, nz];
        r.bank = Math.sign(r.omega) * Math.atan((sp * sp) / (G * r.R));
        r.circleTime -= dt;
        if (r.circleTime <= 0) {
          const homes = r.sp === SPECIES.kite ? this._kiteHomes() : [];
          if (homes.length && Math.random() < 0.7) {
            // a kite moves on to the next village, or round again over this one
            r.mode = 'glide';
            const home = homes[Math.floor(Math.random() * homes.length)];
            r.slopeHome = !!home.slope;
            r.target = this._overVillage(home);
          } else if (r.sp === SPECIES.kite || Math.random() < 0.5) this._leave(r);
          else {
            r.mode = 'glide';
            r.target = this._pointInView(rand(-0.8, 0.8), rand(0.15, 0.6), rand(-3, 12));
          }
        }
      } else if (r.mode !== 'approach' && r.mode !== 'settle') {
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
        // (rising or sinking comes on over half a second: set at once, a bird leaving the tree leapt upwards)
        r.vel[1] += (clamp(dy * 0.05, -0.001, 0.0008) - r.vel[1]) * (1 - Math.exp(-dt * 2));
        r.pos[0] += r.vel[0] * dt;
        r.pos[1] += r.vel[1] * dt;
        r.pos[2] += r.vel[2] * dt;
        r.bank *= Math.exp(-dt);
        if (r.mode === 'glide' && d < 0.04) {
          r.mode = 'circle';
          r.center = [tg[0], tg[2]];
          r.y = r.pos[1];
          r.R = r.sp === SPECIES.kite ? this._kiteRadius(r, 0.09) : rand(0.035, 0.09);
          r.theta = Math.atan2(r.pos[2] - tg[2], r.pos[0] - tg[0]);
          r.omega = (Math.random() < 0.5 ? -1 : 1) * (sp / r.R);
          r.circleTime = rand(60, 220);
        }
        if (r.mode === 'leave') {
          const seen = this._inView(this._project(...r.pos), 80);
          if (!seen && d < 0.15) r.dead = true;
          if (d < 0.02) r.dead = true;
          // A falcon off the tree is gone once it is out of the picture, or has shrunk to less than a pixel (one that
          // flew straight out over the valley): never where it could still be seen.
          if (r.sp === SPECIES.falcon) {
            const v = this._view;
            const far = Math.hypot(r.pos[0], r.pos[1] - v.camY, r.pos[2]);
            const at = this.perchAt ? this.perchAt(0) : null;
            const fromTree = at ? Math.hypot(r.pos[0] - at[0], r.pos[1] - at[1], r.pos[2] - at[2]) : 1;
            if (!seen && fromTree > 0.25) r.dead = true;
            if (r.sp.span / 2 / far / v.pxAng < 0.25) r.dead = true;
          }
        }
      }
      // occasional bursts of heavy wingbeats, otherwise soaring on still wings
      r.nextFlap -= dt;
      if (r.nextFlap <= 0) {
        r.flapLeft = rand(1.2, 2.4);
        r.nextFlap = r.sp === SPECIES.falcon ? rand(1.5, 4) : r.sp === SPECIES.kite ? rand(5, 14) : rand(15, 45); // a falcon beats its way along, a big one soars
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
      let alpha = 1;
      if (g.fadeIn) alpha = Math.min(alpha, smooth(0, g.fadeIn, g.age));
      if (g.fadeOutAt) alpha = Math.min(alpha, 1 - smooth(g.fadeOutAt - 5, g.fadeOutAt, g.age));
      let shows = false;
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
        b.alpha = alpha;
        if (!shows && alpha > 0.01 && this._birdShows(b)) shows = true;
      }
      // it goes once it has been seen and then every bird has been out of sight for a few seconds
      if (shows) {
        g.seen = true;
        g.hidden = 0;
      } else g.hidden += dt;
      if ((g.seen && g.hidden > 3) || g.age > g.maxAge) g.dead = true;
    }

    /** Whether a bird is drawn where it is now: in the frame and big enough to show (the size fade in _pushBird). */
    _birdShows(b) {
      const v = this._view;
      const p = b.pos;
      if (!this._inView(this._project(p[0], p[1], p[2]), 30)) return false;
      const dist = Math.hypot(p[0], p[1] - v.camY, p[2]);
      return smooth(0.3, 1.1, b.sp.span / 2 / dist / v.pxAng) > 0.01;
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
      const spread = k.spread || 0.15;
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
        cruise: k.cruise * rand(1 - spread, 1 + spread),
        bend,
        accel: k.accel * rand(0.85, 1.15),
        vPass: k.vPass || V_PASS, // the fastest it overtakes at
        beacon: !!k.beacon, // an ambulance's roof light
        group: 0, // the army column it belongs to
        yielding: false, // pulled in to let an ambulance by
        v: Math.min(k.cruise * 0.7, here),
        paint: paints[Math.floor(Math.random() * paints.length)],
        lane: k.lane,
        side: 0, // 0 its own lane, 1 out in the other to overtake, below 0 pulled in to the edge
        sideTarget: 0,
        pass: null, // the overtaking under way
        cool: k.beacon ? rand(0.5, 1.5) : rand(3, 12), // seconds before it may think of overtaking
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
      return x < 0.2 ? 'bus' : x < 0.55 ? 'jeep' : x < 0.85 ? 'motorcycle' : 'lorry';
    }

    /** An army column: a jeep leading three to six lorries, all at one pace, close together, hazard lights on. */
    _newConvoy(dir) {
      const k = VEHICLES.armyLorry;
      return { dir, left: 1 + Math.floor(rand(3, 7)), lead: true, group: ++this._groups, cruise: k.cruise * rand(0.92, 1.06), bend: k.bend, accel: k.accel };
    }

    /** The next vehicle of a column, at s on the road. Those behind the first go a little faster, to close up. */
    _convoyMember(q, s) {
      const c = this._newVehicle(q.lead ? 'armyJeep' : 'armyLorry', q.dir, s);
      const road = this.road;
      const here = road && road.limit ? road.limit[clamp(Math.round(s / road.step), 0, road.n - 1)] * q.bend : Infinity;
      Object.assign(c, { group: q.group, cruise: q.cruise * (q.lead ? 1 : 1.12), bend: q.bend, accel: q.accel, v: Math.min(q.cruise, here), blink: BLINK_BOTH, blinkFor: 99 });
      q.lead = false;
      q.left--;
      return c;
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
          // (and not into a column that is still coming on to the road there)
          const column = this._convoy && this._convoy.dir === dir;
          if (!column && this.vehicles.every((o) => (o.dir !== dir && o.side < 0.3) || Math.abs(o.s - s) > 0.06)) this.vehicles.push(this._newVehicle(this._pickVehicleKind(), dir, s));
        }
      }
      // where a vehicle comes on to the road, and whether its lane is clear there (for `room` km, or up to the last of
      // its own column)
      const endOf = (dir) => (dir > 0 ? 0.001 : road.length - 0.001);
      const endClear = (dir, room, group) =>
        this.vehicles.every((o) => (o.dir !== dir && o.side < 0.3) || Math.abs(o.s - endOf(dir)) > (group && o.group === group ? o.len / 2 + CONVOY_GAP + (VEHICLES.armyLorry.len * SIZE_ON_SCREEN) / 2 : room));
      // an army column: by day, when the road is open to ordinary traffic, about one in half an hour
      this._nextConvoy -= dt;
      if (this._nextConvoy <= 0) {
        this._nextConvoy = rand(1200, 2400) / (TRAFFIC[this.traffic] || 1);
        if (want >= 4 && state.astro.sunAltDeg > 3 && !this._convoy) this._convoy = this._newConvoy(Math.random() < 0.5 ? 1 : -1);
      }
      if (this._convoy) {
        const q = this._convoy;
        if (endClear(q.dir, 0.06, q.group)) this.vehicles.push(this._convoyMember(q, endOf(q.dir)));
        if (q.left <= 0) this._convoy = null;
      }
      // an ambulance: rare, at any hour
      this._nextAmbulance -= dt;
      if (this._nextAmbulance <= 0) {
        const dir = Math.random() < 0.5 ? 1 : -1;
        if (this.enabled && !(this._convoy && this._convoy.dir === dir) && endClear(dir, 0.06)) {
          this.vehicles.push(this._newVehicle('ambulance', dir, endOf(dir)));
          this._nextAmbulance = rand(1800, 3600);
        } else this._nextAmbulance = this.enabled ? 5 : 600;
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
        let siren = false; // an ambulance is coming up behind it
        let sirenOn = false; // or towards it
        for (const o of this.vehicles) {
          if (o === c) continue;
          if (o.beacon) {
            const back = (c.s - o.s) * c.dir;
            if (o.dir === c.dir && back > 0 && back < SIREN_BEHIND) siren = true;
            if (o.dir !== c.dir && back < 0 && back > -SIREN_AHEAD) sirenOn = true;
          }
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
          // (an army column drives close together)
          if (gap < (c.group && o.group === c.group ? CONVOY_GAP : 0.012 + c.v * 2)) target = Math.min(target, o.v * 0.95);
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

        // ---- an ambulance: those ahead of it indicate, pull in to the edge and slow down until it is past, then pull
        // out again; those coming towards it slow down. It still has to see its way clear to overtake, as anyone does.
        if (!c.beacon && !c.pass && !c.stopping && c.stopFor <= 0) {
          if (siren) {
            if (!c.yielding) {
              c.yielding = true;
              c.sideTarget = -0.5;
              if (!c.group) this._signal(c, BLINK_LEFT, 99);
            }
            // (an army column keeps its pace, or it would come apart as one after the other slowed)
            if (!c.group) target = Math.min(target, cruise * 0.45);
          } else if (c.yielding) {
            c.yielding = false;
            c.sideTarget = 0;
            if (!c.group) this._signal(c, BLINK_RIGHT, 2);
          }
        }
        if (sirenOn && !c.beacon) target = Math.min(target, cruise * 0.6);

        // ---- overtaking a slower one, or a line of them, where it can see the road ahead and nothing is coming. Any
        // faster vehicle that has caught up looks for its chance and takes it as soon as the way is clear: it never sits
        // for minutes behind a bus on an empty road. What stops it are the things that would cause a crash: something
        // coming, someone already out beside it, no room to get back in, a bend it can't see round.
        c.cool -= dt;
        // it starts looking once it has caught up: a little further out than it keeps its distance
        // (not a vehicle of an army column, nobody with an ambulance behind, and nobody past an ambulance: on the
        // bends a motorcycle is quicker than it, went by, and then pulled in and slowed down in front of it)
        if (!c.pass && c.cool <= 0 && mirror && ahead && aheadGap < 0.02 + c.v * 3 && c.side < 0.05 && !c.stopping && c.stopFor <= 0 && !c.group && !siren && !c.yielding && !ahead.beacon) {
          const vPass = Math.min(c.cruise * careful * 1.15, c.vPass);
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
            // An army column is passed as a whole, however long: never back in between two of its vehicles.
            const column = next && last.group && next.group === last.group;
            if (!next || (!column && g > Math.max(PASS_ROOM, cutInRoom(vPass, next) + 0.02))) break;
            if ((n >= 3 && !column) || next.pass || next.beacon || !slow(next)) ok = false;
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
            } else c.cool = c.beacon ? rand(0.4, 1) : rand(1.5, 4); // not here, not now: it keeps watching for a chance
          } else c.cool = c.beacon ? rand(0.4, 1) : rand(1.5, 4);
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
            // (never back in between two vehicles of an army column, however far apart they are)
            const inside = next && !gone && of.group && next.group === of.group;
            if (behindBy < -0.008 && (!next || (next !== beside && !inside && aheadGap > cutInRoom(c.v, next)))) {
              p.phase = 2; // past it, with room: back in
              c.sideTarget = 0;
              this._signal(c, BLINK_LEFT, 99);
            } else if (behindBy < -0.008) {
              const inColumn = !gone && of.group && next.group === of.group;
              p.of = next; // the next one is close: past that one too, as long as the way stays clear
              if (headOn < 0.12 && inColumn) p.phase = 3; // no time, and no room inside a column: drop back behind it
              else if (headOn < 0.12) {
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
            // back behind it before moving in, slowing down meanwhile (behind the whole of an army column, not in
            // between two of its vehicles)
            let rear = this.vehicles.includes(p.of) ? p.of : null;
            if (rear && rear.group) for (const o of this.vehicles) if (o.group === rear.group && (o.s - rear.s) * c.dir < 0) rear = o;
            if (rear) p.of = rear;
            const toRear = rear ? (rear.s - c.s) * c.dir + (rear.len + c.len) / 2 : -1;
            if ((!rear || toRear > rear.len + c.len + 0.003) && !beside) c.sideTarget = 0;
            if (rear) target = Math.min(target, rear.v * 0.7);
            if (c.blink !== BLINK_LEFT) this._signal(c, BLINK_LEFT, 99);
          }
          if ((p.phase === 2 || p.phase === 3) && c.sideTarget === 0 && c.side < 0.03) {
            c.pass = null;
            c.blinkFor = 0.8;
            c.cool = c.beacon ? rand(0.5, 1.5) : rand(3, 10); // a breath before it looks again: the next slow one may be just ahead
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
      const beam = Math.max(c.beam, flashing);
      const head = Life.headGlow(dist, facing, c.beam, flashing);
      const lamp = lampOn * R.headlight(facing) * head.fall;
      // tail lights: on whenever the headlights are, and brighter when braking, by day as well
      const rear = R.taillight(facing);
      const tail = rear * Math.max(lights * 0.5, c.brake * (0.3 + 0.7 * lights)); // by day a brake light is a small red point
      const braking = rear * c.brake;
      const blinkLit = c.blink && ((this.t * 1.4 + c.seed) % 1) < 0.55 ? c.blink : 0;
      // an ambulance's roof light: red and blue in turn, twice a second each, by day as well
      const beacon = c.beacon ? (Math.floor(this.t * 4 + c.seed * 4) % 2 ? BEACON_BLUE : BEACON_RED) : 0;
      let qx = Math.abs(ax) + Math.abs(bx) + 1.5;
      let qy = Math.abs(ay) + Math.abs(by) + halfH + 1.5;
      // room for the whole glow, so it fades out before the edge of the patch it is drawn on
      if (lamp > 0.003) {
        const room = Math.max((12 + 8 * head.glare) * head.near, 3);
        qx = Math.max(qx, Math.abs(ax) + Math.abs(bx) + room);
        qy = Math.max(qy, Math.abs(ay) + Math.abs(by) + halfH + room);
      }
      if (tail > 0.003 || blinkLit) {
        qx = Math.max(qx, Math.abs(ax) + Math.abs(bx) + 12);
        qy = Math.max(qy, Math.abs(ay) + Math.abs(by) + halfH + 12);
      }
      if (beacon) {
        qx = Math.max(qx, Math.abs(ax) + Math.abs(bx) + 16);
        qy = Math.max(qy, Math.abs(ay) + Math.abs(by) + halfH + 16);
      }
      // the light it throws on the road and the trees ahead: seen from any side, so before the vehicle itself
      if (lights > 0.02) this._pushBeam(c, f, [fx / fl, fy / fl, fz / fl], lights, beam, dist);
      // and the light its flashing lamps throw all round it in the dark, on the road, the bank and the trees beside
      // it: amber from hazard lights or an indicator (from that side of it), red then blue from an ambulance's roof.
      // Small bulbs with no reflector to aim them: far weaker than a headlight, and it reaches only a few lengths.
      if (lights > 0.02 && blinkLit) {
        const side = blinkLit === BLINK_BOTH ? 0 : blinkLit === BLINK_RIGHT ? 1 : -1;
        this._pushGlow([p[0] + (fz / flat) * hw * side, p[1] + c.hgt * 0.4, p[2] - (fx / flat) * hw * side], GLOW_AMBER, lights * (side ? 0.03 : 0.06), 0.025);
      }
      if (lights > 0.02 && beacon) this._pushGlow([p[0], p[1] + c.hgt + 0.0003, p[2]], beacon === BEACON_BLUE ? GLOW_BLUE : GLOW_RED, lights * 0.15, 0.045);
      this._push([
        pr.sx, pr.sy + halfH, qx, qy,
        0, 6, 1, dist,
        ax, ay, bx, by,
        halfH, c.paint, lamp, c.code,
        tail, head.glare, blinkLit + beacon, braking,
      ]);
    }

    /**
     * Type 7 too: the light a small lamp throws all round it (a cone of -2 tells the shader), in its own colour, on
     * whatever the bake stored within `range` km of it.
     */
    _pushGlow(at, colour, strength, range) {
      const v = this._view;
      const pr = this._project(at[0], at[1], at[2]);
      const dist = Math.hypot(at[0], at[1] - v.camY, at[2]);
      const half = Math.min(range / Math.max(dist, 0.01) / v.pxAng, 600) + 6; // px: everything it can light
      if (pr.sx + half < 0 || pr.sx - half > v.w || pr.sy + half < 0 || pr.sy - half > v.h) return;
      this._push([
        pr.sx, pr.sy, half, half,
        0, 7, strength, dist,
        at[0], at[1], at[2], range,
        0, 1, 0, -2,
        0, colour[0], colour[1], colour[2],
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
        0, 7, lights * k.power * (0.5 + 0.5 * beam), dist,
        lampP[0], lampP[1], lampP[2], range,
        fwd[0], fwd[1], fwd[2], cone,
        haze, beam, 0, 0,
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

      // ---- a field burning on a hill: now and then, more in the dry months, never in rain or snow or on soaked ground.
      // The chance had a floor of a quarter whatever the weather, and only rain over 0.3 put a fire out, so in drizzle
      // (0.12 to 0.3) a field could catch and burn on (the user saw one, 2026-11-22).
      const dryMonths = 0.5 + 0.5 * Math.cos((2 * Math.PI * (a.dayOfYear - 60)) / 365);
      const dry = dryMonths * (1 - smooth(0.4, 0.9, w.mist || 0)) * (1 - (w.wet || 0)) * (1 - smooth(0.02, 0.2, w.rain));
      const wetNow = w.rain > 0.01 || (w.snow || 0) > 0.01 || (w.wet || 0) > 0.3;
      this._nextFire -= dt;
      if (this._nextFire <= 0) {
        this._nextFire = rand(2400, 9000);
        const burning = this.smoke.some((s) => s.kind === SMOKE.fire);
        if (this._smokeOn(SMOKE.fire) && !burning && !wetNow && h > 9 && h < 19.5 && Math.random() < 0.25 + 0.75 * dry) {
          const s = this._newPlume(SMOKE.fire);
          if (s) this.smoke.push(s);
        }
      }
      // put out by any rain or snow, drizzle too
      for (const s of this.smoke) if (s.kind === SMOKE.fire && (w.rain > 0.05 || (w.snow || 0) > 0.05)) s.fading = true;

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
        if (kind === SMOKE.fire) {
          // A fire somewhere else each time (2026-11-26 the user: "forest fire looks like start from same place
          // everyday it should be random"). With no forest 3 to 8 km off, it always took the one place nearest 5 km,
          // and with only one or two there it came back to them. Now: the places 2.5 to 9 km off when there are at
          // least four, else the four nearest 5 km; never where either of the last two fires burned.
          const band = free.filter((s) => dist(s) > 2.5 && dist(s) < 9);
          const off5 = (s) => Math.abs(Math.log(dist(s) / 5)); // (2.5 km is as far from 5 as 10 km)
          const pick = band.length >= 4 ? band : free.slice().sort((a, b) => off5(a) - off5(b)).slice(0, 4);
          const fresh = pick.filter((s) => !this._recentFires.includes(s));
          const notLast = pick.filter((s) => s !== this._recentFires[0]); // (with two places only, they take turns)
          free = fresh.length ? fresh : notLast.length ? notLast : pick;
        } else {
          const near = free.filter((s) => dist(s) > 1.2 && dist(s) < 7);
          if (!near.length) return null;
          free = near;
        }
      }
      const src = free[Math.floor(Math.random() * free.length)];
      if (kind === SMOKE.fire) this._recentFires = [src, ...this._recentFires].slice(0, 2);
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

    // ------------------------------------------------------------ an airliner and its contrail
    /**
     * A flight: straight and level at 10 to 11.5 km above the sea, passing 22 to 55 km from the viewer, mostly across
     * the view. It is followed from where it comes into sight to where it leaves, and its trail for as long as that
     * lasts: half a minute for some, many minutes for others (more of those where there is high cloud), and it
     * drifts with the wind at that height. `shown` puts it part of the way across at once (the test panel).
     */
    _newPlane(state, shown) {
      const v = this._view;
      const az = rand(-0.42, 0.42) * v.hfov;
      const alt = rand(10, 11.5);
      // Two flights in five come towards the viewer or go away, passing nearly overhead: on the picture such a one
      // climbs from behind the peaks and leaves over the top, or comes in at the top and sinks behind the peaks.
      const radial = Math.random() < 0.4;
      let near;
      let th;
      if (radial) {
        near = 45;
        th = az + (Math.random() < 0.5 ? 0 : Math.PI) + rand(-0.08, 0.08);
      } else {
        // the point of its path at that bearing: further off the more its path leans towards or away from the
        // viewer, so that where it passes nearest is 22 to 55 km off: high enough on the picture to clear the peaks
        const lean = rand(-0.9, 0.9);
        near = rand(22, 55) / Math.cos(lean);
        th = az + (Math.random() < 0.5 ? 1 : -1) * (Math.PI / 2 + lean);
      }
      const C = [Math.sin(az) * near, Math.cos(az) * near];
      const dir = [Math.sin(th), Math.cos(th)];
      const top = (1 - v.horizonY) * v.h * v.pxAng + 0.03; // how steeply up the top edge of the picture is, and a little
      const out = (s) => {
        const x = C[0] + dir[0] * s;
        const z = C[1] + dir[1] * s;
        const d = Math.hypot(x, z);
        return d > PLANE_FAR || Math.abs(Math.atan2(x, z)) > v.hfov / 2 + 0.12 || alt - v.camY - (d * d) / 12742 > top * d;
      };
      let s0 = 0;
      while (!out(s0) && s0 > -400) s0 -= 2;
      let s1 = 0;
      while (!out(s1) && s1 < 400) s1 += 2;
      const w = state.weather;
      // Some flights leave a long trail and some a short stub, at random: one in two even in dry air, nine in ten
      // where there is high cloud (the air up there is moist). (Until 2.8.0 only high cloud made it long, so under a
      // clear sky every trail was a stub; the user, 2026-11-24: "keep both short and long smoke but should appear
      // randomly".)
      const moist = smooth(0.08, 0.55, w.cirrus || 0);
      const life = Math.random() < 0.5 + 0.4 * moist ? rand(240, 660) : rand(20, 60);
      const h = (state.heading || 0) * D2R;
      const E = w.cirrusE || 0;
      const N = w.cirrusN || 0;
      const p = {
        C, dir, s0, alt, radial, t: 0, life, seed: Math.random(),
        cross: (s1 - s0) / PLANE_V, // seconds in sight
        wind: [(E * Math.cos(h) - N * Math.sin(h)) / 3600, (E * Math.sin(h) + N * Math.cos(h)) / 3600], // km/s, scene axes
      };
      if (shown) p.t = clamp((-s0 + rand(-0.25, 0.25) * Math.min(-s0, s1)) / PLANE_V, 0, p.cross);
      return p;
    }

    _stepPlanes(dt, state) {
      if (!this.enabled || !this.planes) {
        this.aircraft = [];
        return;
      }
      for (const p of this.aircraft) p.t += dt;
      this.aircraft = this.aircraft.filter((p) => p.t < p.cross + p.life);
      // One every 5 to 15 minutes, and a third as many in the small hours. (Every 10 to 30 before 2.8.0, which with the
      // desktop mostly covered was hardly ever.) One that was due part of the way through a long step, as a minute held
      // still, is already as far along as it would be had it set off then.
      this._nextPlane -= dt;
      for (let n = 0; this._nextPlane <= 0 && n < 12; n++) {
        const late = -this._nextPlane;
        const h = state.now.getHours() + state.now.getMinutes() / 60;
        this._nextPlane += rand(300, 900) * (h < 5 || h >= 23.5 ? 3 : 1);
        // at most two in sight; the trails of ones gone by may stay a while longer, and do not hold a new one back
        if (this.aircraft.filter((q) => q.t < q.cross).length < 2 && this.aircraft.length < 4) {
          const p = this._newPlane(state, false);
          p.t = late;
          if (p.t < p.cross + p.life) this.aircraft.push(p);
        }
      }
      if (this._nextPlane <= 0) this._nextPlane = rand(300, 900);
    }

    /** Where the air an aircraft passed through `age` seconds ago is now: on the picture, and how far off (km). */
    _trailAt(p, age) {
      const v = this._view;
      const s = p.s0 + PLANE_V * (p.t - age);
      const x = p.C[0] + p.dir[0] * s + p.wind[0] * age;
      const z = p.C[1] + p.dir[1] * s + p.wind[1] * age;
      const d = Math.hypot(x, z);
      const y = p.alt - v.camY - (d * d) / 12742; // the Earth curves away below it
      const px = this._projectDir([x, y, z]);
      return { sx: px[0], sy: px[1], dist: Math.hypot(d, y), up: y };
    }

    /** Type 8: the contrail as a row of straight pieces (it curves on a picture this wide), and the aircraft at its head. */
    _pushPlane(p, state) {
      const v = this._view;
      const T = Math.min(p.t, p.life);
      const head = this._trailAt(p, 0);
      if (T > 1) {
        const tail = this._trailAt(p, T);
        const n = clamp(Math.ceil(Math.hypot(tail.sx - head.sx, tail.sy - head.sy) / 160), 2, 16);
        const wide = (age, dist) => (TRAIL_W0 + TRAIL_SPREAD * age) / dist / v.pxAng;
        let a = head;
        for (let i = 0; i < n; i++) {
          const a0 = (T * i) / n;
          const a1 = (T * (i + 1)) / n;
          const b = this._trailAt(p, a1);
          const from = a;
          a = b;
          if ((from.up <= 0 && b.up <= 0) || Math.max(from.sx, b.sx) < -80 || Math.min(from.sx, b.sx) > v.w + 80) continue;
          const len = Math.hypot(b.sx - from.sx, b.sy - from.sy);
          if (len < 0.05) continue;
          const w0 = wide(a0, from.dist);
          const w1 = wide(a1, b.dist);
          this._push([
            (from.sx + b.sx) / 2, (from.sy + b.sy) / 2, len / 2 + 0.5, 2.2 * Math.max(w0, w1, 0.6) + 1.5,
            Math.atan2(b.sy - from.sy, b.sx - from.sx), 8, 1, 0,
            p.t - a0, p.t - a1, p.t, p.life, // when the air at each end of this piece was flown through, now, how long it lasts
            w0, w1, len / 2, 0,
            p.seed * 97, 0, 0, 0,
          ]);
        }
      }
      if (p.t < p.cross && head.up > 0 && head.sx > -10 && head.sx < v.w + 10) {
        // by day a pale fleck, lost with distance; by night a steady red light and a white flash every second or so
        const strobe = (this.t * 0.8 + p.seed) % 1 < 0.14 ? 1 : 0;
        this._push([
          head.sx, head.sy, 4, 4,
          0, 8, 1, 0,
          strobe, 1 - smooth(-6, 0, state.astro.sunAltDeg), 1 - smooth(60, 130, head.dist), 0,
          0, 0, 0, 1,
        ]);
      }
    }

    // ------------------------------------------------------------ grazing animals, the monastery, a helicopter
    /**
     * Each animal grazes where it stands for a while, then walks a few metres at a slow walk (0.25 m/s) to another
     * spot within 30 m of the middle of its herd, and grazes again. They are out by day; at dusk they are taken in.
     */
    _stepHerds(dt, daylight) {
      this._herdsOut = this.enabled && this.animals ? smooth(0.3, 0.7, daylight) : 0;
      if (this._herdsOut <= 0) return;
      for (const h of this.herds) {
        for (const a of h.animals) {
          if (a.wait > 0) {
            a.wait -= dt;
            continue;
          }
          const dx = a.tx - a.x;
          const dz = a.tz - a.z;
          const d = Math.hypot(dx, dz);
          const step = 0.00025 * dt;
          if (d <= step) {
            a.x = a.tx;
            a.z = a.tz;
            a.wait = rand(10, 70);
            const ang = rand(0, TAU);
            const r = Math.sqrt(Math.random()) * 0.03;
            a.tx = Math.cos(ang) * r;
            a.tz = Math.sin(ang) * r;
          } else {
            a.x += (dx / d) * step;
            a.z += (dz / d) * step;
            a.dir = [dx / d, dz / d];
          }
        }
      }
    }

    /** Where an animal of a herd stands (km): on the slope of its meadow, which is flat enough to be taken as a plane. */
    static animalAt(herd, a) {
      const { x, y, z, n } = herd.at;
      return [x + a.x, y - (n[0] * a.x + n[2] * a.z) / Math.max(n[1], 0.3), z + a.z];
    }

    _pushHerds(state) {
      const v = this._view;
      const out = this._herdsOut || 0;
      if (out <= 0) return;
      for (const h of this.herds) {
        if (h.at.y > state.snowLine - 0.2) continue; // nothing grazes on snow
        for (const a of h.animals) {
          const p = Life.animalAt(h, a);
          const pr = this._project(p[0], p[1], p[2]);
          if (!this._inView(pr, 10)) continue;
          const dist = Math.hypot(p[0], p[1] - v.camY, p[2]);
          // 1.5 m long and 0.9 m at the shoulder; smaller than a pixel it is drawn a pixel wide and fainter
          const hw = 0.00075 / dist / v.pxAng;
          const hh = 0.00045 / dist / v.pxAng;
          const k = Math.max(0.7 / hw, 1);
          if (a.dir) {
            const sideways = a.dir[0] * Math.cos(pr.a) - a.dir[1] * Math.sin(pr.a);
            if (Math.abs(sideways) > 0.2) a.face = sideways > 0 ? 1 : -1;
          }
          this._push([
            pr.sx, pr.sy + hh * k, hw * k + 0.5, hh * k + 0.5,
            0, 11, out / (k * k), dist,
            0, a.shade, a.face, 0,
          ]);
        }
      }
    }

    // ------------------------------------------------------------ goats on the rock by the tree
    /**
     * The top of the rock by the tree as the eye sees it (Renderer.ledgeMap): where goats can stand. A herd on a far
     * meadow is less than a pixel from here and the near slopes are all forest (2026-11-18: the user had the switch on
     * and saw no animal at all), so the animals one sees graze here: two to four goats, there already when the scene
     * starts by day, now and then away for a while and walking back in from the left, and off to the left at dusk or in
     * heavy rain or snow. Turned off, they go at once, as the birds do.
     */
    setLedge(ledge) {
      this.ledge = ledge || null;
      this.goats = [];
      this._goatsSeen = false;
      this._goatSpots = null;
    }

    _ledgeCellAt(X, D) {
      const L = this.ledge;
      const i = Math.floor((X - L.x0) / L.cell);
      const k = Math.floor((D - L.d0) / L.cell);
      return i < 0 || k < 0 || i >= L.nx || k >= L.nd ? -1 : k * L.nx + i;
    }

    /** The height of the rock's top at (X, D), m above the tree's foot, from the cells round it the eye sees; else NaN. */
    _ledgeY(X, D) {
      const L = this.ledge;
      const fx = (X - L.x0) / L.cell - 0.5;
      const fd = (D - L.d0) / L.cell - 0.5;
      const i = Math.floor(fx);
      const k = Math.floor(fd);
      let sum = 0;
      let wsum = 0;
      for (let b = 0; b <= 1; b++) {
        for (let a = 0; a <= 1; a++) {
          const ii = i + a;
          const kk = k + b;
          if (ii < 0 || kk < 0 || ii >= L.nx || kk >= L.nd) continue;
          const y = L.h[kk * L.nx + ii];
          if (!(y === y)) continue;
          const wgt = (a ? fx - i : 1 - fx + i) * (b ? fd - k : 1 - fd + k) + 1e-4;
          sum += y * wgt;
          wsum += wgt;
        }
      }
      return wsum > 0 ? sum / wsum : NaN;
    }

    /**
     * Can a goat stand at (X, D): on the top, not the face under the rim (no lower than the top's own dip), with the top
     * seen all round it and not too uneven, clear of the trunk and of the flags' stake (foreground.js: 3.6 m to the left
     * of the tree, 0.8 m nearer).
     */
    _goatGround(X, D) {
      const y = this._ledgeY(X, D);
      if (!(y > -0.35 - 0.015 * Math.max(-X, 0)) || y > 0.75) return false;
      if (Math.hypot(X, D) < 2.1 || Math.hypot(X + 3.6, D + 0.8) < 0.9) return false;
      for (const [dx, dd] of GOAT_AROUND) {
        if (!(Math.abs(this._ledgeY(X + dx, D + dd) - y) < 0.3)) return false;
      }
      return true;
    }

    /** Every place on the rock a goat can stand, [X, D, grass], once for each rock map. */
    _goatSpotsList() {
      if (this._goatSpots) return this._goatSpots;
      const L = this.ledge;
      const out = [];
      for (let k = 0; k < L.nd; k++) {
        for (let i = 0; i < L.nx; i++) {
          const c = k * L.nx + i;
          if (!(L.h[c] === L.h[c])) continue;
          const X = L.x0 + (i + 0.5) * L.cell;
          const D = L.d0 + (k + 0.5) * L.cell;
          if (this._goatGround(X, D)) out.push([X, D, L.grass[c]]);
        }
      }
      return (this._goatSpots = out);
    }

    /** Somewhere to go: on the rock, rMin to rMax from (X, D), mostly across the view, clear of the others, grass first. */
    _goatSpot(X, D, rMin, rMax, self) {
      let best = null;
      let bs = -1;
      for (let n = 0; n < 48; n++) {
        const r = rand(rMin, rMax);
        const a = Math.random() < 0.7 ? rand(-0.45, 0.45) + (Math.random() < 0.5 ? 0 : Math.PI) : rand(0, TAU);
        const x = X + Math.cos(a) * r;
        const d = D + Math.sin(a) * r;
        if (!this._goatGround(x, d)) continue;
        if (this.goats.some((o) => o !== self && (Math.hypot(o.X - x, o.D - d) < 1.2 || Math.hypot(o.tx - x, o.td - d) < 1.2))) continue;
        const c = this._ledgeCellAt(x, d);
        const score = (c >= 0 ? this.ledge.grass[c] : 0) + Math.random() * 0.5;
        if (score > bs) {
          bs = score;
          best = [x, d];
        }
      }
      return best;
    }

    /** Where a goat is, in the scene's km. */
    _goatWorld(X, D, Y) {
      const L = this.ledge;
      const s = L.site;
      return [(s[0] + X * L.az + D * L.ax) / 1000, this._view.camY + (s[1] + Y) / 1000, (s[2] - X * L.ax + D * L.az) / 1000];
    }

    /** A point at depth D on the rock, off the picture on the left by a goat's length (the i-th of a file a little further). */
    _offLeft(D, i) {
      let X = this.ledge.minX;
      for (let k = 0; k < 80; k++, X -= 0.5) {
        const p = this._goatWorld(X, D, 0);
        const pr = this._project(p[0], p[1], p[2]);
        if (pr.sx < -1.3 / (pr.r * 1000 * this._view.pxAng)) break;
      }
      return [X - i * rand(1.3, 2.2), D];
    }

    _newGoat(X, D, kid) {
      const y = this._ledgeY(X, D);
      return {
        X, D, Y: y === y ? y : 0,
        h: Math.random() < 0.5 ? 0 : Math.PI, // which way it heads on the rock (0: along X, to the right)
        mode: 'graze', wait: rand(2, 20), tx: X, td: D, speed: 0,
        phase: rand(0, TAU), stride: 0, head: 1, headT: 1,
        size: kid ? rand(0.55, 0.68) : rand(0.92, 1.06),
        coat: GOAT_COATS[Math.floor(Math.random() * GOAT_COATS.length)],
        seed: kid ? rand(0, 0.11) : rand(0.12, 1), // a kid: no horns and no beard, a bigger head; above 0.7 a buck (goats.js goatPose)
        clock: rand(0, 100),
      };
    }

    /** A herd: grazing there already, or walking in one after the other from the left. False if the rock has no room. */
    _goatHerd(walkIn) {
      const spots = this._goatSpotsList();
      if (spots.length < 8) return false;
      const mid = spots[Math.floor(Math.random() * spots.length)];
      const n = Math.random() < 0.3 ? 2 : Math.random() < 0.65 ? 3 : 4;
      this.goats = [];
      for (let i = 0; i < n; i++) {
        const at = this._goatSpot(mid[0], mid[1], i ? 0.8 : 0, 3.5, null) || (i ? null : mid);
        if (!at) continue;
        const g = this._newGoat(at[0], at[1], i > 0 && Math.random() < 0.3);
        if (walkIn) {
          const from = this._offLeft(at[1], i);
          Object.assign(g, { X: from[0], D: from[1], h: 0, mode: 'arrive', speed: rand(0.5, 0.6), head: 0.1, headT: 0.1 });
        }
        this.goats.push(g);
      }
      this._goatStay = rand(2400, 7200);
      return this.goats.length > 0;
    }

    _goatLeave(g) {
      const off = this._offLeft(g.D, 0);
      Object.assign(g, { mode: 'leave', tx: off[0] - rand(0, 1.5), td: g.D, speed: rand(0.5, 0.65), headT: 0.1 });
    }

    /** The middle of the herd, without this one. */
    _goatMiddle(self) {
      const others = this.goats.filter((o) => o !== self && o.mode !== 'leave');
      if (!others.length) return null;
      return [others.reduce((s, o) => s + o.X, 0) / others.length, others.reduce((s, o) => s + o.D, 0) / others.length];
    }

    _goatArrived(g) {
      if (g.mode === 'leave') {
        g.gone = true;
        return;
      }
      Object.assign(g, { mode: 'graze', headT: rand(0.85, 1), wait: rand(8, 30), speed: 0, tx: g.X, td: g.D });
    }

    /** What it does next: a step or two with its head still down, a look round, or a walk to another patch near the others. */
    _goatNext(g) {
      const r = Math.random();
      if (g.mode === 'graze' && r < 0.5) {
        const at = this._goatSpot(g.X, g.D, 0.35, 1.2, g);
        if (at) return Object.assign(g, { mode: 'nibble', tx: at[0], td: at[1], speed: 0.22, headT: 0.8 });
      }
      if (g.mode === 'graze' && r < 0.72) return Object.assign(g, { mode: 'look', headT: rand(0, 0.2), wait: rand(3, 9) });
      const m = this._goatMiddle(g) || [g.X, g.D];
      const at = this._goatSpot(m[0], m[1], 0.8, 3.8, g);
      if (at && Math.hypot(at[0] - g.X, at[1] - g.D) > 0.6) return Object.assign(g, { mode: 'walk', tx: at[0], td: at[1], speed: rand(0.45, 0.6), headT: 0.12 });
      Object.assign(g, { mode: 'graze', headT: rand(0.85, 1), wait: rand(6, 20) });
    }

    _stepGoat(g, dt) {
      g.clock += dt;
      g.head += (g.headT - g.head) * (1 - Math.exp(-dt / 0.7));
      if (g.mode === 'graze' || g.mode === 'look') {
        g.stride *= Math.exp(-dt / 0.25);
        g.wait -= dt;
        if (g.wait <= 0) this._goatNext(g);
        return;
      }
      const dx = g.tx - g.X;
      const dd = g.td - g.D;
      const far = Math.hypot(dx, dd);
      if (far < 0.03) return this._goatArrived(g);
      const turn = ((((Math.atan2(dd, dx) - g.h) % TAU) + TAU + Math.PI) % TAU) - Math.PI;
      g.h += clamp(turn, -1.8 * dt, 1.8 * dt);
      const v = g.speed * smooth(0.2, 0.9, Math.cos(turn)); // it turns before it goes
      const step = Math.min(v * dt, far);
      g.stride += (smooth(0, 0.35, v) - g.stride) * (1 - Math.exp(-dt / 0.25));
      g.phase = (g.phase + (step / (0.6 * g.size)) * TAU) % TAU; // a whole step, all four feet, every 0.6 m
      const nx = g.X + Math.cos(g.h) * step;
      const nd = g.D + Math.sin(g.h) * step;
      // walking in and out it may cross the rock beyond the picture; on it, the rim or the trunk stops it to think again
      if (g.mode !== 'arrive' && g.mode !== 'leave' && !this._goatGround(nx, nd)) return this._goatArrived(g);
      g.X = nx;
      g.D = nd;
      const y = this._ledgeY(g.X, g.D);
      if (y === y) g.Y += (y - g.Y) * (1 - Math.exp(-dt / 0.2));
      if (v > 0 && step >= far - 1e-9) this._goatArrived(g);
    }

    _stepGoats(dt, state) {
      if (!this.ledge || !this._view) return;
      if (!(this.enabled && this.animals)) {
        this.goats = [];
        return;
      }
      const w = state.weather;
      const here = this.goats.some((g) => g.mode !== 'leave');
      const out = w.rain < 0.3 && w.snow < 0.35 && w.storm < 0.5 && state.astro.sunAltDeg > (here ? 1 : 4);
      if (!this._goatsSeen) {
        this._goatsSeen = true;
        if (out) this._goatHerd(false);
        else this._goatsAway = rand(120, 900);
      } else if (here) {
        this._goatStay -= dt;
        if (!out || this._goatStay <= 0) for (const g of this.goats) if (g.mode !== 'leave') this._goatLeave(g);
      } else if (!this.goats.length && out) {
        this._goatsAway -= dt;
        if (this._goatsAway <= 0 && !this._goatHerd(true)) this._goatsAway = 600;
      }
      for (const g of this.goats) this._stepGoat(g, dt);
      const before = this.goats.length;
      this.goats = this.goats.filter((g) => !g.gone);
      if (before && !this.goats.length) this._goatsAway = rand(480, 1500);
    }

    /** How many goats in view are walking: their legs need the birds' frame rate. goats.js draws them. */
    _goatsWalking() {
      const v = this._view;
      if (!this.ledge || !v || !this.goats.length) return 0;
      let walking = 0;
      for (const g of this.goats) {
        if (!(g.stride > 0.05)) continue;
        const p = this._goatWorld(g.X, g.D, g.Y);
        const pr = this._project(p[0], p[1], p[2]);
        if (this._inView(pr, 1.2 / (pr.r * 1000 * v.pxAng))) walking++;
      }
      return walking;
    }

    /** The monastery's lamp: one warm light on its ridge from dusk to dawn, with the village lights. */
    _pushGompa(state) {
      const g = this.gompa;
      const lit = this.enabled && this.lights ? state.lampGlow || 0 : 0;
      if (!g || lit <= 0.01) return;
      const pr = this._project(g.x, g.y + 0.006, g.z);
      if (!this._inView(pr, 10)) return;
      this._push([
        pr.sx, pr.sy, 5, 5,
        0, 11, lit, Math.hypot(g.x, g.y + 0.006 - this._view.camY, g.z),
        1, 0, 1, 0,
      ]);
    }

    /**
     * A helicopter now and then by day in fair weather: straight and level along the valley, 0.8 to 2.2 km off, a
     * little above or below the eye: near enough to be seen for what it is (further off it is a dot). Mountains
     * nearer than it hide it as it passes behind them. One of three paints: rescue red and white, army olive,
     * white and blue.
     */
    _newHeli(shown) {
      const v = this._view;
      const side = Math.random() < 0.5 ? -1 : 1;
      const near = rand(0.8, 2.2);
      const lean = rand(-0.15, 0.15); // nearly across the view: leaning more, it would never leave the widest one
      const th = side * (Math.PI / 2 + lean);
      const dir = [Math.sin(th), Math.cos(th)];
      const C = [0, near];
      let s0 = 0;
      const out = (s) => Math.abs(Math.atan2(C[0] + dir[0] * s, C[1] + dir[1] * s)) > v.hfov / 2 + 0.06;
      while (!out(s0) && s0 > -60) s0 -= 0.2;
      let s1 = 0;
      while (!out(s1) && s1 < 60) s1 += 0.2;
      return { C, dir, s: shown ? rand(-0.3, 0.3) * Math.min(-s0, s1) : s0, s1, y: v.camY + near * rand(-0.08, 0.2), turn: 0, paint: Math.floor(Math.random() * 3), seed: Math.random() };
    }

    _stepHeli(dt, state, fair) {
      const w = state.weather;
      if (!this.enabled || !this.planes) {
        this.heli = null;
        return;
      }
      if (!this.heli) {
        this._nextHeli -= dt;
        if (this._nextHeli <= 0) {
          // one every 15 to 40 minutes by day; they do not fly these valleys in rain, fog, a gale or under a closed
          // deck. (Every 40 minutes to two hours and only under less than 80 % cloud before 2.8.1: the airport's usual
          // broken deck at 10,000 ft held them back, and the user, 2026-11-24: "also i dont see any helicopter".)
          this._nextHeli = rand(900, 2400);
          if (fair > 0.8 && w.windSpeed < 40 && w.coverage < 0.9) this.heli = this._newHeli(false);
        }
        return;
      }
      const h = this.heli;
      h.s += HELI_V * dt;
      h.turn += dt * 40;
      if (h.s > h.s1) this.heli = null;
    }

    static heliAt(h) {
      return [h.C[0] + h.dir[0] * h.s, h.y, h.C[1] + h.dir[1] * h.s];
    }

    _pushHeli(state) {
      const h = this.heli;
      if (!h) return;
      const v = this._view;
      const p = Life.heliAt(h);
      const pr = this._project(p[0], p[1], p[2]);
      if (!this._inView(pr, 20)) return;
      const dist = Math.hypot(p[0], p[1] - v.camY, p[2]);
      // 25 m from nose to tail rotor under a 21 m rotor; seen more or less from the side as it crosses. The patch
      // has room round it for its lights, which show as the day goes: a red flash, the side light, tail and nose.
      const hw = Math.max(0.0125 / dist / v.pxAng, 3);
      const along = h.dir[0] * Math.cos(pr.a) - h.dir[1] * Math.sin(pr.a);
      this._push([
        pr.sx, pr.sy, hw * 1.08 + 6, hw * 0.45 + 6,
        0, 11, 1, dist,
        2, h.turn, along >= 0 ? 1 : -1, h.paint,
        hw, 1 - smooth(-6, 0, state.astro.sunAltDeg), (this.t * 1.1 + h.seed) % 1 < 0.12 ? 1 : 0, 0,
      ]);
    }

    // ------------------------------------------------------------ festival fireworks
    /**
     * On a festival night (environment.js festival) rockets go up from the villages now and then: after dark, in dry
     * air one can see through, mostly before midnight. One every 8 to 35 seconds on the night itself across all the
     * villages in view, fewer on the nights around it; from the test panel one every few seconds. The villages here are
     * 9 to 16 km off, where the little ones first made (2026-11-19, the user: "festival night have no effect") were a
     * white dot of a few pixels, so these are the biggest shells of a town's show, bursting 250 to 400 m up into balls
     * 300 to 400 m across, some 50 px on a 4K screen 11 km off: enough to see the sparks fly.
     */
    _stepFireworks(dt, state) {
      const w = state.weather;
      const fest = this.enabled && this.lights ? Math.max(state.festival || 0, this.festForce || 0) : 0;
      const ok = fest * smooth(-6, -10, state.astro.sunAltDeg) * (1 - smooth(0.05, 0.3, w.rain)) * (1 - smooth(0.05, 0.3, w.snow)) * (1 - smooth(0.3, 0.7, w.fog)) * (1 - smooth(0.6, 0.9, w.coverage));
      if (ok > 0.01) {
        const h = state.now.getHours() + state.now.getMinutes() / 60;
        this._nextFirework -= dt * ok * (h >= 12 && h < 23.5 ? 1 : 0.15);
        if (this._nextFirework <= 0) {
          this._nextFirework = this.festForce ? rand(2.5, 7) : rand(8, 35);
          const f = this.fireworks.length < (this.festForce ? 6 : 4) ? this._newFirework() : null;
          if (f) this.fireworks.push(f);
        }
      }
      for (const f of this.fireworks) f.age += dt;
      this.fireworks = this.fireworks.filter((f) => f.age < f.life);
    }

    /** A shell from somewhere in a village: up 250 to 400 m in two or three seconds, then a ball of sparks 150 to 200 m across its radius. */
    _newFirework() {
      const list = this.smokeSources;
      if (!list.length) return null;
      const src = list[Math.floor(Math.random() * list.length)];
      const rise = rand(2.0, 2.8);
      return {
        at: [src.x + rand(-0.03, 0.03), src.y + 0.004, src.z + rand(-0.03, 0.03)],
        height: rand(0.25, 0.4), rise, age: -rise, life: rand(2.4, 3.4), radius: rand(0.15, 0.2), seed: rand(0, 50),
        colour: FIREWORK_COLOURS[Math.floor(Math.random() * FIREWORK_COLOURS.length)],
      };
    }

    /** Where a firework is now (km): climbing, slowing to the top of its rise, where it bursts and stays. */
    static fireworkAt(f) {
      const k = clamp(-f.age / f.rise, 0, 1);
      return [f.at[0], f.at[1] + f.height * (1 - k * k), f.at[2]];
    }

    /** Type 10. */
    _pushFirework(f) {
      const v = this._view;
      const p = Life.fireworkAt(f);
      const pr = this._project(p[0], p[1], p[2]);
      if (!this._inView(pr, 30)) return;
      const dist = Math.hypot(p[0], p[1] - v.camY, p[2]);
      const R = f.radius / dist / v.pxAng;
      const half = f.age < 0 ? 9 : R * 2.2 + 4;
      this._push([
        pr.sx, pr.sy, half, half,
        0, 10, 1, dist,
        f.age, f.life, f.seed, R,
        f.colour[0], f.colour[1], f.colour[2], 0,
      ]);
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

    /** Is this bird at the tree: sitting on it, or within 45 m of its perch on the way in or out? */
    _nearTree(r) {
      if (r.mode === 'perched') return true;
      const at = this._siteAt(r);
      return !!at && Math.hypot(r.pos[0] - at[0], r.pos[1] - at[1], r.pos[2] - at[2]) < 0.045;
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
      // (wings closing as it settles on the tree, opening as it leaves it)
      const spanF = Math.max(Math.hypot(sx, sy), 0.24) * (1 - 0.65 * (b.fold || 0));
      const roll = Math.atan2(sy, sx);
      // body direction on screen (rotated into the wing frame)
      const bx = fx * right[0] + fz * right[2];
      const by = clamp(b.vel[1] / Math.max(Math.hypot(b.vel[0], b.vel[1], b.vel[2]), 1e-6), -0.6, 0.6);
      const cr = Math.cos(-roll);
      const sr = Math.sin(-roll);
      const lbx = bx * cr - by * sr;
      const lby = bx * sr + by * cr;
      // (close by, at the tree, its lit side shows whichever way it is seen: it was a black shape against the sky)
      const topSeen = Math.max(smooth(0.0, 0.08, -dy / dist), 0.6 * (1 - smooth(0.05, 0.12, dist)));
      // How much of it is the sitting bird: all of it on the perch; coming in as its wings close and going out as
      // they open, the sitting shape and the flying one fade into each other where its body is, so neither pops up.
      // (The flying bird is drawn about its body, the sitting one from its feet: flying, its body is that much above
      // the perch, see Life.perchBody.)
      const sitting = b.mode === 'perched' ? 1 : !b.face ? 0 : b.mode === 'settle' ? smooth(0.5, 1, b.settle) : b.mode === 'leave' ? b.fold || 0 : 0;
      if (sitting > 0.01) {
        // Type 9: sitting, wings folded. Its feet are on the perch; the patch holds it and the tail hanging below.
        const tall = (b.sp.tall || 0.00062) / dist / v.pxAng; // px: as tall as its kind sits
        const feet = pr.sy - (b.mode === 'perched' ? 0 : Life.perchBody(b) / dist / v.pxAng);
        const faceX = b.face[0] * right[0] + b.face[1] * right[2];
        this._push([
          pr.sx, feet + tall * 0.3, tall * 0.75, tall * 0.95,
          0, 9, (b.alpha ?? 1) * sitting, dist,
          faceX >= 0 ? 1 : -1, b.look || 0, tall, 0,
          0, 0, 1, 0,
        ]);
        if (sitting >= 1) return;
      }
      const hs = Math.max(halfSpanPx, 1.2) * 1.3;
      this._push([
        pr.sx, pr.sy, hs, hs,
        roll, b.sp.type, (b.alpha ?? 1) * sizeFade * (1 - sitting), dist,
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
      // (one close to the tree is kept for the end: it is drawn after the tree, in front of it)
      const near = this.raptors.filter((r) => this._nearTree(r));
      for (const r of this.raptors) if (!near.includes(r)) this._pushBird(r);
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

      // Aircraft and their trails: a few pixels a second at most on the picture, so they do not ask for more frames
      for (const p of this.aircraft) this._pushPlane(p, state);
      for (const f of this.fireworks) this._pushFirework(f);
      this._pushHerds(state);
      const goatsWalking = this._goatsWalking();
      this._pushGompa(state);

      const skyFrom = this.count;
      // (a helicopter crosses the picture in a minute or two: it is drawn at the birds' frame rate while it does)
      this._pushHeli(state);

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
      this.movers = birdsInView + this.count - skyFrom + goatsWalking;
      // A bird at the tree: after everything else, so the renderer can draw it over the tree. Sitting, it needs no
      // more frames than the tree does.
      this.nearFrom = this.count;
      for (const r of near) this._pushBird(r);
      this.movers += near.filter((r) => r.mode !== 'perched').length ? this.count - this.nearFrom : 0;
    }
  }

  /**
   * A headlight's glow as the eye sees it from `dist` km off (2026-11-22, the user: "there is big light in village": a
   * car several km off on the dark slope, on main beam, had the same 28-pixel dazzle as one close by):
   *   - fall, how bright: a point of light dims with distance as the village lamps do, full within 2 km, a seventh of it
   *     5 km and more away, where it is a small warm-white point;
   *   - near, how wide its halo: full within 1.5 km, a quarter 6 km and more away (sprites.js works out the same from
   *     the distance);
   *   - glare, the dazzle of a main beam (`beam`, 0 dipped to 1): only when it points almost straight at the eye, and
   *     always while it flashes (`flashing`).
   */
  Life.headGlow = (dist, facing, beam, flashing = 0) => ({
    fall: clamp((2 / Math.max(dist, 1e-3)) ** 2, 0.15, 1),
    near: clamp(1.5 / Math.max(dist, 1e-3), 0.25, 1),
    glare: Math.max(beam * smooth(0.9, 0.98, facing), flashing),
  });

  LE.Life = Life;
  LE.Life.MAX = MAX;
  /** How far above its feet (km) the middle of a sitting bird's body is: where the flying bird is as it lands and leaves. */
  Life.perchBody = (b) => (b.sp.tall || 0.00062) * 0.45;
  LE.Life.FLOATS = FLOATS;
})();
