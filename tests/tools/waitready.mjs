// Waits for the wallpaper to start rendering, then prints its size and frame stats. Test use only.
// usage: node waitready.mjs <port> <timeoutSeconds> <samples>
const port = process.argv[2] || '9333';
const timeoutSec = Number(process.argv[3] || 180);
const samples = Number(process.argv[4] || 4);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
let page = null;
while (!page && Date.now() - t0 < timeoutSec * 1000) {
  try {
    const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
    page = targets.find((t) => t.type === 'page' && /index\.html/.test(t.url));
  } catch { /* Edge is still starting */ }
  if (!page) await sleep(1000);
}
if (!page) { console.log('page never appeared'); process.exit(1); }
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
const snap = `(()=>{const l=window.__le;const d=document.getElementById('debug');return {hidden:document.hidden,ready:!!window.__leReady,status:l&&l.renderer&&l.renderer.status,gpuMs:l&&l.renderer&&+(l.renderer.gpuFrameMs||0).toFixed(1),inner:innerWidth+'x'+innerHeight,canvas:l&&l.renderer&&(l.renderer.w+'x'+l.renderer.h),dbg:d?d.textContent.split('\\n')[0]:''}})()`;
let s = await evalJs(snap);
while (!(s && s.ready) && Date.now() - t0 < timeoutSec * 1000) {
  await sleep(2000);
  s = await evalJs(snap);
}
console.log(`ready after ${Math.round((Date.now() - t0) / 1000)} s:`, JSON.stringify(s));
for (let i = 0; i < samples; i++) {
  await sleep(4000);
  console.log(JSON.stringify(await evalJs(snap)));
}
ws.close();
