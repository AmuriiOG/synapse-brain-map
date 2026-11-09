// Portable end-to-end test of the core (scanner, path decoding, memory linking, MCP) on fake
// projects built inside test/out/. Runs on Windows, macOS and Linux — this is what CI runs.
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");

const OUT = path.join(__dirname, "out", "fixture-" + process.pid);
const CLAUDE = path.join(OUT, "claude", "projects"), WORK = path.join(OUT, "work");
process.env.SYNAPSE_CLAUDE_PROJECTS = CLAUDE;
const C = require("../src/core/claude"), M = require("../src/core/memory"), { scan } = require("../src/core/scan");

let pass = 0, fail = 0;
const ok = (c, m) => { (c ? pass++ : fail++); console.log((c ? "  ✓ " : "  ✗ ") + m); };
const sha = (f) => crypto.createHash("sha1").update(fs.readFileSync(f)).digest("hex");

// ---- build two fake projects: "alpha_game" (memory, no recent session) and "beta-api" (a session)
const alpha = path.join(WORK, "alpha_game"), beta = path.join(WORK, "beta-api");
for (const d of [alpha, path.join(alpha, "src"), beta, path.join(beta, "src")]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(alpha, "src", "player.cs"), "class Player {}");
fs.writeFileSync(path.join(beta, "src", "server.ts"), "export {}");
fs.writeFileSync(path.join(beta, "CLAUDE.md"), "# beta\nRun tests first.");
const amem = path.join(CLAUDE, C.encode(alpha), "memory");
fs.mkdirSync(amem, { recursive: true });
fs.writeFileSync(path.join(amem, "MEMORY.md"), "- [Physics](physics.md) — movement is tuned, don't change it\n");
fs.writeFileSync(path.join(amem, "physics.md"), "---\nname: physics\ndescription: movement is tuned, don't change it\nmetadata:\n  type: feedback\n---\nSee [[missing-note]].\n");
const bdir = path.join(CLAUDE, C.encode(beta)); fs.mkdirSync(bdir, { recursive: true });
const t = (m) => new Date(Date.now() - m * 60000).toISOString();
fs.writeFileSync(path.join(bdir, "1234abcd-0000.jsonl"), [
  { type: "user", cwd: beta, timestamp: t(30), message: { content: "add a health endpoint" } },
  { type: "assistant", cwd: beta, timestamp: t(29), message: { id: "m1", model: "claude-x", usage: { input_tokens: 10, output_tokens: 200 }, content: [{ type: "tool_use", name: "Edit", input: { file_path: path.join(beta, "src", "server.ts") } }] } },
  { type: "assistant", cwd: beta, timestamp: t(28), message: { id: "m2", usage: { output_tokens: 50 }, content: [{ type: "tool_use", name: "Read", input: { file_path: path.join(amem, "physics.md") } }] } },
  { type: "custom-title", customTitle: "Health endpoint" },
  { type: "cost-state", totalCostUSD: 1.25, totalLinesAdded: 40, totalLinesRemoved: 3 },
].map((o) => JSON.stringify(o)).join("\n") + "\n");

