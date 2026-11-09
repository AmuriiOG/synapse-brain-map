// Synapse — Electron main process.
// 100% local: no network requests are made by this app. It reads Claude Code's files on this
// machine and only ever WRITES marked lines into MEMORY.md files when you link memory (with backups).
const { app, BrowserWindow, ipcMain, shell, dialog } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const { Worker } = require("node:worker_threads");
const M = require("./core/memory");
const C = require("./core/claude");
const { PRESETS, DEFAULT_CONFIG } = require("./core/presets");
const { createLive } = require("./core/live");
const { demoData, demoLiveTick } = require("./core/demo");
// demo mode: fictional data, nothing read from or written to disk (npm run demo)
const DEMO = !!process.env.SYNAPSE_DEMO || process.argv.includes("--demo");

// one settings/cache folder no matter how the app is launched (installed, npm start, tests)
app.setName("Synapse");
// tests that point at a temp copy of Claude's data get their own settings/cache folder
app.setPath("userData", path.join(app.getPath("appData"), DEMO ? "Synapse-demo" : process.env.SYNAPSE_CLAUDE_PROJECTS ? "Synapse-test" : "Synapse"));

let win = null, last = null, scanning = null, fresh = null;
const userFile = (n) => path.join(app.getPath("userData"), n);
const configPath = () => userFile("config.json");
const cachePath = () => userFile("cache.json");
const backupDir = () => userFile("memory-backups");
// files that must exist on disk (not inside app.asar) for worker threads / the MCP server
const unpacked = (p) => p.replace(/app\.asar([\\/])/, "app.asar.unpacked$1");

// ---------------------------------------------------------------- config
function readConfig() {
  try { return { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(configPath(), "utf8")) }; } catch { return { ...DEFAULT_CONFIG }; }
}
function writeConfig(cfg) {
  const clean = { ...DEFAULT_CONFIG };
  clean.days = Math.max(1, Math.min(365, Number(cfg.days) || 60));
  clean.presets = (cfg.presets || []).filter((p) => PRESETS[p]);
  clean.skipDirs = (cfg.skipDirs || []).map(String).map((s) => s.trim()).filter(Boolean).slice(0, 200);
  clean.extraRoots = (cfg.extraRoots || []).map(String).filter((p) => fs.existsSync(p));
  clean.skipRoots = (cfg.skipRoots || []).map(String);
  clean.teamFolders = (cfg.teamFolders || []).filter((t) => t && t.path && fs.existsSync(t.path)).map((t) => ({ name: String(t.name || path.basename(t.path)), path: String(t.path) }));
  clean.maxFilesPerProject = Math.max(200, Math.min(20000, Number(cfg.maxFilesPerProject) || 4000));
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(clean, null, 2));
  return clean;
}
const teamRoots = () => (readConfig().teamFolders || []).map((t) => t.path);

// ---------------------------------------------------------------- scanning (worker thread + cache)
function runScan() {
  if (scanning) return scanning;
  scanning = new Promise((resolve, reject) => {
    if (!fs.existsSync(configPath())) writeConfig(DEFAULT_CONFIG);
    const w = new Worker(unpacked(path.join(__dirname, "core", "scan-worker.js")), { workerData: { configPath: configPath() } });
    w.on("message", (m) => {
      if (m.progress) { if (win) win.webContents.send("scan-progress", m.progress); return; }
      if (m.error) return reject(new Error(m.error));
      fresh = m.data;
      try { fs.writeFileSync(cachePath(), JSON.stringify(fresh)); } catch {}
      resolve(fresh);
    });
    w.on("error", reject);
    w.on("exit", (code) => { if (code !== 0) reject(new Error("scan worker exited with " + code)); });
  }).finally(() => { scanning = null; });
  return scanning;
}
const signature = (d) => d ? JSON.stringify([d.areas.length, d.files.length, d.sessions.length, d.commits.length, d.memories.length, d.shares.length,
  d.sessions.map((s) => s.end).join(), d.memories.map((m) => m.t).join()]) : "";

// first call: answer from the cache instantly (if any), refresh in the background
ipcMain.handle("scan", async () => {
  if (DEMO) { last = last || demoData(); return last; }
  let cached = null;
  if (fresh) cached = fresh;
  else try { cached = JSON.parse(fs.readFileSync(cachePath(), "utf8")); } catch {}
  if (cached && cached.areas) {
    last = cached;
    if (Date.now() - (cached.generated || 0) > 60 * 1000) {
      runScan().then((d) => { if (win && signature(d) !== signature(last)) win.webContents.send("scan-updated"); }).catch(() => {});
    }
    return cached;
  }
  last = await runScan();
  return last;
});
ipcMain.handle("rescan", async () => { if (DEMO) return { ok: true }; last = await runScan(); return { ok: true }; });

