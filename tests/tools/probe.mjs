// Reads the running wallpaper's own numbers over a temporary debug port. Test use only.
// usage: node probe.mjs <port> <seconds>
const [port, seconds] = [process.argv[2] || '9333', Number(process.argv[3] || 30)];
const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = targets.find((t) => t.type === 'page' && /index\.html/.test(t.url));
if (!page) throw new Error('page not found: ' + JSON.stringify(targets.map((t) => t.url)));
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
const snap = `(()=>{const l=window.__le;const d=document.getElementById('debug');return {hidden:document.hidden,ready:!!window.__leReady,status:l&&l.renderer&&l.renderer.status,gpuMs:l&&l.renderer&&+(l.renderer.gpuFrameMs||0).toFixed(1),quality:l&&l.governor&&l.governor.name(),size:l&&l.renderer&&(l.renderer.w+'x'+l.renderer.h),first:d?d.textContent.split('\\n')[0]:'',gl:(()=>{try{return l.renderer.gpuInfo()}catch(e){return ''}})(),veil:document.getElementById('veil').className,veilText:(document.querySelector('.veil-sub')||{}).textContent}})()`;
const end = Date.now() + seconds * 1000;
while (Date.now() < end) {
  const s = await evalJs(snap);
  console.log(new Date().toTimeString().slice(0, 8), JSON.stringify(s));
  await new Promise((r) => setTimeout(r, 5000));
}
ws.close();
