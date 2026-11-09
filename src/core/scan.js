// Scanner: Claude Code sessions + project folders + memory -> one data object for the map.
// Pure function of the disk; reads only. Runs in a worker thread (see scan-worker.js).
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const C = require("./claude");
const M = require("./memory");
const { DEFAULT_CONFIG, SKIP_EXT, skipDirsFor } = require("./presets");

const DAY = 864e5;
const words = (s) => new Set(String(s || "").toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2));
const jaccard = (a, b) => { if (!a.size || !b.size) return 0; let n = 0; for (const x of a) if (b.has(x)) n++; return n / (a.size + b.size - n); };

function loadConfig(configPath) {
  let cfg = { ...DEFAULT_CONFIG };
  try { if (configPath) cfg = { ...cfg, ...JSON.parse(fs.readFileSync(configPath, "utf8")) }; } catch {}
  return cfg;
}

function scan(configPath = null, onProgress = () => {}) {
  const cfg = loadConfig(configPath);
  const DAYS = cfg.days || 60, SINCE = Date.now() - DAYS * DAY;
  const skip = skipDirsFor(cfg), skipExt = new Set(SKIP_EXT);
  const norm = C.norm;

  // ---------- 1. Claude sessions = "runs" ----------
  onProgress("reading Claude sessions");
  const sessions = [], areaRoots = new Map();
  for (const pd of C.listProjectDirs()) {
    for (const f of C.listSessionFiles(pd.dir)) {
      let st; try { st = fs.statSync(f); } catch { continue; }
      if (st.mtimeMs < SINCE) continue;
      const s = C.readSession(f);
      if (!s || C.isTempPath(s.cwd) || !fs.existsSync(s.cwd)) continue;
      areaRoots.set(norm(s.cwd), s.cwd);
      s.cwd = norm(s.cwd); delete s.file;
      sessions.push(s);
    }
  }
  for (const r of cfg.extraRoots || []) if (fs.existsSync(r)) areaRoots.set(norm(r), r);

  // projects that have memory but no recent sessions still belong on the map
  for (const pd of C.listProjectDirs()) {
    if (/scratch-workspaces/i.test(pd.name)) continue;   // the decoded project path is checked below
    let notes = []; try { notes = fs.readdirSync(path.join(pd.dir, "memory")).filter((f) => f.endsWith(".md")); } catch {}
    if (!notes.length) continue;
    if ([...areaRoots.values()].some((p) => C.encode(p).toLowerCase() === pd.name.toLowerCase())) continue;
    const real = C.decodeProjectDir(pd.name);
    if (real && fs.existsSync(real) && !C.isTempPath(real)) areaRoots.set(norm(real), real);
  }
  const areas = [...areaRoots.entries()].map(([key, disp]) => ({ key, name: path.basename(disp), path: disp }))
    .filter((a) => !(cfg.skipRoots || []).includes(a.name));
  // team memory folders (e.g. a shared git repo of notes) appear as their own "project"
  for (const t of cfg.teamFolders || []) {
    if (t && t.path && fs.existsSync(t.path)) areas.push({ key: "team:" + norm(t.path), name: t.name || path.basename(t.path), path: t.path, team: true });
  }

  // ---------- 2. Files by last change ----------
  onProgress("walking project folders");
  const files = [], MAXF = cfg.maxFilesPerProject || 4000;
  const walk = (dir, area, rel, count) => {
    let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (count.n >= MAXF) return;
      if (e.name.startsWith(".") && e.name !== ".claude") continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { if (!skip.has(e.name)) walk(full, area, rel + e.name + "/", count); continue; }
      if (!e.isFile() || skipExt.has(path.extname(e.name))) continue;
      let st; try { st = fs.statSync(full); } catch { continue; }
      if (st.mtimeMs < SINCE) continue;
      count.n++;
      files.push({ area: area.key, rel: rel + e.name, p: norm(full), t: st.mtimeMs, size: st.size, ext: path.extname(e.name).slice(1).toLowerCase() });
    }
  };
  for (const a of areas) if (!a.team) walk(a.path, a, "", { n: 0 });

  // ---------- 3. Git commits ----------
  onProgress("reading git history");
  const commits = [];
  for (const a of areas) {
    try {
      const out = execFileSync("git", ["-C", a.path, "log", `--since=${DAYS}.days`, "--pretty=%H|%ct|%s"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true, timeout: 15000 });
      for (const l of out.split("\n").filter(Boolean)) {
        const [h, ct, ...s] = l.split("|");
        commits.push({ area: a.key, h: h.slice(0, 7), t: Number(ct) * 1000, msg: s.join("|").slice(0, 140) });
      }
    } catch {}
  }

  // ---------- 4. Memory + CLAUDE.md ----------
  onProgress("reading memory");
  const memories = [], shares = [], indexText = {};
  for (const a of areas) {
    const dir = a.team ? a.path : C.memDirFor(a.path);
    a.memDir = dir; a.memIndex = path.join(dir, "MEMORY.md"); a.hasMemory = fs.existsSync(a.memIndex);
    try { indexText[a.key] = fs.readFileSync(a.memIndex, "utf8"); } catch { indexText[a.key] = ""; }
    let notes = []; try { notes = fs.readdirSync(dir).filter((f) => f.endsWith(".md") && !/^(MEMORY|README).md$/i.test(f)); } catch {}
    for (const f of notes) {
      try { const n = C.parseNote(path.join(dir, f)); memories.push({ area: a.key, kind: "memory", file: f, p: norm(path.join(dir, f)), path: path.join(dir, f), ...n }); } catch {}
    }
    if (a.team) continue;
    for (const { rel, path: fp } of C.projectInstructionFiles(a.path)) {
      if (fs.existsSync(fp)) try { const n = C.parseNote(fp); memories.push({ area: a.key, kind: "claudemd", file: rel, p: norm(fp), path: fp, ...n, name: rel, description: "project instructions, loaded into every session here" }); } catch {}
    }
    for (const mk of M.parseMarks(a.memIndex)) shares.push({ to: a.key, kind: mk.kind, target: mk.target });
  }
  const gfile = C.globalInstructionFile();
  if (fs.existsSync(gfile)) try { const n = C.parseNote(gfile); memories.push({ area: null, kind: "claudemd", file: "~/.claude/CLAUDE.md", p: norm(gfile), path: gfile, ...n, name: "~/.claude/CLAUDE.md", description: "your global instructions, loaded into every session everywhere" }); } catch {}
  const indexToArea = new Map(areas.map((a) => [norm(a.memIndex), a.key]));
  const memIdx = new Map(memories.map((m, i) => [m.p, i]));
  for (const sh of shares) { sh.from = indexToArea.get(sh.target) || null; sh.mem = memIdx.has(sh.target) ? memIdx.get(sh.target) : null; }

  // CLAUDE.md files are shown as memory, not as plain files
  const memPaths = new Set(memories.map((m) => m.p));
  for (let i = files.length - 1; i >= 0; i--) if (memPaths.has(files[i].p)) files.splice(i, 1);
  for (const a of areas) a.fileCount = files.filter((f) => f.area === a.key).length;

  // ---------- 5. Links: session -> file / note it read or edited (+ replay events) ----------
  const fileIdx = new Map(files.map((f, i) => [f.p, i]));
  const links = [];
  sessions.forEach((s, si) => {
    s.touched.forEach(({ p, k }) => {
      if (fileIdx.has(p)) links.push({ s: si, f: fileIdx.get(p), k });
      else if (memIdx.has(p)) links.push({ s: si, m: memIdx.get(p), k });
    });
    s.events = s.events.map((e) => fileIdx.has(e.p) ? { t: e.t, f: fileIdx.get(e.p), k: e.k } : memIdx.has(e.p) ? { t: e.t, m: memIdx.get(e.p), k: e.k } : null).filter(Boolean);
    delete s.touched;
  });

  // ---------- 6. Memory health ----------
  onProgress("checking memory health");
  const byName = new Map(); memories.forEach((m, i) => { byName.set(m.name.toLowerCase(), i); byName.set(m.file.replace(/\.md$/, "").toLowerCase(), i); });
  const W = memories.map((m) => ({ n: words(m.name + " " + m.file), d: words(m.description) }));
  memories.forEach((m, i) => {
    const used = links.filter((l) => l.m === i).map((l) => ({ k: l.k, t: sessions[l.s].start }));
    const lastUsed = used.length ? Math.max(...used.map((u) => u.t)) : 0;
    const h = { reads: used.filter((u) => u.k === "read").length, edits: used.filter((u) => u.k === "edit").length, lastUsed, issues: [] };
    if (m.kind === "memory") {
      const idx = indexText[m.area] || "";
      h.inIndex = idx.includes("(" + m.file + ")") || idx.includes(m.file);
      if (!h.inIndex) h.issues.push({ type: "not-indexed", text: "not listed in MEMORY.md — new sessions may never see it" });
      const ageDays = (Date.now() - Math.max(m.t, lastUsed)) / DAY;
      if (ageDays > 30) h.issues.push({ type: "stale", text: `not changed or used in ${Math.round(ageDays)} days` });
      if (!m.description) h.issues.push({ type: "no-description", text: "no description — harder for Claude to decide when to read it" });
    }
    const broken = m.links.filter((n) => !byName.has(n.toLowerCase()));
    if (broken.length) h.issues.push({ type: "broken-link", text: "broken [[links]]: " + broken.join(", ") });
    h.similar = [];
    memories.forEach((o, j) => {
      if (j === i || o.kind !== "memory" || m.kind !== "memory") return;
      const score = Math.max(jaccard(W[i].n, W[j].n), jaccard(W[i].d, W[j].d) * .95);
      if (score >= .5) h.similar.push({ j, score: Math.round(score * 100) / 100 });
    });
    if (h.similar.length) h.issues.push({ type: "duplicate", text: "looks similar to: " + h.similar.map((x) => memories[x.j].name).join(", ") });
    m.health = h;
  });

  return { generated: Date.now(), days: DAYS, config: cfg, areas, sessions, commits, files, links, memories, shares };
}

module.exports = { scan, loadConfig };

if (require.main === module) {
  const t0 = Date.now(), d = scan(process.argv[2] || null);
  console.log(`${Date.now() - t0} ms · areas ${d.areas.length} · files ${d.files.length} · sessions ${d.sessions.length} · commits ${d.commits.length} · links ${d.links.length} · memories ${d.memories.length} · shares ${d.shares.length}`);
  const cost = d.sessions.reduce((x, s) => x + (s.cost ? s.cost.usd : 0), 0);
  console.log(`cost $${cost.toFixed(2)} · replay events ${d.sessions.reduce((x, s) => x + s.events.length, 0)} · memory issues ${d.memories.reduce((x, m) => x + m.health.issues.length, 0)}`);
  const kinds = {}; d.memories.forEach((m) => m.health.issues.forEach((i) => kinds[i.type] = (kinds[i.type] || 0) + 1)); console.log(kinds);
}
