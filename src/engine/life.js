/*
 * Life — everything that moves on its own: birds, chimney smoke, meteors, satellites.
 * Pure simulation on the CPU (a few dozen objects); it writes one instance buffer
 * per frame for the sprite pass. Behaviour follows the real clock and local weather:
 *   • raptors soar in thermals on sunny, calm middays
 *   • chough flocks swoop near the ridge, busiest after sunrise and before sunset
 *   • geese/cranes cross in V-formation during the real migration seasons
 *   • all birds shelter in rain, fog, snow and storms, and roost at night
 *   • wood smoke rises from village houses at cooking times and leans with the wind
 *   • meteor rates follow the real annual shower calendar and need a dark, clear sky
 *   • satellites only show in twilight, when they are sunlit against a dark sky
 *   • buses, jeeps and motorcycles keep to the road, driving on the left, and slow down for bends. Most in the day,
 *     few at night, and their headlights show only while they head towards the viewer
 * Units: km, km/s; scene frame as in the renderer (+z = view centre, camera at origin).
 */
(function () {
  'use strict';
  const LE = (window.LE = window.LE || {});
  const D2R = Math.PI / 180;
  const TAU = Math.PI * 2;
  const FLOATS = 16;
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

  // Sizes in km, cruising speed in km/s. Paint: 5 bits each of red, green and blue.
  const SIZE_ON_SCREEN = 1.3; // a little larger than life, or at this distance a motorcycle would be under a pixel
  const rgb5 = (r, g, b) => r + g * 32 + b * 1024;
  const VEHICLES = {
    bus: {
      code: 0, len: 0.0105, wid: 0.0025, hgt: 0.0031, cruise: 0.0085, lane: 0.0017,
      paints: [rgb5(24, 5, 4), rgb5(5, 11, 22), rgb5(26, 19, 4), rgb5(25, 25, 24), rgb5(5, 16, 10)],
    },
    jeep: {
      code: 1, len: 0.0045, wid: 0.0018, hgt: 0.0019, cruise: 0.0115, lane: 0.0017,
      paints: [rgb5(27, 27, 26), rgb5(6, 12, 7), rgb5(19, 20, 20), rgb5(16, 4, 5), rgb5(4, 5, 7)],
    },
    motorcycle: {
      code: 2, len: 0.0021, wid: 0.0008, hgt: 0.0016, cruise: 0.0125, lane: 0.0022,
      paints: [rgb5(22, 5, 4), rgb5(5, 7, 14), rgb5(24, 24, 22), rgb5(9, 12, 6)],
    },
  };
  const TRAFFIC_MAX = 14; // on the whole road, most of which is in view
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
      this.road = null;
      this.vehicles = [];
      this._nextVehicle = 0;
      this._trafficSeeded = false;
      this.enabled = true;
      this.birds = true; // off: no birds, while the rest of life goes on
      this.t = 0;
      this._nextFlock = rand(20, 90);
      this._nextGeese = rand(60, 240);
      this._nextRaptorCheck = 0;
      this.activeShower = null;
    }

    setSmokeSources(list) {
      this.smokeSources = list || [];
      this.smoke = [];
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
      if (kind === 'raptor') this.raptors.push(this._newRaptor(true));
      else if (kind === 'flock') this.flock = this._newFlock(true);
      else if (kind === 'geese') this.geese = this._newGeese(this.state, true);
      else if (kind === 'meteor') this.meteors.push(this._newMeteor(null, this.state));
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
      return Math.round(TRAFFIC_MAX * byHour * byWeather);
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
      return {
        kind,
        code: k.code,
        dir,
        s,
        len: k.len * SIZE_ON_SCREEN,
        wid: k.wid * SIZE_ON_SCREEN,
        hgt: k.hgt * SIZE_ON_SCREEN,
        cruise: k.cruise * rand(0.9, 1.1),
        v: k.cruise * 0.7,
        paint: paints[Math.floor(Math.random() * paints.length)],
        lane: k.lane,
      };
    }

    _pickVehicleKind() {
      const x = Math.random();
      return x < 0.25 ? 'bus' : x < 0.65 ? 'jeep' : 'motorcycle';
    }

    _stepTraffic(dt, state) {
      const road = this.road;
      if (!road) return;
      const want = this._trafficWanted(state);
      // the road isn't empty when the picture first appears
      if (!this._trafficSeeded && this._view) {
        this._trafficSeeded = true;
        for (let i = 0; i < want; i++) this.vehicles.push(this._newVehicle(this._pickVehicleKind(), Math.random() < 0.5 ? 1 : -1, rand(0, road.length)));
      }
      this._nextVehicle -= dt;
      if (this._nextVehicle <= 0) {
        this._nextVehicle = rand(6, 45);
        if (this.vehicles.length < want) {
          const dir = Math.random() < 0.5 ? 1 : -1;
          const s = dir > 0 ? 0.001 : road.length - 0.001;
          if (this.vehicles.every((o) => o.dir !== dir || Math.abs(o.s - s) > 0.06)) this.vehicles.push(this._newVehicle(this._pickVehicleKind(), dir, s));
        }
      }
      const w = state.weather;
      const careful = 1 - 0.3 * smooth(0.1, 0.6, Math.max(w.rain, w.snow, w.fog));
      for (const c of this.vehicles) {
        const i = clamp(Math.round(c.s / road.step), 0, road.n - 1);
        let target = Math.min(c.cruise * careful, road.limit[i]);
        // keeps its distance from the one in front
        for (const o of this.vehicles) {
          if (o === c || o.dir !== c.dir) continue;
          const gap = (o.s - c.s) * c.dir - (o.len + c.len) / 2;
          if (gap <= 0 || gap > 0.08) continue;
          if (gap < 0.012 + c.v * 2) target = Math.min(target, o.v * 0.95);
          if (gap < 0.006) target = 0;
        }
        const dv = 1.2e-3 * dt;
        c.v += clamp(target - c.v, -dv * 2, dv);
        c.s += c.dir * c.v * dt;
      }
      this.vehicles = this.vehicles.filter((c) => c.s > 0 && c.s < road.length);
    }

    _pushVehicle(c, lights) {
      const v = this._view;
      const road = this.road;
      const R = LE.Road;
      const off = -c.dir * c.lane; // on the left of its own direction
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
      const bx = ps.sx - pr.sx;
      const by = ps.sy - pr.sy;
      const halfH = Math.max(c.hgt / pr.r / v.pxAng, 0.9) / 2;
      const toCam = [-p[0], v.camY - p[1], -p[2]];
      const dist = Math.hypot(toCam[0], toCam[1], toCam[2]);
      const facing = (fx * toCam[0] + fy * toCam[1] + fz * toCam[2]) / (fl * dist);
      const lamp = lights * R.headlight(facing);
      let qx = Math.abs(ax) + Math.abs(bx) + 1.5;
      let qy = Math.abs(ay) + Math.abs(by) + halfH + 1.5;
      if (lamp > 0.003) {
        qx = Math.max(qx, 11);
        qy = Math.max(qy, 11);
      }
      this._push([
        pr.sx, pr.sy + halfH, qx, qy,
        0, 6, 1, dist,
        ax, ay, bx, by,
        halfH, c.paint, lamp, c.code,
      ]);
    }

    _stepSmoke(dt, state) {
      const a = state.astro;
      const w = state.weather;
      const h = state.now.getHours() + state.now.getMinutes() / 60;
      // cooking fires: early morning and evening; more in the cold months
      const cooking = Math.max(Math.exp(-((h - 7.0) ** 2) / 1.2), Math.exp(-((h - 18.3) ** 2) / 1.0));
      const winter = 0.6 + 0.4 * Math.cos((2 * Math.PI * (a.dayOfYear - 15)) / 365);
      const visible = smooth(-6, 2, a.sunAltDeg) * (1 - smooth(0.05, 0.3, w.rain)) * (1 - smooth(25, 45, w.windSpeed)) * (1 - smooth(0.3, 0.7, w.fog));
      const want = this.enabled ? Math.round(Math.min(this.smokeSources.length, 7) * cooking * winter * visible) : 0;
      while (this.smoke.length < want) {
        const used = new Set(this.smoke.map((s) => s.src));
        const free = this.smokeSources.filter((s) => !used.has(s));
        if (!free.length) break;
        const src = free[Math.floor(Math.random() * free.length)];
        this.smoke.push({ src, alpha: 0, seed: Math.random(), target: rand(0.25, 0.5) });
      }
      if (this.smoke.length > want) this.smoke.forEach((s, i) => { if (i >= want) s.fading = true; });
      for (const s of this.smoke) {
        s.alpha += ((s.fading ? 0 : s.target) - s.alpha) * (1 - Math.exp(-dt / 20));
      }
      this.smoke = this.smoke.filter((s) => !(s.fading && s.alpha < 0.01));
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
      const perSec = (rate * 0.18 * dark * clear * (this.enabled ? 1 : 0)) / 3600;
      if (Math.random() < perSec * dt && this.meteors.length < 4) {
        const fromShower = best && Math.random() < best.z / rate;
        this.meteors.push(this._newMeteor(fromShower ? best.rd : null, state));
      }
      for (const me of this.meteors) me.age += dt;
      this.meteors = this.meteors.filter((me) => me.age < me.dur + 0.35);
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
      const lenRad = rand(4, 16) * D2R;
      const p0 = this._projectDir(P);
      const P1 = P.map((x, i) => x + T[i] * lenRad);
      const p1 = this._projectDir(P1);
      const mag = Math.pow(Math.random(), 2.2) * 5 - 1.5; // mostly faint, a few bright
      return { p0, p1, age: 0, dur: rand(0.25, 0.9), bright: 0.9 * Math.pow(2.512, -mag) };
    }

    _stepSatellites(dt, state) {
      const a = state.astro;
      const w = state.weather;
      // sunlit satellites against a dark sky: roughly the first/last ~2 h of night
      const window = smooth(-6, -10, a.sunAltDeg) * (1 - smooth(-24, -32, a.sunAltDeg));
      const clear = 1 - 0.95 * smooth(0.3, 0.9, w.coverage);
      const perSec = (window * clear * (this.enabled ? 1 : 0)) / 200;
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
      this.data.set(vals, this.count * FLOATS);
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
      // Headlights come on as the light goes, and in thick weather. Too slow on the picture to need a higher frame rate.
      const w0 = state.weather;
      const lights = Math.max(1 - smooth(-4, 3, state.astro.sunAltDeg), smooth(0.35, 0.7, Math.max(w0.fog, w0.rain, w0.snow)) * 0.8);
      for (const c of this.vehicles) this._pushVehicle(c, lights);
      const vehiclesInView = this.count;
      for (const r of this.raptors) this._pushBird(r);
      if (this.flock) for (const b of this.flock.birds) this._pushBird(b);
      if (this.geese) for (const b of this.geese.birds) this._pushBird(b);
      const birdsInView = this.count - vehiclesInView;

      // chimney smoke
      const v = this._view;
      const w = state.weather;
      for (const s of this.smoke) {
        const p = s.src;
        const pr = this._project(p.x, p.y, p.z);
        if (!this._inView(pr, 60)) continue;
        const dist = Math.hypot(p.x, p.y - v.camY, p.z);
        const pxPerKm = 1 / (dist * v.pxAng);
        const hPx = 0.12 * pxPerKm; // wood smoke rises ~120 m before it thins out
        const wPx = Math.max(0.022 * pxPerKm, 3);
        const lean = clamp((w.rainSlant || 0) * 4 + Math.sin(state.time * 0.02 + s.seed * 10) * 0.25, -0.9, 0.9);
        const hx = wPx * (1 + Math.abs(lean) * 3);
        this._push([
          pr.sx, pr.sy + hPx * 0.5, hx, hPx * 0.5,
          0, 5, s.alpha, dist,
          lean * 0.9, s.seed, wPx / hx * 0.6, 0,
          0, 0, 0, 0,
        ]);
      }

      const skyFrom = this.count;

      // meteors (head runs from p0 to p1, tail follows)
      for (const me of this.meteors) {
        const k = clamp(me.age / me.dur, 0, 1);
        const head = [me.p0[0] + (me.p1[0] - me.p0[0]) * k, me.p0[1] + (me.p1[1] - me.p0[1]) * k];
        const tk = clamp(k - 0.45, 0, 1);
        const tail = [me.p0[0] + (me.p1[0] - me.p0[0]) * tk, me.p0[1] + (me.p1[1] - me.p0[1]) * tk];
        const len = Math.max(Math.hypot(head[0] - tail[0], head[1] - tail[1]), 2);
        const fade = smooth(0, 0.08, me.age) * (1 - smooth(me.dur * 0.75, me.dur + 0.35, me.age));
        const ang = Math.atan2(head[1] - tail[1], head[0] - tail[0]);
        this._push([
          (head[0] + tail[0]) / 2, (head[1] + tail[1]) / 2, len / 2 + 4, 4,
          ang, 3, 1, 0,
          0, me.bright * fade * state.starVis * 4, 0, 0.9,
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
