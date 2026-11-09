// Demo data: fictional projects, sessions, files and memory, shaped exactly like scan() output.
// Used for screenshots/GIFs and for trying Synapse without Claude Code (`npm run demo`).
// Deterministic: the same seed always gives the same map.
const DAY = 864e5, HOUR = 36e5;

function demoData(now = Date.now()) {
  let seed = 42; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const root = process.platform === "win32" ? "C:/dev/" : "/home/dev/";
  const P = [
    { name: "space-shooter", dirs: ["Assets/Scripts/Player", "Assets/Scripts/Enemies", "Assets/Shaders", "Assets/Art/Sprites", "Assets/Audio"], ext: ["cs", "cs", "cs", "shader", "png", "wav", "prefab"], heat: 1.6 },
    { name: "api-server", dirs: ["src/routes", "src/db", "src/auth", "tests", "migrations"], ext: ["ts", "ts", "ts", "sql", "json"], heat: 1.3 },
    { name: "web-dashboard", dirs: ["src/components", "src/pages", "src/hooks", "public", "styles"], ext: ["tsx", "tsx", "ts", "css", "svg", "json"], heat: 1.1 },
    { name: "mobile-app", dirs: ["lib/screens", "lib/widgets", "lib/state", "assets", "android/app"], ext: ["dart", "dart", "dart", "png", "xml", "json"], heat: .9 },
    { name: "ml-pipeline", dirs: ["pipeline", "notebooks", "data/schemas", "models"], ext: ["py", "py", "ipynb", "yaml", "csv"], heat: .7 },
    { name: "design-system", dirs: ["tokens", "components", "docs"], ext: ["ts", "css", "md", "json"], heat: .5 },
    { name: "infra", dirs: ["terraform", "k8s", "scripts", ".github/workflows"], ext: ["tf", "yaml", "sh", "yml"], heat: .4 },
  ];
  const words = ["player", "enemy", "spawn", "auth", "session", "cache", "router", "theme", "button", "modal", "chart", "graph", "token", "user", "order", "payment", "queue", "worker", "config", "schema", "loader", "renderer", "audio", "input", "camera", "physics", "health", "score", "level", "menu", "build", "deploy"];
  const cap = (s) => s[0].toUpperCase() + s.slice(1);
  const norm = (p) => p.replace(/\\/g, "/").toLowerCase();

  const areas = [], files = [], sessions = [], commits = [], links = [], memories = [], shares = [];
  P.forEach((p) => {
    const key = norm(root + p.name);
    areas.push({ key, name: p.name, path: root + p.name, memDir: "(demo)", memIndex: "(demo)/" + p.name + "/MEMORY.md", hasMemory: true });
    const n = Math.round(90 + 260 * p.heat * rnd());
    for (let i = 0; i < n; i++) {
      const dir = pick(p.dirs), ext = pick(p.ext), base = pick(words) + (rnd() < .5 ? cap(pick(words)) : "");
      const name = ext === "cs" || ext === "tsx" || ext === "dart" ? cap(base) : base;
      const rel = dir + "/" + name + "." + ext;
      if (files.some((f) => f.area === key && f.rel === rel)) continue;
      files.push({ area: key, rel, p: key + "/" + norm(rel), t: now - Math.pow(rnd(), 1.8 / p.heat) * 58 * DAY, size: Math.round(400 + rnd() * 30000), ext });
    }
  });
  areas.forEach((a) => a.fileCount = files.filter((f) => f.area === a.key).length);

  // memory notes per project (realistic kinds of things Claude remembers)
  const NOTES = {
    "space-shooter": [["player-physics-locked", "player movement constants are tuned by design — never change speed/gravity", "feedback"], ["enemy-wave-format", "waves are JSON in Assets/Data; spawn times are in beats, not seconds", "project"], ["shader-mobile-budget", "mobile shaders: max 2 texture samples, no discard; see [[perf-targets]]", "project"], ["perf-targets", "60 fps on a mid-range phone; profile before optimizing", "project"], ["audio-ducking", "music ducks 6 dB under SFX via the AudioMixer snapshot", "reference"]],
    "api-server": [["auth-tokens", "JWT with 15 min access + rotating refresh tokens in httpOnly cookies", "project"], ["db-migrations", "never edit an applied migration; add a new one. See [[testing-setup]]", "feedback"], ["testing-setup", "tests use a throwaway Postgres in Docker; run npm test:db first", "reference"], ["rate-limits", "100 req/min per user; webhooks are exempt", "project"], ["user-profile", "prefers small PRs and asks for a plan before big changes", "user"]],
    "web-dashboard": [["design-tokens", "colors and spacing come from design-system tokens only, never hex in components", "feedback"], ["api-client", "all fetches go through useApi(); it handles auth refresh", "project"], ["chart-library", "charts use the in-house <Chart> wrapper; no new chart deps", "feedback"], ["auth-flow-ui", "login redirects keep ?next= — see [[auth-tokens]]", "project"]],
    "mobile-app": [["state-management", "Riverpod providers live next to their screen; no global singletons", "project"], ["release-checklist", "bump build number, run golden tests, update store notes", "reference"], ["offline-mode", "orders queue locally and sync on reconnect", "project"]],
    "ml-pipeline": [["data-contracts", "schemas in data/schemas are the contract with the API team", "project"], ["gpu-budget", "training jobs must fit on one 24 GB GPU", "project"], ["old-experiment-notes", "baseline from the spring experiment, kept for reference", "reference"]],
    "design-system": [["token-naming", "tokens are semantic (color.bg.danger), never literal (red-500)", "feedback"], ["a11y-contrast", "every text token pair must pass WCAG AA", "project"]],
    "infra": [["deploy-flow", "main deploys to staging automatically; prod needs a tagged release", "project"], ["secrets", "secrets live in the cloud secret manager, never in tfvars", "feedback"]],
  };
  areas.forEach((a) => {
    (NOTES[a.name] || []).forEach(([name, description, type], j) => {
      const linksTo = [...description.matchAll(/\[\[([^\]]+)\]\]/g)].map((m) => m[1]);
      memories.push({ area: a.key, kind: "memory", file: name + ".md", p: a.key + "/memory/" + name + ".md", path: "(demo)", name, description, type,
        body: description + "\n\nWhy: learned the hard way during a past session.\nHow to apply: check this before touching related code.", links: linksTo, t: now - (5 + j * 9 + rnd() * 20) * DAY, size: 600 });
    });
    if (rnd() < .7) memories.push({ area: a.key, kind: "claudemd", file: "CLAUDE.md", p: a.key + "/claude.md", path: "(demo)", name: "CLAUDE.md", description: "project instructions, loaded into every session here", type: "", body: "# " + a.name + "\nRun the tests before committing. Keep functions small.", links: [], t: now - 30 * DAY, size: 300 });
  });
  memories.push({ area: null, kind: "claudemd", file: "~/.claude/CLAUDE.md", p: "~/.claude/claude.md", path: "(demo)", name: "~/.claude/CLAUDE.md", description: "your global instructions, loaded into every session everywhere", type: "", body: "Be concise. Ask before large refactors.", links: [], t: now - 40 * DAY, size: 200 });

  // sessions with cost, prompts and the files they touched
  const titles = ["Add enemy wave editor", "Fix jitter in player camera", "Refactor auth middleware", "Add rate limiting", "Dark mode for dashboard", "Chart tooltips", "Offline order queue", "Golden tests for checkout", "Speed up feature pipeline", "Migrate tokens to v2", "Terraform staging env", "Boss fight phase 2", "Webhook retries", "Profile page redesign", "Push notifications", "Shader LOD for mobile", "Fix flaky DB tests", "Data contract v3", "CI cache for builds", "Settings screen"];
  areas.forEach((a, ai) => {
    const heat = P[ai].heat, ns = Math.round(2 + heat * 4);
    for (let i = 0; i < ns; i++) {
      const start = now - Math.pow(rnd(), 1.4) * 55 * DAY, dur = (20 + rnd() * 220) * 60000;
      const af = files.filter((f) => f.area === a.key);
      const touched = new Map();
      const k = Math.round(6 + rnd() * 26 * heat);
      for (let j = 0; j < k && af.length; j++) touched.set(af[Math.floor(rnd() * af.length)], rnd() < .55 ? "edit" : "read");
      const si = sessions.length, events = [];
      [...touched].forEach(([f, kind], j) => { links.push({ s: si, f: files.indexOf(f), k: kind }); events.push({ t: start + dur * (j + 1) / (touched.size + 1), f: files.indexOf(f), k: kind }); });
      const am = memories.filter((m) => m.area === a.key);
      if (am.length && rnd() < .8) { const m = am[Math.floor(rnd() * am.length)], mi = memories.indexOf(m), kind = rnd() < .3 ? "edit" : "read"; links.push({ s: si, m: mi, k: kind }); events.splice(1, 0, { t: start + dur * .1, m: mi, k: kind }); }
      const usd = Math.round((1 + rnd() * 18 * heat) * 100) / 100;
      sessions.push({ id: (1e7 + Math.floor(rnd() * 9e7)).toString(16).slice(0, 8), cwd: a.key, start, end: start + dur, prompts: Math.round(3 + rnd() * 40), title: pick(titles),
        model: "claude-opus-5-5", tokens: { input: 9000, output: Math.round(usd * 9000), cacheRead: Math.round(usd * 900000), cacheWrite: Math.round(usd * 40000) },
        cost: { usd, linesAdded: Math.round(usd * 60), linesRemoved: Math.round(usd * 14), apiMs: dur / 3, unknownModel: false }, events });
    }
    const nc = Math.round(8 + heat * 30);
    for (let i = 0; i < nc; i++) commits.push({ area: a.key, h: Math.floor(rnd() * 0xfffffff).toString(16).padStart(7, "0"), t: now - Math.pow(rnd(), 1.3) * 58 * DAY, msg: pick(["fix", "add", "refactor", "tune", "update"]) + " " + pick(words) + " " + pick(words) });
  });

  // a team memory folder + a few memory links between projects
  const team = { key: "team:" + norm(root + "team-brain"), name: "team-brain", path: root + "team-brain", memDir: "(demo)", memIndex: "(demo)/team/MEMORY.md", hasMemory: true, team: true, fileCount: 0 };
  areas.push(team);
  [["code-review-rules", "two approvals for anything touching auth or payments"], ["release-train", "we ship every Tuesday; freeze on Monday 18:00"], ["on-call", "who to page and how to roll back"]].forEach(([name, description], j) =>
    memories.push({ area: team.key, kind: "memory", file: name + ".md", p: team.key + "/" + name + ".md", path: "(demo)", name, description, type: "project", body: description, links: [], t: now - (3 + j * 6) * DAY, size: 400 }));
  const A = (n) => areas.find((a) => a.name === n);
  const link = (from, to) => shares.push({ to: A(to).key, kind: "link", target: norm(A(from).memIndex), from: A(from).key, mem: null });
  link("api-server", "web-dashboard"); link("design-system", "web-dashboard"); link("team-brain", "api-server"); link("team-brain", "mobile-app");
  const authNote = memories.findIndex((m) => m.name === "auth-tokens");
  shares.push({ to: A("mobile-app").key, kind: "share", target: memories[authNote].p, from: null, mem: authNote });

  // health, computed the same way the real scanner does (simplified)
  memories.forEach((m, i) => {
    const used = links.filter((l) => l.m === i);
    const lastUsed = used.length ? Math.max(...used.map((l) => sessions[l.s].start)) : 0;
    const issues = [];
    if (m.kind === "memory" && (now - Math.max(m.t, lastUsed)) / DAY > 30) issues.push({ type: "stale", text: `not changed or used in ${Math.round((now - Math.max(m.t, lastUsed)) / DAY)} days` });
    if (m.name === "old-experiment-notes") issues.push({ type: "not-indexed", text: "not listed in MEMORY.md — new sessions may never see it" });
    if (m.name === "auth-flow-ui") issues.push({ type: "broken-link", text: "broken [[links]]: auth-tokens (lives in api-server — link the projects)" });
    m.health = { reads: used.filter((l) => l.k === "read").length, edits: used.filter((l) => l.k === "edit").length, lastUsed, issues, similar: [] };
  });

  return { generated: now, days: 60, demo: true, config: {}, areas, sessions, commits, files, links, memories, shares };
}

// a fake stream of live events for the demo: prompts, reads and edits in random projects
function demoLiveTick(data, rnd = Math.random) {
  const s = data.sessions[Math.floor(rnd() * data.sessions.length)];
  const fs = data.files.filter((f) => f.area === s.cwd);
  if (!fs.length) return [];
  const evs = [];
  if (rnd() < .18) evs.push({ type: "prompt", session: s.id, cwd: s.cwd, t: Date.now(), text: ["make the boss attack faster", "add tests for the webhook retry", "why is the chart flickering?", "add a dark mode toggle", "speed up the import job"][Math.floor(rnd() * 5)] });
  const f = fs[Math.floor(rnd() * fs.length)];
  evs.push({ type: "touch", session: s.id, cwd: s.cwd, t: Date.now(), p: f.p, k: rnd() < .5 ? "edit" : "read", tool: "Edit" });
  return evs;
}

module.exports = { demoData, demoLiveTick };
