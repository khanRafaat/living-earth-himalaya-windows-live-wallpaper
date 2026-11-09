/*
 * Environment — turns real-world inputs (clock, astronomy, local weather) into
 * the smooth, renderer-ready state of the Himalayan scene.
 *
 * The location's weather (Dhaka unless Windows shares another) sets the *mood* of
 * the mountain atmosphere (cloud cover, rain, mist, wind, haze). It is not
 * presented as Himalayan weather.
 * No rendering code lives here; the renderer only reads `state`.
 */
(function () {
  'use strict';
  const LE = (window.LE = window.LE || {});
  const D2R = Math.PI / 180;
  // how bright a village lamp is at least once dusk has deepened (sun 7° down), in the scene's light units
  const LAMP_DUSK = 3;
  // The sun lights nothing in the scene once it is this far down (degrees): the highest peaks (about 9 km) and the tops
  // of storm clouds (11 km) see it set at about 3.6° below the horizon. Only one light gets the shadow map and the march
  // through the clouds, the other is drawn unshadowed, so the moon takes them over here, where the sun has nothing left
  // to light and twilight outshines the moon. Handed over earlier, the last light on the peaks and the haze in shaded
  // valleys lost their shadows in one frame.
  const SUN_GONE = -3.8;
  const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
  const smooth = (a, b, x) => {
    const t = clamp((x - a) / (b - a), 0, 1);
    return t * t * (3 - 2 * t);
  };

  // Manual preview presets (also used to label "no data")
  const PRESETS = {
    clear: { code: 0, cloud: 4, cloudHigh: 5, humidity: 50, visibility: 40000, windSpeed: 7, windDir: 300, precip: 0, temp: 24 },
    partly: { code: 2, cloud: 45, cloudHigh: 30, humidity: 62, visibility: 25000, windSpeed: 11, windDir: 290, precip: 0, temp: 26 },
    overcast: { code: 3, cloud: 98, cloudHigh: 60, humidity: 82, visibility: 12000, windSpeed: 13, windDir: 200, precip: 0, temp: 24 },
    rain: { code: 63, cloud: 100, cloudHigh: 80, humidity: 93, visibility: 6000, windSpeed: 16, windDir: 160, precip: 2.5, temp: 23 },
    heavyrain: { code: 65, cloud: 100, cloudHigh: 90, humidity: 97, visibility: 2500, windSpeed: 24, windDir: 150, precip: 9, temp: 22 },
    storm: { code: 95, cloud: 100, cloudHigh: 90, humidity: 94, visibility: 4000, windSpeed: 32, windDir: 140, precip: 6, temp: 25 },
    fog: { code: 45, cloud: 30, cloudHigh: 10, humidity: 99, visibility: 350, windSpeed: 3, windDir: 30, precip: 0, temp: 15 },
    snow: { code: 73, cloud: 100, cloudHigh: 70, humidity: 90, visibility: 4000, windSpeed: 12, windDir: 320, precip: 1.5, snowfall: 1.2, temp: -3 },
  };

  /** East/north vector (km/h) of a wind reported as the direction it blows *from*. */
  function windVector(speed, fromDeg) {
    const toward = (fromDeg + 180) * D2R;
    return [Math.sin(toward) * speed, Math.cos(toward) * speed];
  }

  /**
   * The real wind at each cloud layer. The deck moves with whichever of 850 hPa (low cloud) and
   * 700 hPa (mid cloud) holds the cloud. Records without upper winds (presets, older cached data)
   * estimate them from the surface wind.
   */
  function cloudWinds(rec) {
    const level = (speed, dir) => (speed != null && dir != null ? windVector(speed, dir) : null);
    const w850 = level(rec.wind850, rec.dir850);
    const w700 = level(rec.wind700, rec.dir700);
    const w300 = level(rec.wind300, rec.dir300);
    let deck = w700 || w850;
    if (w850 && w700) {
      const low = Math.max(rec.cloudLow ?? 0, 0);
      const sum = low + Math.max(rec.cloudMid ?? 0, 0);
      const a = sum > 2 ? low / sum : 0;
      deck = [w850[0] * a + w700[0] * (1 - a), w850[1] * a + w700[1] * (1 - a)];
    }
    if (!deck) deck = windVector(Math.max(rec.windSpeed ?? 8, 6) * 2.4, rec.windDir ?? 270);
    const cirrus = w300 || [deck[0] * 1.7, deck[1] * 1.7];
    return { deck, cirrus };
  }

  /** Map a weather record → target visual parameters. */
  function weatherTargets(rec) {
    const c = rec.code ?? 1;
    // The volume pass draws low and mid cloud. High cloud is thin, so it only feeds the cirrus.
    const layered = rec.cloudLow != null && rec.cloudMid != null;
    let cover = layered
      ? 1 - (1 - clamp(rec.cloudLow / 100, 0, 1)) * (1 - clamp(rec.cloudMid / 100, 0, 1))
      : clamp((rec.cloud ?? 30) / 100, 0, 1);
    const deck = cover;
    const hum = rec.humidity ?? 65;
    const vis = rec.visibility ?? 20000;
    const precip = rec.precip ?? 0;
    const temp = rec.temp ?? 20;

    const isFog = c === 45 || c === 48;
    const drizzle = c >= 51 && c <= 57;
    const rainCode = (c >= 61 && c <= 67) || (c >= 80 && c <= 82);
    const snowCode = (c >= 71 && c <= 77) || c === 85 || c === 86;
    const storm = c >= 95;

    let precipI = 0;
    if (drizzle) precipI = c === 51 ? 0.12 : c === 53 ? 0.2 : 0.3;
    if (c === 61 || c === 80 || c === 66 || c === 71 || c === 85) precipI = 0.35;
    if (c === 63 || c === 81 || c === 73 || c === 77) precipI = 0.6;
    if (c === 65 || c === 82 || c === 67 || c === 75 || c === 86) precipI = 0.95;
    if (storm) precipI = Math.max(precipI, 0.75);
    if (precip > 0.05) precipI = Math.max(precipI, clamp(precip / 7, 0.12, 0.95));

    const isSnow = snowCode || (precipI > 0 && temp < 0.5 && !rainCode);
    const rain = isSnow ? 0 : precipI;
    const snow = isSnow ? Math.max(precipI, 0.3) : 0;

    // Weather codes describe total cloud, high cloud included. So with layer data their lower limits
    // can't apply to the deck: "overcast" under thin high cloud must not draw a heavy low overcast.
    // The test panel's cloud slider means the number itself.
    if (rec.exactCloud) cover = deck;
    else if (c === 0) cover = Math.min(cover, 0.12);
    else if (c === 1) cover = layered ? Math.min(cover, 0.35) : clamp(cover, 0.12, 0.35);
    else if (c === 2) cover = layered ? Math.min(cover, 0.62) : clamp(cover, 0.3, 0.62);
    else if (c === 3) cover = Math.max(cover, layered ? 0.9 * smooth(0.35, 0.75, deck) : 0.9);
    if (precipI > 0) cover = Math.max(cover, 0.85 + 0.15 * precipI);

    const overcast = smooth(0.72, 1.0, cover) * (c >= 3 || precipI > 0 ? 1 : 0.55);
    const wetCloud = Math.max(rain, snow * 0.7);

    // Valley mist from humidity. Every target here comes from the data alone, so the weather on
    // screen changes only when the data does.
    const mist = smooth(52, 97, hum);

    let fog = isFog ? 0.9 : vis < 1000 ? 0.7 : vis < 2500 ? 0.3 : 0;
    if (rain > 0.8) fog = Math.max(fog, 0.15);

    // sky haze (Mie density multiplier) and the denser haze that layers the valleys
    const haze = 1.3 + 2.2 * smooth(12000, 2500, vis) * (1 - fog) + 2.0 * wetCloud + 0.8 * smooth(70, 98, hum);
    const valleyHaze = 5 + 8 * smooth(15000, 3000, vis) * (1 - fog) + 6 * wetCloud + 4 * smooth(65, 98, hum);
    const winds = cloudWinds(rec);
    // Banner clouds on the high peaks (volume.js): they need moist air and a steady wind up there to carry it past the
    // summits. A closed deck, steady rain or snow, or fog hide the peaks instead.
    const banner = smooth(45, 82, hum) * smooth(8, 25, Math.hypot(winds.deck[0], winds.deck[1]))
      * (1 - smooth(0.5, 0.85, overcast)) * (1 - smooth(0.2, 0.7, precipI)) * (1 - smooth(0.1, 0.5, fog));

    return {
      coverage: cover,
      overcast,
      cloudBase: 4.7 + 0.5 * overcast - 0.75 * wetCloud,
      cloudThick: 1.7 + 0.9 * cover + (storm ? 2.2 : 0) + 0.8 * wetCloud,
      cloudDensity: 0.85 + 0.5 * overcast + 0.7 * wetCloud,
      cloudDark: clamp(wetCloud * 0.85 + (storm ? 0.35 : 0) + overcast * 0.15, 0, 1),
      cirrus: clamp((rec.cloudHigh ?? cover * 50) / 100, 0, 1) * (1 - overcast * 0.6),
      rain,
      snow,
      storm: storm ? 1 : 0,
      mist,
      mistTop: 1.45 + 0.85 * mist,
      fog,
      fogTop: 1.85 + 0.8 * fog,
      haze,
      valleyHaze,
      banner,
      windSpeed: Math.max(rec.windSpeed ?? 8, 0),
      windDir: rec.windDir ?? 270,
      gusts: Math.max(rec.gusts ?? (rec.windSpeed ?? 8) * 1.5, rec.windSpeed ?? 8, 0),
      deckE: winds.deck[0],
      deckN: winds.deck[1],
      cirrusE: winds.cirrus[0],
      cirrusN: winds.cirrus[1],
    };
  }

  // How long each part of the weather takes to change, as multiples of transitionSeconds:
  // [when its value rises, when it falls]. Clouds clear more slowly than they build, rain stops
  // sooner than it starts, and fog lingers as it forms.
  const PACE = {
    coverage: [1.0, 1.7],
    overcast: [1.1, 1.7],
    cloudBase: [1.4, 1.7],
    cloudThick: [1.4, 1.7],
    cloudDensity: [1.0, 1.5],
    cloudDark: [1.2, 1.2],
    cirrus: [1.5, 1.5],
    rain: [0.5, 0.35],
    snow: [0.7, 0.6],
    storm: [0.5, 0.5],
    mist: [1.5, 1.5],
    mistTop: [1.5, 1.5],
    fog: [1.6, 1.2],
    fogTop: [1.6, 1.2],
    haze: [1.5, 1.5],
    valleyHaze: [1.5, 1.5],
    banner: [2.0, 1.6], // banner clouds take a few minutes to form, and a little less to dissolve
    windSpeed: [0.6, 0.8],
    gusts: [0.6, 0.8],
  };
  const WIND_KEYS = ['deckE', 'deckN', 'cirrusE', 'cirrusN'];

  /**
   * How quickly this change plays out. Weather systems travel with the wind, so a strong flow
   * brings change sooner and still air lets it linger. Storms also roll in faster than drizzle.
   */
  function weatherPace(t, deckKmh) {
    const wind = clamp(30 / Math.max(deckKmh, 1), 0.6, 1.5);
    const severity = 1 - 0.35 * t.storm - 0.2 * Math.max(t.rain, t.snow);
    return Math.max(0.4, wind * severity);
  }

  /**
   * Puts a change in the order real weather follows. Rain, snow and lightning wait for the clouds
   * that make them, and the sky holds until the rain has eased before it starts to clear.
   */
  function sequenceWeather(t, w) {
    const built = smooth(0.4, 0.8, w.coverage);
    t.rain *= built;
    t.snow *= built;
    t.storm *= smooth(0.25, 0.6, w.cloudDark);
    const falling = smooth(0.02, 0.25, Math.max(w.rain, w.snow));
    t.coverage = Math.max(t.coverage, 0.85 * falling);
    t.overcast = Math.max(t.overcast, w.overcast * falling);
    t.cloudDark = Math.max(t.cloudDark, w.cloudDark * falling);
  }

  class Environment {
    constructor(cfg) {
      this.cfg = cfg;
      this.loc = { lat: cfg.location.lat, lon: cfg.location.lon, name: cfg.location.name };
      this.record = null; // last real weather record (or preset)
      this.recordSource = 'none';
      this.w = null; // smoothed weather visuals
      this.wLead = null; // first smoothing stage: w follows it, which eases each change in and out
      this.wet = 0;
      this.freshSnow = 0;
      this.pace = 1; // how much faster than real the land wets, dries, takes snow and thaws (the demo raises it)
      this.windOffset = [0, 0, 0];
      this.mistOffset = [0, 0, 0];
      this.coverOffset = [0, 0];
      this.detailOffset = [0, 0, 0];
      this.cirrusOffset = [0, 0];
      this.treeWind = null; // long-smoothed surface wind (east, north) that sets the gust direction
      this.treeAir = null; // the same wind smoothed over seconds: what the tree itself feels
      this.gustTravel = [0, 0];
      this.treeSway = [0, 0];
      this.flash = 0;
      this.flashPos = [0.5, 0.75];
      this._flashT = 0;
      this._nextFlash = 0;
      this._pulses = [];
      this._astroAt = -1e9;
      this._windAngle = 0;
      this.state = this._emptyState();
    }

    _emptyState() {
      return {
        time: 0,
        sunDir: new Float32Array(3),
        moonDir: new Float32Array(3),
        keyDir: new Float32Array(3),
        lightMarchDir: new Float32Array(3),
        keyIsSun: 1,
        sunE: new Float32Array(3),
        moonE: new Float32Array(3),
        airglowE: new Float32Array(3),
        moonDiskE: 0,
        twilightE: 0,
        sunVis: 0,
        moonVis: 0,
        starVis: 0,
        night: 0,
        starMat: new Float32Array(9),
        north: new Float32Array(2),
        wind: new Float32Array(3),
        coverWind: new Float32Array(2),
        detailDrift: new Float32Array(3),
        cirrusWind: new Float32Array(2),
        coverFront: new Float32Array(2),
        windVel: new Float32Array(3),
        gustDir: new Float32Array([0, 1]),
        treeDir: new Float32Array([0, 1]),
        gustTravel: new Float32Array(2),
        treeSway: new Float32Array(2),
        windAmt: 0,
        treeKmh: 0,
        lampE: 0,
        lampDark: 0,
        localHour: 12,
        now: new Date(),
        heading: 0,
        mistWind: new Float32Array(3),
        weather: {},
        astro: {},
        season: new Float32Array(4),
        snowLine: 4.5,
        exposure: 1,
      };
    }

    setLocation(loc) {
      this.loc = loc;
      this._astroAt = -1e9;
    }

    setWeather(rec, source) {
      this.record = rec;
      this.recordSource = source;
    }

    /** dtSec: real seconds since last update. */
    update(now, dtSec, timeSec) {
      const s = this.state;
      const cfg = this.cfg;
      const heading = cfg.render.heading;
      s.time = timeSec;
      s.now = now;
      s.heading = heading;
      s.localHour = now.getHours() + now.getMinutes() / 60 + now.getSeconds() / 3600;

      // ---------- astronomy (refresh at 2 Hz; it changes slowly) ----------
      if (timeSec - this._astroAt > 0.5 || timeSec < this._astroAt) {
        this._astroAt = timeSec;
        this._updateAstro(now, heading);
      }
      const a = s.astro;

      // ---------- weather ----------
      const rec = this.record || PRESETS.partly;
      const target = weatherTargets(rec);
      const snap = !this.w || dtSec > 30;
      if (snap) {
        this.w = Object.assign({}, target);
        this.wLead = Object.assign({}, target);
      }
      const w = this.w;
      const lead = this.wLead;
      const trans = Math.max(5, cfg.atmosphere.transitionSeconds);
      const pace = trans * weatherPace(target, Math.hypot(w.deckE, w.deckN));
      sequenceWeather(target, w);
      // Two smoothing stages give each change a gentle start and finish, not a sudden one
      const stage = (k, tau) => {
        const f = snap ? 1 : 1 - Math.exp((-2 * dtSec) / tau);
        lead[k] += (target[k] - lead[k]) * f;
        w[k] += (lead[k] - w[k]) * f;
      };
      for (const k in PACE) stage(k, PACE[k][target[k] > lead[k] ? 0 : 1] * pace);
      // winds are smoothed as vectors, so a change of direction takes the short way round
      for (const k of WIND_KEYS) stage(k, trans);
      // wind direction: rotate along the shortest arc
      let dd = ((target.windDir - w.windDir + 540) % 360) - 180;
      w.windDir = (w.windDir + dd * (snap ? 1 : 1 - Math.exp(-dtSec / trans)) + 360) % 360;

      // wetness: quick to soak, slow to dry
      const wetT = w.rain > 0.05 ? 1 : 0;
      const wetTau = (wetT > this.wet ? 150 : 2400) / this.pace;
      this.wet += (wetT - this.wet) * (snap ? (wetT ? 1 : 0) : 1 - Math.exp(-dtSec / wetTau));
      // fresh snow lowers the snow line in a quarter of an hour or so (snow settles on the tree and the rock while it
      // falls), and melts back over several hours
      const fsT = w.snow > 0.05 ? 1 : 0;
      const fsTau = (fsT > this.freshSnow ? 900 : 14400) / this.pace;
      this.freshSnow += (fsT - this.freshSnow) * (snap ? fsT : 1 - Math.exp(-dtSec / fsTau));

      // wind → drift (km): each layer moves with the real wind at its height. cloudSpeed 1 is real
      // speed; higher values are a time-lapse.
      const speedMul = clamp(cfg.atmosphere.cloudSpeed, 0.5, 12);
      const toward = (w.windDir + 180 - heading) * D2R; // wind blows *from* windDir
      const cosH = Math.cos(heading * D2R);
      const sinH = Math.sin(heading * D2R);
      const deckX = w.deckE * cosH - w.deckN * sinH; // km/h in scene axes
      const deckZ = w.deckE * sinH + w.deckN * cosH;
      const dtc = Math.min(dtSec, 30); // slow mode draws a frame only every few seconds
      const drift = (speedMul / 3600) * dtc; // km per km/h this frame
      this.windOffset[0] -= deckX * drift;
      this.windOffset[2] -= deckZ * drift;
      this.windOffset[1] -= 0.0011 * speedMul * dtc; // slow vertical evolution: clouds change shape
      // Real clouds aren't a rigid sheet. Cover travels slower than the shapes, so clouds build ahead
      // and fade behind, and the fine billows rise and churn against the body of the cloud.
      this.coverOffset[0] -= deckX * drift * 0.7;
      this.coverOffset[1] -= deckZ * drift * 0.7;
      this.detailOffset[0] -= deckX * drift * 0.15;
      this.detailOffset[1] -= 0.006 * speedMul * dtc;
      this.detailOffset[2] -= deckZ * drift * 0.15;
      this.cirrusOffset[0] -= (w.cirrusE * cosH - w.cirrusN * sinH) * drift;
      this.cirrusOffset[1] -= (w.cirrusE * sinH + w.cirrusN * cosH) * drift;
      const mk = (Math.max(w.windSpeed, 4) / 3600) * speedMul * 0.55;
      this.mistOffset[0] -= Math.sin(toward) * mk * dtc;
      this.mistOffset[2] -= Math.cos(toward) * mk * dtc;
      this.mistOffset[1] -= 0.0018 * speedMul * dtc;
      // Keep offsets bounded. Each period is a whole number of tiles of every noise it feeds, so
      // wrapping doesn't show: 5000 km for the deck and mist, 6250 km for cirrus.
      for (let i = 0; i < 3; i++) {
        this.windOffset[i] %= 5000;
        this.mistOffset[i] %= 5000;
        this.detailOffset[i] %= 5000;
      }
      this.coverOffset[0] %= 5000;
      this.coverOffset[1] %= 5000;
      this.cirrusOffset[0] %= 6250;
      this.cirrusOffset[1] %= 6250;
      s.wind.set(this.windOffset);
      s.coverWind.set(this.coverOffset);
      s.detailDrift.set(this.detailOffset);
      s.mistWind.set(this.mistOffset);
      s.cirrusWind.set(this.cirrusOffset);

      // A change of cover arrives from upwind: while it plays out, cover leans along the wind, so
      // one side of the sky fills or clears first. lead − w rises and falls smoothly back to 0.
      const deckKmh = Math.hypot(deckX, deckZ);
      const lean = deckKmh > 0.01 ? ((lead.coverage - w.coverage) / 40) * smooth(2, 12, deckKmh) * smooth(0, 0.2, w.coverage) : 0;
      s.coverFront[0] = deckKmh > 0.01 ? (-deckX / deckKmh) * lean : 0;
      s.coverFront[1] = deckKmh > 0.01 ? (-deckZ / deckKmh) * lean : 0;

      // real-speed surface wind: bird drift
      const surf = Math.max(w.windSpeed, 2) / 3600;
      s.windVel[0] = Math.sin(toward) * surf;
      s.windVel[1] = 0;
      s.windVel[2] = Math.cos(toward) * surf;

      // ---------- wind in the trees ----------
      // Lulls and gusts swing between the real mean wind and the real gust speed, on an irregular
      // rhythm of about a minute. Still air leaves the forest nearly still.
      const beat = 0.5 + 0.5 * Math.sin(timeSec * 0.11) * Math.sin(timeSec * 0.047 + 1.3);
      const treeKmh = w.windSpeed + (w.gusts - w.windSpeed) * beat * beat;
      s.treeKmh = treeKmh;
      const trees = clamp(cfg.atmosphere.treeWind ?? 1, 0, 3);
      s.windAmt = trees * (0.3 * smooth(0.5, 10, treeKmh) + 0.3 * smooth(10, 40, treeKmh));
      // The gust pattern rotates about the viewer, so a quick change of direction would sweep it
      // across distant slopes. Hence the long (5 min) smoothing of its direction.
      const [windE, windN] = windVector(Math.max(w.windSpeed, 0.5), w.windDir);
      if (snap || !this.treeWind) this.treeWind = [windE, windN];
      const fTree = 1 - Math.exp(-dtSec / 300);
      this.treeWind[0] += (windE - this.treeWind[0]) * fTree;
      this.treeWind[1] += (windN - this.treeWind[1]) * fTree;
      const treeLen = Math.hypot(this.treeWind[0], this.treeWind[1]);
      if (treeLen > 0.01) {
        s.gustDir[0] = (this.treeWind[0] * cosH - this.treeWind[1] * sinH) / treeLen;
        s.gustDir[1] = (this.treeWind[0] * sinH + this.treeWind[1] * cosH) / treeLen;
      }
      // The tree is one thing close by, so nothing sweeps when it turns: it follows the real direction in seconds
      if (snap || !this.treeAir) this.treeAir = [windE, windN];
      const fAir = 1 - Math.exp(-dtSec / 12);
      this.treeAir[0] += (windE - this.treeAir[0]) * fAir;
      this.treeAir[1] += (windN - this.treeAir[1]) * fAir;
      const airLen = Math.hypot(this.treeAir[0], this.treeAir[1]);
      if (airLen > 0.01) {
        s.treeDir[0] = (this.treeAir[0] * cosH - this.treeAir[1] * sinH) / airLen;
        s.treeDir[1] = (this.treeAir[0] * sinH + this.treeAir[1] * cosH) / airLen;
      }
      // Gust fronts run a little faster than the mean wind. 5 km is a whole number of tiles of
      // every band frequency along the wind, so wrapping doesn't show.
      const gustKm = ((treeKmh * 1.4) / 3600) * dtc;
      this.gustTravel[0] = (this.gustTravel[0] + gustKm) % 5;
      this.gustTravel[1] = (this.gustTravel[1] + gustKm * 0.7) % 5;
      s.gustTravel[0] = this.gustTravel[0];
      s.gustTravel[1] = this.gustTravel[1];
      this.treeSway[0] = (this.treeSway[0] + 2 * Math.PI * 0.37 * dtc) % (2 * Math.PI);
      this.treeSway[1] = (this.treeSway[1] + 2 * Math.PI * 0.23 * dtc) % (2 * Math.PI);
      s.treeSway[0] = this.treeSway[0];
      s.treeSway[1] = this.treeSway[1];

      // ---------- lightning ----------
      this._lightning(dtSec, timeSec, w.storm);

      // ---------- light levels & exposure ----------
      const sunAlt = a.sunAltDeg;
      const moonAlt = a.moonAltDeg;
      const sunLevel = sunAlt >= 0 ? 0.1 + 0.9 * Math.sin(Math.min(sunAlt, 90) * D2R) : 0.1 * Math.exp(sunAlt / 1.5);
      const moonLevel = 2.6e-6 * Math.pow(a.moonFraction, 1.6) * clamp(Math.sin(moonAlt * D2R) + 0.06, 0, 1);
      const baseLevel = 6e-8;
      const level = (sunLevel + moonLevel + baseLevel) * (1 - 0.25 * w.overcast) * (1 - 0.2 * w.fog);
      const exposure = 5.2 * Math.pow(level, -0.86);
      s.exposure = exposure;

      // dark rain/storm clouds dim the whole scene (deliberately not exposure-compensated)
      const gloom = 1 - 0.5 * w.cloudDark - 0.15 * w.overcast;
      const sunScale = exposure * gloom;
      s.sunE[0] = sunScale * 1.0;
      s.sunE[1] = sunScale * 0.985;
      s.sunE[2] = sunScale * 0.96;
      const moonScale = exposure * gloom * 2.6e-6 * Math.pow(a.moonFraction, 1.6);
      s.moonE[0] = moonScale * 0.92;
      s.moonE[1] = moonScale * 0.96;
      s.moonE[2] = moonScale * 1.0;
      const ag = exposure * 3.2e-9;
      s.airglowE[0] = ag * 0.45;
      s.airglowE[1] = ag * 0.68;
      s.airglowE[2] = ag * 1.25;
      s.moonDiskE = Math.min(exposure * 1.0 * 0.12 / Math.PI * 1.4, 7.5);
      s.starVis = clamp(exposure * 2.4e-6, 0, 1.15) * (1 - 0.85 * w.overcast);
      s.night = smooth(-3, -12, sunAlt);
      // nautical/astronomical twilight glow, scaled with the same curve the exposure uses. It fades out as the sun climbs
      // its first degree: it used to stop dead at 1° (and come on at once at sunset) with a seventh of its glow left.
      s.twilightE = sunAlt < 1 ? exposure * 0.1 * Math.exp(Math.min(sunAlt, 0) / 1.5) * (1 - smooth(-3, 1, sunAlt) * 0.85) * (1 - smooth(0, 1, sunAlt)) : 0;
      // village lamps: emissive intensity (pre-exposed) and how dark it is for switching them on. Tied to the exposure
      // alone they stayed black through dusk, the exposure being low then, and showed only an hour after sunset, all at
      // once. The eye picks out a lit window as soon as it is switched on, so they never fall below a level that rises
      // through dusk; deep in the night the exposure takes over as before.
      s.lampE = Math.min(Math.max(exposure * 0.6e-6, LAMP_DUSK * smooth(-1, -7, sunAlt)), 10);
      s.lampDark = smooth(-1, -9, sunAlt);
      // the discs are drawn only while really above the horizon at your location
      // (same −0.833° rule as the sunrise/sunset times shown in the panel)
      s.sunVis = smooth(-0.95, -0.72, sunAlt);
      s.moonVis = smooth(-0.75, -0.35, moonAlt); // the panel's moonrise falls at about −0.54° here

      // ---------- seasons & snow line ----------
      const doy = a.dayOfYear;
      // Snow falling here lies here: fresh snow brings the line down to nearly a km below the eye in any season (it
      // used to stop 1.4 km below the season's line, which left the tree and the rock bare and green in a snowfall
      // outside deep winter, and for the first hour of one even then)
      const seasonLine = 4.45 + 0.55 * Math.cos((2 * Math.PI * (doy - 200)) / 365);
      s.snowLine = seasonLine - this.freshSnow * Math.max(1.4, seasonLine - cfg.render.cameraAltitude + 0.9);

      // ---------- pack weather for the GPU ----------
      const wo = s.weather;
      wo.coverage = w.coverage;
      wo.overcast = w.overcast;
      wo.cloudBase = w.cloudBase;
      wo.cloudTop = w.cloudBase + w.cloudThick;
      wo.cloudDensity = w.cloudDensity;
      wo.cloudDark = w.cloudDark;
      wo.cirrus = w.cirrus;
      wo.rain = w.rain;
      wo.snow = w.snow;
      wo.mist = w.mist;
      wo.mistTop = w.mistTop;
      wo.mistBottom = 0.5;
      wo.fog = w.fog;
      wo.fogTop = w.fogTop;
      wo.haze = w.haze;
      wo.valleyHaze = w.valleyHaze;
      wo.wet = this.wet;
      wo.banner = w.banner;
      wo.deckX = deckX; // the wind at the clouds (km/h, scene axes): banner clouds stream along it, as the deck drifts
      wo.deckZ = deckZ;
      wo.flash = this.flash;
      wo.flashPos = this.flashPos;
      wo.windSpeed = w.windSpeed;
      wo.rainSlant = clamp((Math.sin(toward) * w.windSpeed) / 70, -0.45, 0.45);
      wo.storm = w.storm;
      return s;
    }

    _updateAstro(now, heading) {
      const s = this.state;
      const A = LE.astronomy;
      const { lat, lon } = this.loc;
      const sun = A.sunPosition(now, lat, lon);
      const moon = A.moonPosition(now, lat, lon);
      const ill = A.moonIllumination(now);
      const times = A.sunTimes(now, lat, lon);
      const moonEv = A.moonEvents(now, lat, lon);

      const toScene = (azDeg, alt, out) => {
        const rel = (azDeg - heading) * D2R;
        const c = Math.cos(alt);
        out[0] = Math.sin(rel) * c;
        out[1] = Math.sin(alt);
        out[2] = Math.cos(rel) * c;
      };
      toScene(sun.azimuthDeg, sun.altitude, s.sunDir);
      toScene(moon.azimuthDeg, moon.altitude, s.moonDir);

      const sunAltDeg = sun.altitude / D2R;
      const moonAltDeg = moon.altitude / D2R;
      // By night the moon keeps the key light even while it is down, so nothing changes hands as it rises or sets: its
      // light comes up through its own shadows (before, at moonrise and moonset the key jumped from the moon to a sun far
      // below the horizon, and the low moon's light lost its shadows at once)
      const keyIsSun = sunAltDeg > SUN_GONE;
      s.keyIsSun = keyIsSun ? 1 : 0;
      s.keyDir.set(keyIsSun ? s.sunDir : s.moonDir);
      s.lightMarchDir.set(keyIsSun ? s.sunDir : s.moonDir);

      // scene-space compass north
      s.north[0] = Math.sin(-heading * D2R);
      s.north[1] = Math.cos(-heading * D2R);

      // star rotation: scene → ENU → celestial (fixed to the stars)
      const h = heading * D2R;
      const phi = lat * D2R;
      const lst = A.localSiderealTime(now, lon);
      const ch = Math.cos(h);
      const sh = Math.sin(h);
      const cp = Math.cos(phi);
      const sp = Math.sin(phi);
      const cl = Math.cos(lst);
      const sl = Math.sin(lst);
      // scene (x,y,z) → ENU: E = x ch + z sh, N = -x sh + z ch, U = y
      const sc = [
        [ch, 0, sh],
        [-sh, 0, ch],
        [0, 1, 0],
      ];
      // ENU → celestial XYZ
      const ec = [
        [-sl, -sp * cl, cp * cl],
        [cl, -sp * sl, cp * sl],
        [0, cp, sp],
      ];
      const m = [
        [0, 0, 0],
        [0, 0, 0],
        [0, 0, 0],
      ];
      for (let r = 0; r < 3; r++)
        for (let c2 = 0; c2 < 3; c2++) m[r][c2] = ec[r][0] * sc[0][c2] + ec[r][1] * sc[1][c2] + ec[r][2] * sc[2][c2];
      // column-major for GLSL
      for (let c2 = 0; c2 < 3; c2++) for (let r = 0; r < 3; r++) s.starMat[c2 * 3 + r] = m[r][c2];

      // dawn factor (0..1): peaks shortly after sunrise, for radiation fog in valleys
      let dawn = 0;
      if (times.sunrise) {
        const hrs = (now - times.sunrise) / 3600e3;
        dawn = Math.exp(-((hrs - 0.4) * (hrs - 0.4)) / (2 * 1.1 * 1.1));
      }

      const start = new Date(now.getFullYear(), 0, 0);
      const doy = Math.floor((now - start) / 864e5);
      const phase = A.dayPhase(now, sunAltDeg, times);

      // season weights for ground colour (summer/monsoon, autumn, winter, spring)
      const bump = (center, width) => {
        let d = Math.abs(doy - center);
        d = Math.min(d, 365 - d);
        return Math.exp(-(d * d) / (2 * width * width));
      };
      const ws = [bump(215, 45), bump(310, 30), bump(20, 35), bump(105, 30)];
      const sum = ws.reduce((x, y) => x + y, 0) || 1;
      for (let i = 0; i < 4; i++) s.season[i] = ws[i] / sum;

      s.astro = {
        sunAltDeg,
        sunAzDeg: sun.azimuthDeg,
        moonAltDeg,
        moonAzDeg: moon.azimuthDeg,
        moonFraction: ill.fraction,
        moonPhase: ill.phase,
        moonPhaseName: A.moonPhaseName(ill.phase),
        moonRise: moonEv.rise,
        moonSet: moonEv.set,
        times,
        phase,
        dawnFactor: dawn,
        dayOfYear: doy,
      };
    }

    _lightning(dt, t, storm) {
      if (storm < 0.3) {
        this.flash *= Math.exp(-dt * 12);
        this._pulses.length = 0;
        return;
      }
      if (t >= this._nextFlash) {
        const n = 1 + Math.floor(Math.random() * 3);
        // each strike lights its own part of the sky (fractions of the screen, 0 = bottom)
        this.flashPos = [0.05 + Math.random() * 0.9, 0.58 + Math.random() * 0.34];
        let at = t;
        for (let i = 0; i < n; i++) {
          at += 0.05 + Math.random() * 0.18;
          this._pulses.push({ at, amp: (0.35 + Math.random() * 0.65) * (i === 0 ? 1 : 0.7) });
        }
        // in the demo a storm has a few seconds to show itself: strikes come about three times as often
        this._nextFlash = t + (5 + Math.random() * 14) / storm / (this.pace > 1 ? 3 : 1);
      }
      let f = 0;
      for (let i = this._pulses.length - 1; i >= 0; i--) {
        const p = this._pulses[i];
        const d = t - p.at;
        if (d > 0.6) {
          this._pulses.splice(i, 1);
          continue;
        }
        if (d >= 0) f = Math.max(f, p.amp * Math.exp(-d * 14));
      }
      this.flash = f * storm;
    }

    static presets() {
      return PRESETS;
    }
  }

  LE.Environment = Environment;
  LE.weatherPresets = PRESETS;
})();
