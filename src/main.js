// Synapse — Electron main process.
// 100% local: no network requests are made by this app. It reads Claude Code's files on this
// machine and only ever WRITES marked lines into MEMORY.md files when you link memory (with backups).
const { app, BrowserWindow, ipcMain, shell, dialog, Notification } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const { Worker } = require("node:worker_threads");
const M = require("./core/memory");
const C = require("./core/claude");
const { PRESETS, DEFAULT_CONFIG } = require("./core/presets");
const { createLive } = require("./core/live");
const { demoData, demoLiveTick } = require("./core/demo");
const Doctor = require("./core/doctor");
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
  clean.alerts = cfg.alerts !== false;
  clean.stuckUsd = Math.max(1, Math.min(1000, Number(cfg.stuckUsd) || 10));
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
  if (cached && cached.schema !== require("./core/scan").SCHEMA) cached = null;   // cache from an older version
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
ipcMain.handle("set-settings", (_e, cfg) => { try { const c = writeConfig(cfg); live.setLimits({ stuckUsd: c.stuckUsd }); return { ok: true, config: c }; } catch (e) { return { ok: false, error: e.message }; } });
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

// ---------------------------------------------------------------- memory doctor + suggestions
// The renderer sends indexes from the last scan; paths are resolved here. plan -> preview -> apply -> undo.
const plans = new Map(), undos = new Map(); let planSeq = 0;
const projectRoots = () => (last ? last.areas.filter((a) => !a.team).map((a) => a.path) : []);
function buildFix(spec) {
  if (spec.type === "command") {
    const area = spec.area ? areaByKey(spec.area) : null;
    if (area && area.team) throw new Error("pick a project, not a team folder");
    return { type: "command", project: area, text: String(spec.text || ""), name: spec.name };
  }
  if (spec.type === "rule") {                       // a repeated mistake -> memory note in that project
    const area = areaByKey(spec.area);
    if (area.team) throw new Error("pick a project, not a team folder");
    return { type: "rule", area, name: spec.name, rule: String(spec.rule || ""), description: String(spec.description || ""), why: String(spec.why || ""), tool: String(spec.tool || "") };
  }
  const note = memByIdx(spec.mem), area = note.area ? areaByKey(note.area) : null;
  if (!area || area.team) throw new Error("this note can't be changed from Synapse");
  if (spec.type === "index") return { type: "index", note, area };
  if (spec.type === "link") return { type: "link", note, area, broken: String(spec.broken), replacement: spec.replacement || null };
  if (spec.type === "merge") { const drop = memByIdx(spec.drop); return { type: "merge", keep: note, drop, area, notes: last.memories.filter((m) => m.area === note.area) }; }
  throw new Error("unknown fix");
}
ipcMain.handle("doctor-targets", wrap(({ mem, broken }) => {
  const note = memByIdx(mem), same = last.memories.filter((m) => m.kind === "memory" && m.area === note.area && m !== note);
  return { targets: Doctor.suggestTargets(String(broken), same) };
}));
ipcMain.handle("doctor-plan", wrap((spec) => {
  if (DEMO) throw new Error("demo mode — memory fixes are disabled");
  const p = Doctor.plan(buildFix(spec)), id = ++planSeq; plans.set(id, p);
  const home = require("node:os").homedir();
  return { id, changes: p.changes.map((c) => ({ label: c.label, file: c.file.replace(home, "~"), before: c.before, after: c.after })) };
}));
ipcMain.handle("doctor-apply", wrap(({ id }) => {
  const p = plans.get(id); if (!p) throw new Error("preview expired — open the fix again");
  plans.delete(id);
  const r = Doctor.apply(p, backupDir(), projectRoots()), uid = ++planSeq; undos.set(uid, r.undo);
  runScan().then(() => { if (win) win.webContents.send("scan-updated"); }).catch(() => {});
  return { applied: r.applied, undo: uid };
}));
ipcMain.handle("doctor-undo", wrap(({ undo }) => {
  const u = undos.get(undo); if (!u) throw new Error("nothing to undo");
  undos.delete(undo); const r = Doctor.undo(u, projectRoots());
  runScan().then(() => { if (win) win.webContents.send("scan-updated"); }).catch(() => {});
  return r;
}));

// ---------------------------------------------------------------- live mode
const lastAlert = new Map();          // session -> time, so one session can't spam
function alertFor(e) {
  if (readConfig().alerts === false || !Notification.isSupported()) return;
  if (win && !win.isDestroyed() && win.isFocused()) return;          // the window shows it in-app instead
  const akey = e.session + "|" + e.type;
  if (Date.now() - (lastAlert.get(akey) || 0) < 20000) return;
  lastAlert.set(akey, Date.now());
  const a = last && last.areas.find((x) => x.key === e.cwd), project = a ? a.name : "Claude";
  const file = (p) => String(p || "").split("/").slice(-2).join("/");
  const STUCK = { "edit-loop": (d) => `${file(d.p)} edited ${d.times} times in ${d.minutes} min — it may be going in circles.`,
    "same-error": (d) => `The same ${d.tool || "tool"} error ${d.times} times: ${String(d.sig || "").slice(0, 90)}`,
    "many-errors": (d) => `${d.times} tool errors in the last few minutes.`,
    "cost-burn": (d) => `Cost rose $${d.usd.toFixed(2)} in ${d.minutes} min.` };
  const n = e.type === "turn-end" ? new Notification({ title: `✓ ${project}: your turn`, body: e.text ? e.text.slice(0, 140) : "Claude finished and is waiting for your reply." })
    : e.type === "conflict" ? new Notification({ title: `⚠ Two sessions are editing ${file(e.p)}`, body: `Another session${e.otherCwd && e.otherCwd !== e.cwd ? " (another project)" : ""} edited it ${Math.max(1, Math.round(e.ago / 60e3))} min ago. Their changes can overwrite each other.` })
    : e.type === "stuck" ? new Notification({ title: `🌀 ${project}: the session may be stuck`, body: (STUCK[e.reason] || (() => "Something looks off."))(e.detail || {}) })
    : new Notification({ title: `⏳ ${project} may be waiting for you`, body: `${e.tool || "A tool"} has been waiting for ${Math.round((Date.now() - e.since) / 1000)}s — a permission prompt, or a long command.` });
  n.on("click", () => { if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); win.webContents.send("focus-session", e.session); } });
  n.show();
}
const live = createLive((events) => {
  if (win && !win.isDestroyed()) win.webContents.send("live", events);
  for (const e of events) if (/^(turn-end|tool-waiting|conflict|stuck)$/.test(e.type)) alertFor(e);
}, (m) => console.warn(m), { stuckUsd: readConfig().stuckUsd || 10 });
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
