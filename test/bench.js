// Benchmarks: per view -> transition, steady, zoom-in (wheel), zoomed pan
const { app, BrowserWindow } = require("electron");
if (process.env.DSF) app.commandLine.appendSwitch("force-device-scale-factor", process.env.DSF);
require("../src/main.js");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const VIEWS = (process.env.BENCH_VIEWS || "1,2,3,4,5,6").split(",");
app.whenReady().then(async () => {
  await wait(5000);
  const w = BrowserWindow.getAllWindows()[0];
  w.webContents.on('render-process-gone', (e, d) => console.log('RENDERER GONE:', JSON.stringify(d)));
  w.webContents.on('did-start-navigation', (e) => console.log('NAVIGATION/RELOAD', e.url || ''));
  w.webContents.on('unresponsive', () => console.log('UNRESPONSIVE'));
  w.webContents.on('console-message', (e) => { const m = String(e.message || ''); if (/error/i.test(m)) console.log('CONSOLE', m.slice(0, 200)); });
  const measure = (ms, action) => w.webContents.executeJavaScript(`new Promise(res => { const ts=[]; const t0=performance.now(); let k=0;
    const f = t => { ts.push(t); ${action}; if (t - t0 < ${ms}) requestAnimationFrame(f); else {
      const d = ts.slice(1).map((t,i)=>t-ts[i]); const avg = 1000/(d.reduce((x,y)=>x+y,0)/d.length);
      res(avg.toFixed(0) + ' fps (worst ' + Math.max(...d).toFixed(0) + 'ms)'); } };
    requestAnimationFrame(f); })`);
  for (const i of VIEWS) {
    await w.webContents.executeJavaScript(`dispatchEvent(new KeyboardEvent('keydown',{key:'${i}'}))`);
    const tr = await measure(1500, "");
    const st = await measure(1500, "");
    // zoom in towards a point right of centre: one wheel notch every 6 frames
    const zm = await measure(2500, "if (++k % 6 === 0) document.getElementById('c').dispatchEvent(new WheelEvent('wheel',{deltaY:-120, clientX: innerWidth*0.6, clientY: innerHeight*0.55, bubbles:true, cancelable:true}))");
    await wait(800);
    const zs = await measure(1500, "");
    console.log(["","rings","circle","areas","links","timeline","orbit","memory"][i].padEnd(9), "| switch", tr, "| idle", st, "| zooming", zm, "| zoomed idle", zs);
  }
  app.quit();
});
