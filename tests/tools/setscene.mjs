// Jumps the running wallpaper to a time and weather, for checking how scenes look. Test use only.
// usage: node setscene.mjs <port> <HH:MM> <preset> <settleSeconds> [flash]
const [port, time, preset, settle, flash] = [process.argv[2], process.argv[3], process.argv[4], Number(process.argv[5] || 9), process.argv[6] === 'flash'];
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
await evalJs(`(()=>{const l=window.__le;delete l.env._lightning;l.cfg.overrides.time=${JSON.stringify(time)};l.cfg.overrides.weather=${JSON.stringify(preset)};window.LE.clock.configure(l.cfg.overrides);l.weather._emit();l.env.w=null;l.renderer._volWarm=0;})()`);
await new Promise((r) => setTimeout(r, settle * 1000));
if (flash) {
  // hold a flash on screen long enough to capture it
  await evalJs(`(()=>{const e=window.__le.env;e._lightning=function(){this.flash=0.8;this.flashPos=[0.45,0.75];};})()`);
  await new Promise((r) => setTimeout(r, 400));
}
console.log(time, preset, flash ? 'flash' : '', JSON.stringify(await evalJs(`(()=>{const l=window.__le,s=l.env.state,a=s.astro;return {gpuMs:+(l.renderer.gpuFrameMs||0).toFixed(1),cover:+l.env.w.coverage.toFixed(2),rain:+l.env.w.rain.toFixed(2),flash:+(s.weather.flash||0).toFixed(2),sunAlt:+a.sunAltDeg.toFixed(1),moonAlt:+a.moonAltDeg.toFixed(1),moonAz:+(a.moonAzDeg||0).toFixed(0),moonPct:Math.round(a.moonFraction*100),heading:l.cfg.render.heading}})()`)));
ws.close();