// ---------------------------------------------------------------- settings
ipcMain.handle("get-settings", () => {
  const exe = process.execPath, mcpScript = unpacked(path.join(__dirname, "mcp.js"));
  const mcp = app.isPackaged
    ? `claude mcp add synapse --scope user --env ELECTRON_RUN_AS_NODE=1 --env SYNAPSE_CONFIG="${configPath()}" -- "${exe}" "${mcpScript}"`
    : `claude mcp add synapse --scope user --env SYNAPSE_CONFIG="${configPath()}" -- node "${mcpScript}"`;
  return { config: readConfig(), presets: Object.fromEntries(Object.entries(PRESETS).map(([k, v]) => [k, { label: v.label, dirs: v.dirs }])),
    paths: { claudeHome: C.CLAUDE_HOME, userData: app.getPath("userData"), backups: backupDir() }, mcp, version: app.getVersion() };
});
ipcMain.handle("set-settings", (_e, cfg) => { try { return { ok: true, config: writeConfig(cfg) }; } catch (e) { return { ok: false, error: e.message }; } });
ipcMain.handle("pick-folder", async (_e, title) => {
  const r = await dialog.showOpenDialog(win, { title: title || "Choose a folder", properties: ["openDirectory", "createDirectory"] });
  return r.canceled ? null : r.filePaths[0];
});
// a team memory folder needs a MEMORY.md index; create one (only if missing) when the user adds the folder
ipcMain.handle("init-team-folder", (_e, dir) => {
  try {
    if (!dir || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error("folder not found");
    const idx = path.join(dir, "MEMORY.md");
    if (!fs.existsSync(idx)) fs.writeFileSync(idx, "# Team memory\n\nShared notes for every project linked to this folder. One fact per file; list each note here as\n- [title](note-file.md) — one line on when it matters\n");
    return { ok: true, created: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle("open-path", (_e, p) => shell.showItemInFolder(p));
ipcMain.handle("open-backups", () => { fs.mkdirSync(backupDir(), { recursive: true }); return shell.openPath(backupDir()); });
ipcMain.handle("open-url", (_e, url) => { if (/^https:\/\/(github\.com|docs\.anthropic\.com|code\.claude\.com)\//.test(url)) shell.openExternal(url); });
// save an exported PNG / video picked by the user
ipcMain.handle("save-file", async (_e, { name, data, filters }) => {
  const r = await dialog.showSaveDialog(win, { defaultPath: path.join(app.getPath("pictures"), name), filters });
  if (r.canceled || !r.filePath) return { ok: false };
  fs.writeFileSync(r.filePath, Buffer.from(data));
  return { ok: true, path: r.filePath };
});

// ---------------------------------------------------------------- memory actions
// The renderer only sends project keys / note indexes from the last scan; real paths are looked up here.
const areaByKey = (k) => { const a = last && last.areas.find((x) => x.key === k); if (!a) throw new Error("unknown project"); return a; };
const memByIdx = (i) => { const m = last && last.memories[i]; if (!m) throw new Error("unknown note"); return m; };
// cheap refresh after a link/share/unlink: re-read only the MEMORY.md files (milliseconds)
function memState() {
  if (DEMO) return { shares: last.shares, hasMemory: Object.fromEntries(last.areas.map((a) => [a.key, a.hasMemory])) };
  const shares = [], hasMemory = {};
  const indexToArea = new Map(last.areas.map((a) => [M.norm(a.memIndex), a.key]));
  const memIdx = new Map(last.memories.map((m, i) => [m.p, i]));
  for (const a of last.areas) {
    a.hasMemory = hasMemory[a.key] = fs.existsSync(a.memIndex);
    if (a.team) continue;
    for (const mk of M.parseMarks(a.memIndex)) {
      const sh = { to: a.key, kind: mk.kind, target: mk.target };
      sh.from = indexToArea.get(sh.target) || null; sh.mem = memIdx.has(sh.target) ? memIdx.get(sh.target) : null;
      shares.push(sh);
    }
  }
  last.shares = shares;
  return { shares, hasMemory };
}
const withState = (r) => ({ ...r, state: memState() });
const wrap = (fn) => async (_e, arg) => { try { return { ok: true, ...(await fn(arg || {})) }; } catch (err) { return { ok: false, error: err.message }; } };

ipcMain.handle("mem-open", wrap(({ mem }) => { const m = memByIdx(mem); if (!/\.md$/i.test(m.path)) throw new Error("not a note"); shell.openPath(m.path); return {}; }));
ipcMain.handle("mem-open-index", wrap(({ area }) => { const a = areaByKey(area); if (!fs.existsSync(a.memIndex)) throw new Error("no MEMORY.md yet"); shell.openPath(a.memIndex); return {}; }));
ipcMain.handle("mem-link", wrap(({ from, to, both }) => {
  const A = areaByKey(from), B = areaByKey(to);
  if (DEMO) { const add = (x, y) => { if (!last.shares.some((s) => s.kind === "link" && s.from === x.key && s.to === y.key)) last.shares.push({ to: y.key, kind: "link", target: M.norm(x.memIndex), from: x.key, mem: null }); };
    add(A, B); if (both) add(B, A); return withState({ results: [{ ok: true }] }); }
  if (A.key === B.key) throw new Error("pick two different projects");
  if (B.team) throw new Error("team folders are read-only sources — link them INTO a project");
  const r = [M.linkProjects(A, B.path, backupDir(), teamRoots())];
  if (both) { if (A.team) throw new Error("a team folder can't read a project's memory"); r.push(M.linkProjects(B, A.path, backupDir(), teamRoots())); }
  return withState({ results: r });
}));
ipcMain.handle("mem-share", wrap(({ mem, to }) => {
  const m = memByIdx(mem), B = areaByKey(to);
  if (m.kind !== "memory") throw new Error("only memory notes can be shared");
  if (m.area === B.key) throw new Error("that note already belongs to " + B.name);
  if (B.team) throw new Error("team folders are read-only sources");
  if (DEMO) { last.shares.push({ to: B.key, kind: "share", target: m.p, from: null, mem }); return withState({ results: [{ ok: true }] }); }
  return withState({ results: [M.shareNote(m.path, areaByKey(m.area).name, B.path, backupDir(), teamRoots())] });
}));
ipcMain.handle("mem-unlink", wrap(({ to, share }) => {
  const B = areaByKey(to), sh = last.shares[share];
  if (!sh || sh.to !== B.key) throw new Error("unknown link");
  if (DEMO) { last.shares.splice(share, 1); return withState({ results: [{ ok: true, removed: 1 }] }); }
  return withState({ results: [M.unlink(B.path, sh.target, backupDir())] });
}));

// ---------------------------------------------------------------- live mode
const live = createLive((events) => { if (win && !win.isDestroyed()) win.webContents.send("live", events); }, (m) => console.warn(m));
let demoTimer = null;
ipcMain.handle("live", (_e, on) => {
  if (DEMO) { clearInterval(demoTimer); demoTimer = null; if (on) demoTimer = setInterval(() => { if (win && last) win.webContents.send("live", demoLiveTick(last)); }, 420); return { ok: true }; }
  if (on) return { ok: live.start() }; live.stop(); return { ok: true };
});

// ---------------------------------------------------------------- window
function createWindow() {
  win = new BrowserWindow({
    width: 1500, height: 920, minWidth: 900, minHeight: 600,
    backgroundColor: "#090b10", title: DEMO ? "Synapse — demo" : "Synapse", autoHideMenuBar: true,
    icon: path.join(__dirname, "..", "build", process.platform === "win32" ? "icon.ico" : "icon.png"),
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false, sandbox: true,
      backgroundThrottling: !(process.env.SHOTS || process.env.SYNAPSE_SHOT) },   // tests only: keep painting when covered
  });
  win.loadFile(path.join(__dirname, "renderer", "index.html"));
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (e, url) => { if (!url.startsWith("file://")) e.preventDefault(); });
  win.on("closed", () => { win = null; live.stop(); });
}

app.whenReady().then(createWindow);
app.on("window-all-closed", () => app.quit());

// Test mode: SYNAPSE_SHOT=<dir> captures every view to PNG and quits
if (process.env.SYNAPSE_SHOT) app.whenReady().then(() => {
  const dir = process.env.SYNAPSE_SHOT, wait = (ms) => new Promise((r) => setTimeout(r, ms));
  win.webContents.once("did-finish-load", async () => {
    await wait(5500);
    for (let i = 1; i <= 7; i++) {
      await win.webContents.executeJavaScript(`dispatchEvent(new KeyboardEvent('keydown',{key:'${i}'}))`);
      await wait(3200);
      win.show(); win.focus(); win.moveTop(); await wait(300);
      fs.writeFileSync(path.join(dir, `view${i}.png`), (await win.webContents.capturePage()).toPNG());
    }
    app.quit();
  });
});
