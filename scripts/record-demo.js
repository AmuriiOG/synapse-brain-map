// Records docs/demo.gif from demo mode (fictional data — never your real projects).
//   npx electron scripts/record-demo.js
process.env.SYNAPSE_DEMO = "1";
process.env.SHOTS = "1";                      // keep painting even if the window is covered
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs"), path = require("node:path");
const { GIFEncoder, quantize, applyPalette } = require("gifenc");
require("../src/main.js");

const OUT = path.join(__dirname, "..", "docs");
const W = Number(process.env.GIF_WIDTH || 860), FPS = 9;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const win = BrowserWindow.getAllWindows()[0];
  win.setSize(1440, 860); win.center();
  const js = (c) => win.webContents.executeJavaScript(c);
  for (let i = 0; i < 60; i++) { await wait(300); if (await js("!!window.__synapse").catch(() => false)) break; }
  await js(`localStorage.setItem('synapseLive','1')`);
  await wait(4200);                                   // let the intro burst settle

  const frames = [];
  let recording = true;
  const grab = (async () => {
    while (recording) {
      const t0 = Date.now();
      const img = (await win.webContents.capturePage()).resize({ width: W, quality: "good" });
      frames.push({ w: img.getSize().width, h: img.getSize().height, bgra: img.toBitmap() });
      await wait(Math.max(0, 1000 / FPS - (Date.now() - t0)));
    }
  })();

  // the show: live activity on Rings -> Memory view -> a new link draws itself -> Circle
  await wait(2600);
  await js(`dispatchEvent(new KeyboardEvent('keydown',{key:'7'}))`); await wait(2200);
  await js(`(() => { const A = __synapse.areas, h = __synapse.hubs[A.find(a => a.name === 'space-shooter').i]; __synapse.openPanel(h);
    document.getElementById('selFrom').value = String(A.find(a => a.name === 'design-system').i); document.getElementById('bLink').click(); })()`);
  await wait(700); await js(`document.getElementById('mYes').click()`); await wait(2300);
  await js(`document.getElementById('px').click(); dispatchEvent(new KeyboardEvent('keydown',{key:'2'}))`); await wait(2600);
  recording = false; await grab;

  // encode: BGRA -> RGBA, one palette per frame
  const gif = GIFEncoder();
  for (const f of frames) {
    const rgba = new Uint8Array(f.bgra.length);
    for (let i = 0; i < rgba.length; i += 4) { rgba[i] = f.bgra[i + 2]; rgba[i + 1] = f.bgra[i + 1]; rgba[i + 2] = f.bgra[i]; rgba[i + 3] = 255; }
    const palette = quantize(rgba, 256);
    gif.writeFrame(applyPalette(rgba, palette), f.w, f.h, { palette, delay: Math.round(1000 / FPS) });
  }
  gif.finish();
  fs.writeFileSync(path.join(OUT, "demo.gif"), gif.bytes());
  // a few still screenshots for the README
  for (const [k, name] of [["1", "rings"], ["7", "memory"], ["5", "timeline"]]) {
    await js(`dispatchEvent(new KeyboardEvent('keydown',{key:'${k}'}))`); await wait(2600);
    fs.writeFileSync(path.join(OUT, name + ".png"), (await win.webContents.capturePage()).toPNG());
  }
  await js(`dispatchEvent(new KeyboardEvent('keydown',{key:'1'}))`); await wait(2600);
  await js(`__synapse.showInsights('cost')`); await wait(800);
  fs.writeFileSync(path.join(OUT, "insights.png"), (await win.webContents.capturePage()).toPNG());
  await js(`__synapse.showInsights('suggest')`); await wait(800);
  fs.writeFileSync(path.join(OUT, "suggestions.png"), (await win.webContents.capturePage()).toPNG());
  await js(`__synapse.showInsights('health')`); await wait(800);
  fs.writeFileSync(path.join(OUT, "health.png"), (await win.webContents.capturePage()).toPNG());
  console.log(`docs/demo.gif: ${frames.length} frames, ${(fs.statSync(path.join(OUT, "demo.gif")).size / 1e6).toFixed(1)} MB`);
  app.quit();
});
