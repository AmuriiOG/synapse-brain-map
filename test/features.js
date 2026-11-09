// Smoke test for the UI features in demo mode: insights, settings, replay, live events, export menu.
// Prints renderer errors.   npm run test:ui
process.env.SYNAPSE_DEMO = "1";
const { app, BrowserWindow } = require("electron");
const fs = require("fs"), path = require("path");
require("../src/main.js");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const shots = process.env.SHOTS;
app.whenReady().then(async () => {
  await wait(600);
  const w = BrowserWindow.getAllWindows()[0], js = (c) => w.webContents.executeJavaScript(c);
  const errors = [];
  w.webContents.on("console-message", (e) => { const m = String(e.message || ""); if (e.level === "error" || /Error/.test(m)) errors.push(m.slice(0, 300)); });
  const shot = async (n) => { if (!shots) return; for (let i = 0; i < 5; i++) { try { fs.writeFileSync(path.join(shots, n + ".png"), (await w.webContents.capturePage()).toPNG()); return; } catch { await wait(300); } } };
  for (let i = 0; i < 60; i++) { await wait(500); if (await js("!!window.__synapse").catch(() => false)) break; }
  await js(`window.addEventListener('error', e => console.error('Error: ' + e.message + ' @' + e.lineno)); window.addEventListener('unhandledrejection', e => console.error('Error: ' + e.reason))`);
  await wait(3000);
  console.log("stats:", await js(`document.getElementById('stats').innerText`));
  console.log("live button on:", await js(`document.getElementById('bLive').classList.contains('on')`));
  await js(`__synapse.showInsights('cost')`); await wait(600); await shot("f1-cost");
  console.log("cost drawer:", (await js(`document.getElementById('dbody').innerText`)).split("\n").slice(0, 6).join(" | "));
  await js(`__synapse.showInsights('health')`); await wait(500); await shot("f2-health");
  console.log("health drawer:", (await js(`document.getElementById('dbody').innerText`)).split("\n").slice(0, 5).join(" | "));
  await js(`__synapse.showSettings()`); await wait(800); await shot("f3-settings");
  console.log("settings has MCP command:", await js(`/claude mcp add synapse/.test(document.getElementById('sMcp').textContent)`));
  await js(`document.getElementById('dx').click()`);
  // replay the session with the most events
  await js(`(() => { const s = __synapse.sessNodes.slice().sort((a, b) => b.d.events.length - a.d.events.length)[0]; __synapse.openPanel(s); __synapse.startReplay(s); })()`);
  await wait(1500); await shot("f4-replay");
  console.log("replay running:", await js(`document.getElementById('replay').classList.contains('open')`), "| beams:", await js(`__synapse.beams`), "|", await js(`document.getElementById('rpTime').textContent`));
  await js(`document.getElementById('rpStop').click(); document.getElementById('px').click()`);
  // simulate live events: an edit + a read + a prompt in api-server
  await js(`(() => { const a = __synapse.areas.find(x => x.name === 'api-server'); const f = window.__synapse.memNodes[0];
    __synapse.onLiveEvents([{ type: 'prompt', session: 'zzzz', cwd: a.key, t: Date.now(), text: 'make the carts bounce more' },
      { type: 'touch', session: 'zzzz', cwd: a.key, t: Date.now(), p: a.key + '/assets/_project/scripts/cart.cs', k: 'edit', tool: 'Edit' },
      { type: 'touch', session: 'zzzz', cwd: a.key, t: Date.now(), p: f.d.p, k: 'read', tool: 'Read' }]); })()`);
  await wait(500); await shot("f5-live");
  console.log("ticker lines:", await js(`[...document.querySelectorAll('#ticker .tk')].map(x => x.innerText).join(' || ')`));
  await js(`document.getElementById('bExport').click()`); await wait(300);
  console.log("export dialog buttons:", await js(`[...document.querySelectorAll('#modal button')].filter(b => b.style.display !== 'none').map(b => b.textContent).join(' / ')`));
  await js(`document.getElementById('mNo').click()`);
  console.log("renderer errors:", errors.length ? errors : "none");
  app.quit();
});
