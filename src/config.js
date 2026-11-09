/*
 * Living Earth Himalaya — configuration
 * Every value here can be changed by Lively properties (LivelyProperties.json)
 * or, for browser testing, by URL parameters (see README.md → "Testing in a browser").
 */
(function () {
  'use strict';
  const LE = (window.LE = window.LE || {});

  LE.config = {
    version: '2.2.0',

    location: {
      name: 'Dhaka',
      lat: 23.7104,
      lon: 90.4074,
      useGeolocation: true, // falls back to the coordinates above
      geoTimeoutMs: 8000,
    },

    weather: {
      refreshMinutes: 15, // Open-Meteo refresh interval
      staleAfterMinutes: 75, // after this, "current" switches to the cached hourly forecast
      forecastHorizonHours: 48, // how long a cached forecast is trusted offline
      retryMinMinutes: 2, // first retry after a failed request
      retryMaxMinutes: 30, // back-off ceiling
      requestTimeoutMs: 15000,
      startWaitMs: 20000, // how long the start-up screen waits for the current weather
    },

    render: {
      fpsCap: 30,
      smartFps: true, // drop to calmFps while nothing fast (birds, rain, snow, lightning, meteors) is on screen
      calmFps: 20,
      maxGpuShare: 0.5, // the most of the GPU's time this page may take. The rest is for the desktop and other apps
      calmSceneMs: 500, // with no rain or snow, redraw the scene this often and fade between pictures: 0 = every frame
      quality: 'auto', // auto | eco | balanced | high | ultra
      renderScale: 1.0, // internal resolution multiplier
      maxPixels: 4.2e6, // about 3840x1080. A bigger window (a 4K screen) is drawn at this size and scaled up
      heading: 50, // compass direction at the centre of the panorama (50 = north-east: sunrise behind the peaks)
      seed: 1, // landscape variation
      cameraAltitude: 2.8, // km above sea level
      horizonY: 0.4, // horizon height as a fraction of the screen (0 = bottom)
      maxHFovDeg: 140, // horizontal field of view for a 32:9 span
      spanTurnDeg: 12, // across two screens, the great range turns this far right: the sharp peak at the centre would stand on
      // the bezel, and 12 degrees puts the bezel on a low ridge and that peak well inside the right-hand screen
      tree: true, // the tree on the rock at the left, and the leaves the wind carries past
    },

    atmosphere: {
      cloudSpeed: 1, // 1 = real wind speed, higher = time-lapse (up to 10)
      treeWind: 1, // how strongly wind shows in the trees: 0 = off, 1 = natural, up to 3
      transitionSeconds: 90, // typical pace of a weather change; the real time depends on what's changing and the wind
    },

    ui: {
      showPanel: true,
      panelPosition: 'right-bottom', // right-bottom | right-top | left-bottom | left-top
      panelSize: 'medium', // small | medium | large
      clock24h: false,
      tempUnit: 'C',
    },

    overrides: {
      weather: null, // null = live; or clear | partly | overcast | rain | heavyrain | storm | fog | snow
      time: null, // 'HH:MM' preview time
      date: null, // 'YYYY-MM-DD'
      timelapse: 0, // simulated seconds per real second (0 = real time)
    },

    debug: false,
  };

  // ---- URL overrides (browser testing) ----
  const q = new URLSearchParams(window.location.search);
  const c = LE.config;
  const num = (k, f) => (q.has(k) && !isNaN(parseFloat(q.get(k))) ? parseFloat(q.get(k)) : f);
  c.overrides.weather = q.get('weather') || c.overrides.weather;
  c.overrides.time = q.get('time') || c.overrides.time;
  c.overrides.date = q.get('date') || c.overrides.date;
  c.overrides.timelapse = num('timelapse', c.overrides.timelapse);
  c.render.fpsCap = num('fps', c.render.fpsCap);
  c.render.calmSceneMs = num('calm', q.get('test') === '1' ? 0 : c.render.calmSceneMs); // tests look at every frame
  if (q.has('smartfps')) c.render.smartFps = q.get('smartfps') !== '0';
  if (q.has('tree')) c.render.tree = q.get('tree') !== '0';
  c.render.quality = q.get('quality') || c.render.quality;
  c.render.renderScale = num('scale', c.render.renderScale);
  c.render.heading = num('heading', c.render.heading);
  c.render.seed = num('seed', c.render.seed);
  c.render.spanTurnDeg = num('spanturn', c.render.spanTurnDeg);
  c.atmosphere.cloudSpeed = num('clouds', c.atmosphere.cloudSpeed);
  c.atmosphere.treeWind = num('trees', c.atmosphere.treeWind);
  if (q.has('panel')) c.ui.showPanel = q.get('panel') !== '0';
  if (q.has('geo')) c.location.useGeolocation = q.get('geo') !== '0';
  if (q.has('lat') && q.has('lon')) {
    const lat = num('lat', NaN);
    const lon = num('lon', NaN);
    if (Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
      c.location.lat = lat;
      c.location.lon = lon;
      c.location.useGeolocation = false;
    }
  }
  // the place name shown in the panel, chosen in the Windows app (host/)
  if (q.get('place')) c.location.name = q.get('place').slice(0, 60);
  c.debug = q.get('debug') === '1';
  c.windTest = q.get('windtest') === '1' && !c.debug; // a panel for trying wind speeds and directions on the tree. ?debug=1 has its own
  c.debugView = parseInt(q.get('view') || '0', 10) || 0; // 1 albedo 2 normal 3 shadow 4 AO 5 depth 6 volume 7 canopy
  c.testMode = q.get('test') === '1'; // used by automated screenshot tests
  c.life = q.get('life') !== '0'; // birds, smoke, meteors, satellites, village lights
  c.lifeTest = q.get('lifetest') === '1'; // tests: start with birds already on screen
  c.road = q.get('road') !== '0'; // the road on the hillside and its traffic
  c.birds = q.get('birds') !== '0'; // birds alone, while smoke, meteors and lights stay
  c.traffic = ['light', 'normal', 'busy'].includes(q.get('traffic')) ? q.get('traffic') : 'normal'; // how much is on the road
  c.leaves = q.get('leaves') !== '0'; // the leaves the wind carries past. The tree stays
  c.mist = q.get('mist') !== '0'; // mist rising off the forest
  c.banners = q.get('banners') !== '0'; // banner clouds streaming from the high peaks in the wind
  c.demo = q.get('demo') === '1'; // the demo: a year in two minutes, over and over (src/services/demo.js)
  c.smoke = q.get('smoke') !== '0'; // smoke from the villages, and their cooking fires after dark
  c.fires = q.get('fires') !== '0'; // a field burning on a hill now and then
  c.lights = q.get('lights') !== '0'; // lights in the villages at night
  c.shootingStars = q.get('stars') !== '0'; // meteors and satellites. The stars themselves stay
  if (['right-bottom', 'right-top', 'left-bottom', 'left-top'].includes(q.get('corner'))) c.ui.panelPosition = q.get('corner');
  if (['small', 'medium', 'large'].includes(q.get('panelsize'))) c.ui.panelSize = q.get('panelsize');
})();
