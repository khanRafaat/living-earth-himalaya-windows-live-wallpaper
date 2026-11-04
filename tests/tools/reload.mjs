// Reloads the running wallpaper page so edited shaders take effect, then waits until it has rendered.
// usage: node reload.mjs <port> <timeoutSeconds>
const port = process.argv[2];
const timeout = Number(process.argv[3] || 180) * 1000;
const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = targets.find((t) => t.type === 'page' && /index\.html/.test(t.url));
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
ws.send(JSON.stringify({ id: 1, method: 'Page.reload', params: { ignoreCache: true } }));
await new Promise((r) => setTimeout(r, 1500));
ws.close();

const started = Date.now();
while (Date.now() - started < timeout) {
  await new Promise((r) => setTimeout(r, 3000));
  try {
    const now = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
    const p = now.find((t) => t.type === 'page' && /index\.html/.test(t.url));
    const s = new WebSocket(p.webSocketDebuggerUrl);
    await new Promise((r, j) => { s.addEventListener('open', r, { once: true }); s.addEventListener('error', j, { once: true }); });
    const value = await new Promise((resolve) => {
      s.addEventListener('message', (e) => {
        const m = JSON.parse(e.data);
        if (m.id === 1) resolve(m.result?.result?.value);
      });
      s.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { returnByValue: true, expression: `JSON.stringify({ready:!!window.__leReady,gl:window.__le?window.__le.renderer.gl.getError():-1,status:window.__le?window.__le.renderer.status:null})` } }));
    });
    s.close();
    const v = JSON.parse(value);
    if (v.ready) {
      console.log('ready after', Math.round((Date.now() - started) / 1000), 's', value);
      process.exit(0);
    }
  } catch { /* page still loading */ }
}
console.log('NOT READY after', timeout / 1000, 's');
process.exit(1);
