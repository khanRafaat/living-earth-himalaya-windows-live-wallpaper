// Renders the stills the Windows app sets as the Windows desktop background, so Settings > Personalization shows this
// wallpaper too: one for each part of the day, chosen by where the sun is. Windows cannot take a picture of the live
// wallpaper itself (Edge draws it with the graphics chip, behind the desktop icons, where PrintWindow sees only black).
//
// Runs Edge headless on the CPU (Direct3D on the software adapter, refusing anything else), on half the logical
// processors at below-normal priority, so the PC stays usable. Takes the better part of an hour.
// usage: node host/stills.mjs [out dir, default host/stills]     env: LE_STILLS="night,dusk" for some of them
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.resolve(process.argv[2] || path.join(ROOT, 'host', 'stills'));
const W = +(process.env.LE_W || 3840), H = +(process.env.LE_H || 1080), QUALITY = 0.86; // a smaller size only to try the tool out
const DATE = '2026-05-15';
// the page's default place, as a first-time viewer sees it
const LAT = 23.7104, LON = 90.4074;
// name: [sun altitude in degrees, morning or evening]. The app chooses between them with the same bands (LivingEarthHost.cs, Stills).
const STILLS = {
  night: [-30, 'evening'],
  dawn: [-3, 'morning'],
  morning: [8, 'morning'],
  day: [55, 'morning'],
  golden: [6, 'evening'],
  dusk: [-3, 'evening'],
};
const want = (process.env.LE_STILLS || Object.keys(STILLS).join(',')).split(',');

