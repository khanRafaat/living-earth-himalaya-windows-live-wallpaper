// Logs whether the wallpaper is drawing, by counting frames over each interval. Test use only.
// usage: node watch.mjs <port> <seconds> <intervalSeconds>
const port = process.argv[2] || '9333';
const seconds = Number(process.argv[3] || 60);
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
const stamp = `(()=>{const l=window.__le;return {t:l.env.timeSec||null,w:l.env.w&&+l.env.w.coverage.toFixed(3),rec:l.env.record&&l.env.record.cloudCover,hidden:document.hidden,dbg:document.getElementById('debug').textContent.split('\\n')[0],src:l.env.recordSource}})()`;
let lastSun = await evalJs(`JSON.stringify(window.__le.env.w)`);
const end = Date.now() + seconds * 1000;
while (Date.now() < end) {
  await sleep(step * 1000);
  const cur = await evalJs(`JSON.stringify(window.__le.env.w)`);
  const s = await evalJs(stamp);
  console.log(new Date().toTimeString().slice(0, 8), cur !== lastSun ? 'DRAWING' : 'resting', JSON.stringify(s));
  lastSun = cur;
}
ws.close();
