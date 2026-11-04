// Drives the wallpaper in headless Edge WITHOUT THE GPU: software rendering on the CPU, at a small
// size and below-normal priority so it doesn't get in the way of other work. It refuses to load the
// wallpaper if the browser reports anything other than software rendering.
//
// This checks behaviour: shaders compile, pause works, wind direction, no jumps. It can't say how
// fast the wallpaper runs on a real graphics chip.
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import os from 'node:os';
import path from 'node:path';

export const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
export const PROJECT = path.resolve(new URL('../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
export const WIDTH = 960; // same 32:9 shape as the real 3840×1080, a quarter of the size
export const HEIGHT = 270;
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Windows passes a below-normal priority on to child processes, so Edge inherits it
os.setPriority(0, os.constants.priority.PRIORITY_BELOW_NORMAL);

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.listeners = new Map();
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        if (m.error) reject(new Error(`${m.error.message} ${m.error.data || ''}`));
        else resolve(m.result);
      } else if (m.method && this.listeners.has(m.method)) {
        for (const fn of this.listeners.get(m.method)) fn(m.params);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  on(method, fn) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(fn);
  }
}

/** Opens the wallpaper in headless Edge with software rendering. */
export async function openWallpaper({ query = '', profile, beforeLoad = '' }) {
  mkdirSync(profile, { recursive: true });
  const edge = spawn(
    EDGE,
    [
      '--headless=new',
      '--disable-gpu',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      '--remote-debugging-port=0',
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--mute-audio',
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] }
  );
  const wsUrl = await new Promise((resolve, reject) => {
    let buf = '';
    const to = setTimeout(() => reject(new Error('Edge did not start: ' + buf)), 30000);
    edge.stderr.on('data', (d) => {
      buf += d;
      const m = /DevTools listening on (ws:\S+)/.exec(buf);
      if (m) {
        clearTimeout(to);
        resolve(m[1]);
      }
    });
  });
  const port = new URL(wsUrl).port;
  const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  const pageTarget = targets.find((t) => t.type === 'page');
  const ws = new WebSocket(pageTarget.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  const cdp = new Cdp(ws);
  const errors = [];
  cdp.on('Runtime.exceptionThrown', (p) => errors.push(p.exceptionDetails.exception?.description || p.exceptionDetails.text));
  cdp.on('Runtime.consoleAPICalled', (p) => {
    if (p.type === 'error') errors.push(p.args.map((a) => a.value ?? a.description).join(' '));
  });
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');

  const evaluate = async (expression) => {
    const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  const close = async () => {
    const exited = new Promise((resolve) => edge.once('exit', resolve));
    try {
      await cdp.send('Browser.close');
    } catch {}
    ws.close();
    await Promise.race([exited, sleep(10000)]);
    edge.kill();
    await sleep(1500);
  };

  // The guarantee: the wallpaper never loads unless rendering is on the CPU
  const renderer = await evaluate(`(() => {
    const gl = document.createElement('canvas').getContext('webgl2');
    if (!gl) return 'no WebGL2';
    const d = gl.getExtension('WEBGL_debug_renderer_info');
    return d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
  })()`);
  if (!/swiftshader/i.test(renderer)) {
    await close();
    throw new Error(`Refusing to run: this would not be software rendering (renderer: ${renderer})`);
  }

  await cdp.send('Emulation.setDeviceMetricsOverride', { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false });
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: PAGE_TOOLS + beforeLoad });
  const url = pathToFileURL(path.join(PROJECT, 'index.html')).href + (query ? `?${query}` : '');
  const t0 = Date.now();
  await cdp.send('Page.navigate', { url });

  return {
    cdp,
    evaluate,
    errors,
    renderer,
    close,
    /** Waits until the scene is running. Returns the seconds it took. */
    async ready(timeoutMs = 900000) {
      for (;;) {
        const done = await evaluate('!!window.__leReady').catch(() => false);
        if (done) return (Date.now() - t0) / 1000;
        if (Date.now() - t0 > timeoutMs) throw new Error('Timed out waiting for the scene. Errors: ' + errors.join(' | '));
        const failed = await evaluate(`document.getElementById('veil').classList.contains('error') ? document.querySelector('.veil-sub').textContent : ''`).catch(() => '');
        if (failed) throw new Error('Scene failed: ' + failed);
        await sleep(1000);
      }
    },
    async savePng(expression, file) {
      const data = await evaluate(expression);
      writeFileSync(file, Buffer.from(data.split(',')[1], 'base64'));
    },
  };
}

/** Page helpers. The weather service stays offline in tests, so results don't depend on the network. */
const PAGE_TOOLS = `
window.fetch = () => Promise.reject(new Error('offline in tests'));
window.T = {
  /** The next drawn frame's pixels, read right after it was drawn */
  grab(y0, h) {
    return new Promise((resolve) => {
      const r = __le.renderer;
      const gl = r.gl;
      const orig = r.render;
      r.render = function (s, dt) {
        const drew = orig.call(r, s, dt);
        if (!drew) return drew;
        r.render = orig;
        const px = new Uint8Array(r.w * h * 4);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.readPixels(0, y0, r.w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
        resolve({ px, w: r.w, h, t: performance.now() });
        return drew;
      };
    });
  },
  /** Resolves after n more frames have been drawn */
  async frames(n) {
    for (let i = 0; i < n; i++) await T.grab(0, 1);
  },
  lum(f) {
    const n = f.w * f.h;
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = 0.2126 * f.px[i * 4] + 0.7152 * f.px[i * 4 + 1] + 0.0722 * f.px[i * 4 + 2];
    return out;
  },
  /** Mean change per pixel (levels out of 255), and the share of pixels that changed by 2 levels or more */
  change(a, b) {
    const la = this.lum(a);
    const lb = this.lum(b);
    let sum = 0;
    let big = 0;
    for (let i = 0; i < la.length; i++) {
      const d = Math.abs(la[i] - lb[i]);
      sum += d;
      if (d >= 2) big++;
    }
    return { mean: sum / la.length, share: big / la.length };
  },
  /** PNG of a frame, or of an amplified difference when a second frame is given */
  png(a, b, gain = 1) {
    const c = document.createElement('canvas');
    c.width = a.w;
    c.height = a.h;
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(a.w, a.h);
    for (let y = 0; y < a.h; y++) {
      for (let x = 0; x < a.w; x++) {
        const s = (y * a.w + x) * 4;
        const d = ((a.h - 1 - y) * a.w + x) * 4;
        for (let k = 0; k < 3; k++) {
          img.data[d + k] = b ? Math.max(0, Math.min(255, 128 + (a.px[s + k] - b.px[s + k]) * gain)) : a.px[s + k];
        }
        img.data[d + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    return c.toDataURL('image/png');
  },
  /** Sets weather directly and jumps straight to it */
  weather(rec) {
    __le.weather.stop();
    __le.env.setWeather(rec, 'live');
    __le.env.w = null;
    __le.env.treeWind = null;
  },
};
`;