mkdirSync(outDir, { recursive: true });
os.setPriority(0, os.constants.priority.PRIORITY_BELOW_NORMAL);
execFileSync('powershell', ['-NoProfile', '-Command', `(Get-Process -Id ${process.pid}).ProcessorAffinity = ${2 ** (os.cpus().length >> 1) - 1}`]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = path.join(os.tmpdir(), 'living-earth-stills-profile');
rmSync(profile, { recursive: true, force: true });
mkdirSync(profile, { recursive: true });
const edge = spawn(EDGE, ['--headless=new', '--use-angle=d3d11-warp', '--remote-debugging-port=0', `--user-data-dir=${path.resolve(profile)}`, '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--mute-audio', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
const wsUrl = await new Promise((res, rej) => {
  let b = '';
  const to = setTimeout(() => rej(new Error('Edge did not start: ' + b)), 60000);
  edge.stderr.on('data', (d) => {
    b += d;
    const m = /DevTools listening on (ws:\S+)/.exec(b);
    if (m) { clearTimeout(to); res(m[1]); }
  });
});
const port = new URL(wsUrl).port;
const page = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.addEventListener('open', r, { once: true }); ws.addEventListener('error', j, { once: true }); });
let id = 0;
const pend = new Map();
const errors = [];
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pend.has(m.id)) {
    const p = pend.get(m.id);
    pend.delete(m.id);
    if (m.error) p.j(new Error(m.error.message)); else p.r(m.result);
  } else if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
});
const send = (method, params = {}) => new Promise((r, j) => { const i = ++id; pend.set(i, { r, j }); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
};
const finish = async (code) => {
  try { await send('Browser.close'); } catch {}
  ws.close();
  await sleep(1500);
  edge.kill();
  rmSync(profile, { recursive: true, force: true });
  process.exit(code);
};
process.on('uncaughtException', (e) => { console.log('STOPPED:', e.message); try { edge.kill(); } catch {} process.exit(4); });
process.on('unhandledRejection', (e) => { console.log('STOPPED:', e && e.message); try { edge.kill(); } catch {} process.exit(4); });

await send('Runtime.enable');
await send('Page.enable');
const renderer = await ev(`(() => { const gl = document.createElement('canvas').getContext('webgl2'); if (!gl) return 'no WebGL2'; const d = gl.getExtension('WEBGL_debug_renderer_info'); return d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER); })()`);
if (!/Basic Render|WARP/i.test(renderer)) { console.log('REFUSING: not a software adapter:', renderer); await finish(3); }
await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
await send('Page.addScriptToEvaluateOnNewDocument', { source: `window.fetch = () => Promise.reject(new Error('offline'));` });
const query = `?geo=0&lat=${LAT}&lon=${LON}&weather=clear&time=12:00&date=${DATE}&quality=high&fps=30&panel=0&smartfps=0`;
await send('Page.navigate', { url: pathToFileURL(path.join(ROOT, 'index.html')).href + query });

const t0 = Date.now();
for (;;) {
  const s = await ev(`(() => { const r = window.__le && __le.renderer; const v = document.getElementById('veil'); return { ready: !!window.__leReady, status: r ? r.status : 'none', failed: v && v.classList.contains('error') ? document.querySelector('.veil-sub').textContent : '' }; })()`).catch(() => ({}));
  if (s.failed) { console.log('FAILED:', s.failed.slice(0, 1800)); await finish(2); }
  if (s.ready) break;
  if (Date.now() - t0 > 3600000) { console.log('timed out', s.status, errors.slice(0, 3)); await finish(2); }
  await sleep(1000);
}
console.log('first picture after', ((Date.now() - t0) / 1000).toFixed(0), 's');

await ev(`(() => {
  const R = __le.renderer, gl = R.gl;
  window.__frames = (n) => new Promise((done) => { const o = R.render; let k = 0; R.render = function (s, dt) { const d = o.call(R, s, dt); if (d && ++k >= n) { R.render = o; done(); } return d; }; });
  // the time of day when the sun stands at this altitude, in the morning or the evening
  window.__timeFor = (alt, half) => {
    let best = null, bd = 1e9;
    for (let m = 0; m < 24 * 60; m += 2) {
      const d = new Date('${DATE}T00:00:00');
      d.setMinutes(m);
      const p = LE.astronomy.sunPosition(d, ${LAT}, ${LON});
      const a = (p.altitude * 180) / Math.PI;
      const isMorning = p.azimuthDeg < 180;
      if ((half === 'morning') !== isMorning) continue;
      if (Math.abs(a - alt) < bd) { bd = Math.abs(a - alt); best = d; }
    }
    return String(best.getHours()).padStart(2, '0') + ':' + String(best.getMinutes()).padStart(2, '0');
  };
  // the picture as shown, as a JPEG
  window.__jpeg = (q) => new Promise((done) => {
    const o = R.render;
    R.render = function (s, dt) {
      const d = o.call(R, s, dt);
      if (!d) return d;
      R.render = o;
      const w = R.w, h = R.h, px = new Uint8Array(w * h * 4);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      const ctx = c.getContext('2d');
      const img = ctx.createImageData(w, h);
      for (let y = 0; y < h; y++) img.data.set(px.subarray((h - 1 - y) * w * 4, (h - y) * w * 4), y * w * 4);
      for (let i = 3; i < img.data.length; i += 4) img.data[i] = 255;
      ctx.putImageData(img, 0, 0);
      done(c.toDataURL('image/jpeg', q));
      return d;
    };
  });
})()`);

for (const name of want) {
  const [alt, half] = STILLS[name];
  const time = await ev(`__timeFor(${alt}, '${half}')`);
  const t1 = Date.now();
  await ev(`(() => { LE.clock.configure({ time: '${time}', date: '${DATE}' }); __le.env.w = null; __le.renderer._adaptReset = true; return __frames(3); })()`);
  // new sun, new shadows: wait for them, then let the sky and the eye settle
  for (let k = 0; k < 600 && (await ev('__le.renderer.status')) !== 'running'; k++) await sleep(1000);
  // smoke over the villages, as there is most of the day: it takes minutes to gather by itself
  await ev(`(() => { const L = __le.renderer.life; L.smoke = L.smoke.filter((s) => !s.held); L.summon('smoke'); return true; })()`);
  await ev('__frames(16)');
  const url = await ev(`__jpeg(${QUALITY})`);
  const file = path.join(outDir, name + '.jpg');
  writeFileSync(file, Buffer.from(url.split(',')[1], 'base64'));
  console.log(`${name}: ${time}, sun ${alt}° ${half}, ${((Date.now() - t1) / 1000).toFixed(0)} s, ${(Buffer.byteLength(url) * 0.75 / 1024).toFixed(0)} KB`);
}
console.log('messages', errors.length, errors.slice(0, 5));
await finish(0);
