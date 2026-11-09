/*
 * The demo: a year in two minutes, to see everything the wallpaper does at once, or to film it.
 *
 * One short chapter for each month, each a part of a day typical of it, with its weather and what goes on then:
 * snow settling on the tree, sunrise on fresh snow, spring blossom with clouds streaming off the peaks, night falling
 * with village lights, stars and meteors, fog lifting from the valleys, the monsoon's thunder and rain with mist
 * rising after it, harvest fires, the Orionid meteors, crisp autumn mornings, snow at dusk. The clock races through
 * each chapter's hours and a short dip to dark hides the jump to the next. It plays over and over until turned off.
 *
 * Pure logic: main.js asks it what the scene is at a moment (step) and sets the clock, the weather and the life.
 */
(function () {
  'use strict';
  const LE = (window.LE = window.LE || {});

  const CHAPTER_S = 9.5; // seconds for each month: long enough for its weather to form and to take it in
  const DIP_S = 0.8; // the dip to dark between months, half on each side of the change

  // Weather as the weather service gives it. Winds at the cloud layers come from the north-west, so across the view
  // (which faces north-east) they blow from left to right and banner clouds stream out sideways like flags.
  const W = {
    snow: { code: 73, cloud: 100, cloudHigh: 70, humidity: 92, visibility: 2500, windSpeed: 9, windDir: 320, precip: 1.6, snowfall: 1.3, temp: -4 },
    heavySnow: { code: 75, cloud: 100, cloudHigh: 80, humidity: 95, visibility: 1500, windSpeed: 14, windDir: 320, precip: 3, snowfall: 2.5, temp: -6 },
    clearCold: { code: 0, cloud: 3, cloudHigh: 5, humidity: 55, visibility: 50000, windSpeed: 6, windDir: 320, precip: 0, temp: -3 },
    streaming: { code: 2, cloud: 35, cloudLow: 20, cloudMid: 15, cloudHigh: 30, humidity: 80, visibility: 30000, windSpeed: 14, windDir: 315, wind850: 30, dir850: 315, wind700: 48, dir700: 320, wind300: 90, dir300: 300, precip: 0, temp: 18 },
    clearNight: { code: 0, cloud: 2, cloudHigh: 3, humidity: 50, visibility: 50000, windSpeed: 5, windDir: 320, precip: 0, temp: 12 },
    fog: { code: 45, cloud: 25, cloudHigh: 10, humidity: 99, visibility: 300, windSpeed: 3, windDir: 30, precip: 0, temp: 14 },
    partly: { code: 2, cloud: 40, cloudHigh: 30, humidity: 64, visibility: 25000, windSpeed: 11, windDir: 300, precip: 0, temp: 22 },
    storm: { code: 95, cloud: 100, cloudHigh: 90, humidity: 94, visibility: 4000, windSpeed: 30, windDir: 140, precip: 7, temp: 25 },
    rain: { code: 63, cloud: 100, cloudHigh: 80, humidity: 93, visibility: 6000, windSpeed: 15, windDir: 160, precip: 2.5, temp: 23 },
    afterRain: { code: 3, cloud: 85, cloudHigh: 60, humidity: 92, visibility: 15000, windSpeed: 8, windDir: 170, precip: 0, temp: 24 },
    golden: { code: 1, cloud: 15, cloudHigh: 25, humidity: 55, visibility: 30000, windSpeed: 7, windDir: 290, precip: 0, temp: 24 },
    crisp: { code: 0, cloud: 5, cloudHigh: 10, humidity: 50, visibility: 50000, windSpeed: 8, windDir: 300, precip: 0, temp: 9 },
    greyDusk: { code: 3, cloud: 100, cloudHigh: 70, humidity: 88, visibility: 9000, windSpeed: 10, windDir: 320, precip: 0, temp: -1 },
  };

  // from / to: the hours it races through. then: a second weather from that share of the chapter on. wet, snow: how wet
  // the land and how much fresh snow lies when it begins. summon: [what, at which share of the chapter].
  const CHAPTERS = [
    { month: 1, day: 14, from: '12:40', to: '16:40', weather: W.snow, snow: 0.1, caption: 'January', line: 'Snow settles on the tree and the hills' },
    { month: 2, day: 9, from: '05:45', to: '09:15', weather: W.clearCold, snow: 1, caption: 'February', line: 'Sunrise on fresh snow', summon: [['geese', 0.45]] },
    { month: 3, day: 22, from: '15:00', to: '19:00', weather: W.streaming, caption: 'March', line: 'Spring blossom; clouds stream off the peaks in the wind', summon: [['flock', 0.3]] },
    { month: 4, day: 16, from: '18:50', to: '23:40', weather: W.clearNight, caption: 'April', line: 'Night falls: village lights, stars and meteors', summon: [['meteor', 0.55], ['satellite', 0.6], ['meteor', 0.75], ['meteor', 0.9]] },
    { month: 5, day: 12, from: '05:20', to: '09:40', weather: W.fog, then: [0.45, W.partly], caption: 'May', line: 'Morning fog lifts from the valleys', summon: [['raptor', 0.6]] },
    { month: 6, day: 18, from: '11:00', to: '16:00', weather: W.storm, caption: 'June', line: 'The monsoon arrives with thunder' },
    { month: 7, day: 24, from: '07:30', to: '12:30', weather: W.rain, then: [0.5, W.afterRain], wet: 1, caption: 'July', line: 'Monsoon rain, and mist rising from the forest', summon: [['mist', 0.55], ['mist', 0.7]] },
    { month: 8, day: 17, from: '11:30', to: '17:00', weather: W.streaming, wet: 0.4, caption: 'August', line: 'Cloud factories on the high peaks', summon: [['flock', 0.5]] },
    { month: 9, day: 27, from: '16:20', to: '19:50', weather: W.golden, caption: 'September', line: 'Harvest fires and a golden evening', summon: [['fire', 0.05], ['smoke', 0.4]] },
    { month: 10, day: 21, from: '20:30', to: '04:30', weather: W.clearNight, caption: 'October', line: 'The Orionid meteors over the range', summon: [['meteor', 0.15], ['satellite', 0.25], ['meteor', 0.35], ['meteor', 0.5], ['satellite', 0.6], ['meteor', 0.7], ['meteor', 0.85]] },
    { month: 11, day: 15, from: '06:20', to: '11:20', weather: W.crisp, caption: 'November', line: 'Crisp mornings, autumn colours and a busy road', summon: [['raptor', 0.3], ['bus', 0.4], ['smoke', 0.2]] },
    { month: 12, day: 21, from: '13:30', to: '18:10', weather: W.greyDusk, then: [0.3, W.heavySnow], snow: 0.3, caption: 'December', line: 'Snow at dusk on the longest night' },
  ];

  const minutes = (hhmm) => {
    const [h, m] = hhmm.split(':').map(Number);
    return h * 60 + m;
  };

  class Demo {
    constructor() {
      this.on = false;
      this.year = new Date().getFullYear();
      this._t0 = 0;
      this._last = -1; // the chapter at the last step
      this._lastShare = 0;
      this._weather = null;
    }

    start(realMs, year = new Date().getFullYear()) {
      this.on = true;
      this.year = year;
      this._t0 = realMs;
      this._last = -1;
      this._lastShare = 0;
      this._weather = null;
    }

    stop() {
      this.on = false;
    }

    /** How long one pass through the year takes (s). */
    static get length() {
      return CHAPTERS.length * CHAPTER_S;
    }

    /** The weather the demo shows now (for the panel and for weather updates that arrive meanwhile). */
    weather() {
      return this._weather;
    }

    /**
     * The scene at this moment: { chapter, share (0..1 through it), now (the simulated time), weather, changed (a new
     * chapter began since the last step), weatherChanged, wet, snow (to begin the chapter with), summons (what to
     * call up since the last step), caption, line, dip (0 clear .. 1 dark), pass (how many times round) }.
     */
    step(realMs) {
      const t = Math.max(0, (realMs - this._t0) / 1000);
      const pass = Math.floor(t / Demo.length);
      const inPass = t - pass * Demo.length;
      const index = Math.min(CHAPTERS.length - 1, Math.floor(inPass / CHAPTER_S));
      const c = CHAPTERS[index];
      const tc = inPass - index * CHAPTER_S;
      const share = tc / CHAPTER_S;

      const from = minutes(c.from);
      let to = minutes(c.to);
      if (to <= from) to += 24 * 60; // through midnight
      const at = from + (to - from) * share;
      const now = new Date(this.year, c.month - 1, c.day, 0, 0, 0, 0);
      now.setTime(now.getTime() + at * 60000);

      const key = pass * CHAPTERS.length + index;
      const changed = key !== this._last;
      const weather = c.then && share >= c.then[0] ? c.then[1] : c.weather;
      const weatherChanged = weather !== this._weather;
      const before = changed ? -1 : this._lastShare;
      const summons = (c.summon || []).filter(([, s]) => s > before && s <= share).map(([k]) => k);
      this._last = key;
      this._lastShare = share;
      this._weather = weather;

      const edge = Math.min(tc, CHAPTER_S - tc);
      const dip = Math.max(0, 1 - edge / (DIP_S / 2));
      return {
        chapter: index,
        share,
        now,
        weather,
        changed,
        weatherChanged,
        wet: c.wet || 0,
        snow: c.snow || 0,
        summons,
        caption: c.caption,
        line: c.line,
        dip,
        pass,
      };
    }
  }

  Demo.CHAPTERS = CHAPTERS;
  Demo.CHAPTER_S = CHAPTER_S;
  LE.Demo = Demo;
})();
