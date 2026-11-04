// Turns the surface-normal debug view on or off on the running wallpaper, and prints the sun direction.
// usage: node normals.mjs <port> on|off
const [port, mode] = [process.argv[2], process.argv[3]];
const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = targets.find((t) => t.type === 'page' && /index\.html/.test(t.url));
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
const value = await new Promise((resolve) => {
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.id === 1) resolve(m.result?.result?.value);
  });
  ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { returnByValue: true, expression:
    `(()=>{const l=window.__le;l.cfg.debugView=${mode === 'on' ? 2 : 0};const s=l.env.state;return JSON.stringify({sunDir:Array.from(s.sunDir).map(v=>+v.toFixed(3)),sunAz:+s.astro.sunAzDeg.toFixed(1),heading:l.cfg.render.heading});})()` } }));
});
console.log(mode, value);
ws.close();
