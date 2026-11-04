// Counts rendered frames in each interval, to prove when the wallpaper is really idle. Test use only.
// usage: node frames.mjs <port> <seconds> <intervalSeconds>
const port = process.argv[2] || '9333';
const seconds = Number(process.argv[3] || 70);
const step = Number(process.argv[4] || 5);
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
const count = `(()=>{const r=window.__le.renderer;if(!r.__orig){r.__orig=r.render;r.__n=0;r.render=function(...a){r.__n++;return r.__orig.apply(this,a)}}return r.__n})()`;
let last = await evalJs(count);
const end = Date.now() + seconds * 1000;
while (Date.now() < end) {
  await sleep(step * 1000);
  const n = await evalJs(count);
  console.log(new Date().toTimeString().slice(0, 8), `frames: ${n - last}`);
  last = n;
}
ws.close();
