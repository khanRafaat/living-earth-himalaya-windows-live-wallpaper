// Changes the weather while the wallpaper is in slow mode and logs each step. Test use only.
// usage: node weathertest.mjs <port> <preset|live> <seconds>
const port = process.argv[2] || '9333';
const preset = process.argv[3] || 'overcast';
const seconds = Number(process.argv[4] || 120);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = targets.find((t) => t.type === 'page' && /index\.html/.test(t.url));
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let id = 0;
const pending = new Map();
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); }
});
const evalJs = (expression) => new Promise((resolve) => {
  const i = ++id;
  pending.set(i, (r) => resolve(r?.result?.value));
  ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }));
});
await evalJs(`(()=>{const r=window.__le.renderer;if(!r.__orig){r.__orig=r.render;r.__n=0;r.render=function(...a){r.__n++;return r.__orig.apply(this,a)}}})()`);
const read = `(()=>{const l=window.__le,w=l.env.w;return {n:l.renderer.__n,coverage:+w.coverage.toFixed(4),overcast:+w.overcast.toFixed(4),rain:+w.rain.toFixed(4),mist:+w.mist.toFixed(4),gpu:+(l.renderer.gpuFrameMs||0).toFixed(1),hidden:document.hidden}})()`;
const before = await evalJs(read);
console.log('before', JSON.stringify(before));
await evalJs(`window.__le.cfg.overrides.weather=${preset === 'live' ? 'null' : JSON.stringify(preset)};window.__le.weather._emit();`);
console.log(`weather set to ${preset}`);
let last = before;
let biggest = 0;
const t0 = Date.now();
while (Date.now() - t0 < seconds * 1000) {
  await sleep(1000);
  const s = await evalJs(read);
  if (s.n !== last.n) {
    const step = Math.abs(s.coverage - last.coverage);
    biggest = Math.max(biggest, step);
    console.log(`t+${String(Math.round((Date.now() - t0) / 1000)).padStart(3)}s frames+${String(s.n - last.n).padStart(3)} coverage ${s.coverage.toFixed(3)} (step ${step.toFixed(3)}) overcast ${s.overcast.toFixed(3)} rain ${s.rain.toFixed(3)} gpuMs ${s.gpu}`);
    last = s;
  }
}
console.log(`total coverage change ${Math.abs(last.coverage - before.coverage).toFixed(3)}, biggest single step ${biggest.toFixed(3)}`);
ws.close();