try {
  console.log("path encoding (" + process.platform + ")");
  ok(C.decodeProjectDir(C.encode(alpha)) && path.resolve(C.decodeProjectDir(C.encode(alpha))) === path.resolve(alpha), "encoded project dir decodes back to the real folder (" + C.encode(alpha).slice(-24) + ")");

  console.log("scan");
  let d = scan(null);
  const A = d.areas.find((a) => a.name === "alpha_game"), B = d.areas.find((a) => a.name === "beta-api");
  ok(A && B, "both projects found (alpha via its memory folder, beta via its session)");
  const s = d.sessions[0];
  ok(s && s.title === "Health endpoint" && s.cost.usd === 1.25 && s.tokens.output === 250, "session title, cost and de-duplicated tokens read");
  ok(d.links.some((l) => l.f !== undefined && d.files[l.f].rel === "src/server.ts" && l.k === "edit"), "session -> file edit link");
  ok(d.links.some((l) => l.m !== undefined && d.memories[l.m].name === "physics" && l.k === "read"), "session -> memory read link");
  ok(d.memories.some((m) => m.kind === "claudemd" && m.area === B.key), "CLAUDE.md picked up as memory");
  const phys = d.memories.find((m) => m.name === "physics");
  ok(phys.type === "feedback" && phys.health.inIndex && phys.health.issues.some((i) => i.type === "broken-link"), "note frontmatter, index check and broken [[link]] detected");
  ok(s.events.length === 2, "replay events recorded");

  console.log("memory linking");
  const bIndex = path.join(M.memDirFor(beta), "MEMORY.md");
  const r = M.linkProjects(A, beta, path.join(OUT, "bak"));
  ok(r.ok && fs.existsSync(bIndex), "link creates beta's MEMORY.md with one pointer line");
  ok(M.linkProjects(A, beta, path.join(OUT, "bak")).already, "linking twice is a no-op");
  d = scan(null);
  ok(d.shares.length === 1 && d.shares[0].from === A.key && d.shares[0].to === B.key, "scanner sees the link");
  const aIndex = path.join(amem, "MEMORY.md"), before = sha(aIndex);
  M.shareNote(path.join(amem, "physics.md"), "alpha_game", beta, path.join(OUT, "bak"));
  ok(M.unlink(beta, aIndex, path.join(OUT, "bak")).removed === 1 && M.unlink(beta, path.join(amem, "physics.md"), path.join(OUT, "bak")).removed === 1, "unlink removes exactly the marked lines");
  ok(fs.readFileSync(bIndex, "utf8").trim() === "" && sha(aIndex) === before, "beta's index is empty again; alpha's memory untouched");
  let threw = false; try { M.shareNote(path.join(beta, "src", "server.ts"), "x", alpha, path.join(OUT, "bak")); } catch { threw = true; }
  ok(threw, "refuses to share a file outside Claude's projects folder");
  ok(fs.readFileSync(path.join(alpha, "src", "player.cs"), "utf8") === "class Player {}", "project files are never modified");

  console.log("team memory");
  const team = path.join(OUT, "team-brain"); fs.mkdirSync(team);
  fs.writeFileSync(path.join(team, "MEMORY.md"), "- [Release checklist](release-checklist.md) — steps before every build\n");
  fs.writeFileSync(path.join(team, "release-checklist.md"), "---\nname: release-checklist\ndescription: steps before every build\n---\nBump, test, tag.\n");
  const cfg = path.join(OUT, "config.json"); fs.writeFileSync(cfg, JSON.stringify({ teamFolders: [{ name: "team-brain", path: team }] }));
  d = scan(cfg);
  const T = d.areas.find((a) => a.team);
  ok(T && T.hasMemory && d.memories.some((m) => m.area === T.key && m.name === "release-checklist"), "team folder appears as a project with its notes");
  ok(M.linkProjects(T, beta, path.join(OUT, "bak"), [team]).ok && scan(cfg).shares.some((s) => s.from === T.key), "team memory linked into a project");
  threw = false; try { M.linkProjects(T, beta, path.join(OUT, "bak2"), []); } catch { threw = true; }
  ok(threw || M.linkProjects(T, beta, path.join(OUT, "bak2"), [team]).already, "team folders must be allowed explicitly");
  ok(M.unlink(beta, T.memIndex, path.join(OUT, "bak")).removed === 1, "team link removed");
  process.env.SYNAPSE_CONFIG = cfg;

  console.log("MCP server");
  const res = spawnSync(process.execPath, [path.join(__dirname, "..", "src", "mcp.js")], { encoding: "utf8", timeout: 60000, env: { ...process.env },
    input: [{ id: 1, method: "initialize", params: {} }, { id: 2, method: "tools/list" }, { id: 3, method: "tools/call", params: { name: "search_memory", arguments: { query: "movement" } } },
      { id: 4, method: "tools/call", params: { name: "link_memory", arguments: { from: "alpha_game", to: "beta-api" } } }, { id: 5, method: "tools/call", params: { name: "search_memory", arguments: { query: "release checklist" } } },
      { id: 6, method: "tools/call", params: { name: "unlink_memory", arguments: { from: "alpha_game", to: "beta-api" } } }]
      .map((m) => JSON.stringify({ jsonrpc: "2.0", ...m })).join("\n") + "\n" });
  const lines = res.stdout.trim().split("\n").map((l) => JSON.parse(l));
  ok(lines[0].result.serverInfo.name === "synapse", "initialize");
  ok(lines[1].result.tools.length >= 7, "tools/list (" + lines[1].result.tools.length + " tools)");
  ok(/physics \[alpha_game\]/.test(lines[2].result.content[0].text), "search_memory finds the note");
  ok(/linked/.test(lines[3].result.content[0].text), "link_memory: " + lines[3].result.content[0].text.split(" — ")[0]);
  ok(/release-checklist \[team-brain\]/.test(lines[4].result.content[0].text), "search_memory finds team notes");
  ok(/removed/.test(lines[5].result.content[0].text), "unlink_memory: " + lines[5].result.content[0].text);
  ok(fs.readFileSync(path.join(M.memDirFor(beta), "MEMORY.md"), "utf8").trim() === "", "beta's MEMORY.md is clean again");
} finally {
  fs.rmSync(OUT, { recursive: true, force: true });
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
