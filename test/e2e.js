// UI end-to-end test in demo mode (fictional data, nothing on disk changes):
// link + share + undo through the real panel buttons and confirm dialog, timing each action
// and checking that the page never reloads.   npm run test:e2e
process.env.SYNAPSE_DEMO = "1";
process.env.SHOTS = process.env.SHOTS || "";
const { app, BrowserWindow } = require("electron");
require("../src/main.js");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0; const ok = (c, m) => { if (!c) fails++; console.log((c ? "  ✓ " : "  ✗ ") + m); };

app.whenReady().then(async () => {
  const w = BrowserWindow.getAllWindows()[0], js = (c) => w.webContents.executeJavaScript(c);
  let reloads = 0;
  for (let i = 0; i < 60; i++) { await wait(300); if (await js("!!window.__synapse").catch(() => false)) break; }
  w.webContents.on("did-start-navigation", () => reloads++);
  const confirmAndTime = async () => {
    await js(`document.getElementById('toast').textContent = ''`);
    const t0 = Date.now(); await js(`document.getElementById('mYes').click()`);
    let txt = ""; while (Date.now() - t0 < 5000) { txt = await js(`document.getElementById('toast').textContent`); if (txt) break; await wait(5); }
    return { ms: Date.now() - t0, txt };
  };
  const links = () => js(`document.querySelectorAll('[data-unlink]').length`);
  await js(`window.__marker = 42; dispatchEvent(new KeyboardEvent('keydown',{key:'7'}))`); await wait(2500);

  const before = await js(`(() => { __synapse.openPanel(__synapse.hubs[__synapse.areas.find(a => a.name === 'space-shooter').i]); return document.querySelectorAll('[data-unlink]').length; })()`);
  await js(`(() => { const A = __synapse.areas; document.getElementById('selFrom').value = String(A.find(a => a.name === 'infra').i); document.getElementById('bLink').click(); })()`);
  await wait(300);
  let r = await confirmAndTime();
  ok(/now reads/.test(r.txt) && r.ms < 500, `link infra -> space-shooter in ${r.ms} ms`);
  ok(await links() === before + 1, "panel lists the new link right away");

  await js(`(() => { const n = __synapse.memNodes.find(m => m.d.name === 'perf-targets'); __synapse.openPanel(n);
    document.getElementById('selTo').value = String(__synapse.areas.find(a => a.name === 'ml-pipeline').i); document.getElementById('bShare').click(); })()`);
  await wait(300); r = await confirmAndTime();
  ok(/shared/.test(r.txt) && r.ms < 500, `share a note in ${r.ms} ms`);

  // undo both through the ✕ next to each row (the link "← infra" and the shared note "perf-targets")
  for (const row of ["← infra", "perf-targets"]) {
    await js(`__synapse.openPanel(__synapse.hubs[__synapse.areas.find(a => a.name === 'space-shooter').i])`); await wait(200);
    await js(`[...document.querySelectorAll('#pbody .lk')].find(x => x.textContent.includes(${JSON.stringify(row)})).querySelector('[data-unlink]').click()`); await wait(300);
    r = await confirmAndTime();
    ok(/removed/.test(r.txt), `undo "${row}" with ✕ in ${r.ms} ms`);
  }
  ok(await links() === before, "link list back to where it started");
  ok(reloads === 0 && await js(`window.__marker === 42`), "no page reloads");
  console.log(fails ? `\n${fails} failed` : "\nall passed");
  app.exit(fails ? 1 : 0);
});
