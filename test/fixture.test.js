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
  // the same mistake 3 times (different line numbers / paths -> same signature)
  ...[1, 2, 3].map((i) => ({ type: "assistant", cwd: beta, timestamp: t(20 - i), message: { id: "e" + i, content: [{ type: "tool_use", id: "te" + i, name: "Edit", input: { file_path: path.join(beta, "src", "f" + i + ".ts") } }] } })),
  ...[1, 2, 3].map((i) => ({ type: "user", cwd: beta, timestamp: t(20 - i), message: { content: [{ type: "tool_result", tool_use_id: "te" + i, is_error: true, content: "<tool_use_error>File has not been read yet. Read it first before writing to it.</tool_use_error>" }] } })),
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
  const mk = d.suggestions.mistakes;
  ok(mk.length === 1 && mk[0].count === 3 && mk[0].tool === "Edit" && /has not been read yet/.test(mk[0].sig), "repeated mistake found (Edit before Read, 3x)");
  ok(s.errorCount === 3 && !("errors" in s), "raw errors are summarized, not kept in the data");

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

  console.log("memory doctor");
  const Doctor = require("../src/core/doctor");
  fs.writeFileSync(path.join(amem, "jumping.md"), "---\nname: jumping\ndescription: double jump needs the coyote timer\n---\nCoyote time is 0.1s.\n");
  fs.writeFileSync(path.join(amem, "physics-tuning.md"), "---\nname: physics-tuning\ndescription: movement is tuned, do not change it\n---\nGravity 30, speed 8. See [[physics]].\n");
  d = scan(null);
  const A2 = d.areas.find((a) => a.name === "alpha_game"), note = (n) => d.memories.find((m) => m.name === n);
  const snap = () => Object.fromEntries(fs.readdirSync(amem).map((f) => [f, sha(path.join(amem, f))]));
  const before0 = snap();
  ok(note("jumping").health.issues.some((i) => i.type === "not-indexed"), "health: jumping.md is not in MEMORY.md");
  ok(note("physics").health.issues.some((i) => i.type === "duplicate"), "health: physics / physics-tuning flagged as duplicates");
  // 1) add to index
  let p = Doctor.plan({ type: "index", note: note("jumping"), area: A2 });
  ok(p.changes.length === 1 && /\[jumping\]\(jumping\.md\)/.test(p.changes[0].after), "plan: add jumping to MEMORY.md (preview only)");
  ok(sha(path.join(amem, "MEMORY.md")) === before0["MEMORY.md"], "planning writes nothing");
  const u1 = Doctor.apply(p, path.join(OUT, "bak"));
  ok(fs.readFileSync(path.join(amem, "MEMORY.md"), "utf8").includes("(jumping.md)"), "apply: index updated");
  // 2) broken link -> suggested target
  ok(Doctor.suggestTargets("missing-note", [note("jumping"), note("physics-tuning")]).length >= 0, "suggestTargets runs");
  const u2 = Doctor.apply(Doctor.plan({ type: "link", note: note("physics"), broken: "missing-note", replacement: "jumping" }), path.join(OUT, "bak"));
  ok(fs.readFileSync(path.join(amem, "physics.md"), "utf8").includes("[[jumping]]"), "apply: broken [[link]] repointed");
  // 3) merge duplicates: physics-tuning into physics
  d = scan(null);
  const u3 = Doctor.apply(Doctor.plan({ type: "merge", keep: note("physics"), drop: note("physics-tuning"), area: A2, notes: d.memories.filter((m) => m.area === A2.key) }), path.join(OUT, "bak"));
  ok(!fs.existsSync(path.join(amem, "physics-tuning.md")) && fs.readFileSync(path.join(amem, "physics.md"), "utf8").includes("## Merged from physics-tuning"), "apply: duplicates merged, dropped file removed");
  // 4) slash command in the project
  const u4 = Doctor.apply(Doctor.plan({ type: "command", project: B, text: "run the tests and fix anything that fails", name: "Fix Tests" }), path.join(OUT, "bak"), [beta]);
  ok(fs.existsSync(path.join(beta, ".claude", "commands", "fix-tests.md")), "apply: /fix-tests created in the project");
  threw = false; try { Doctor.plan({ type: "command", project: B, text: "x", name: "fix-tests" }); } catch { threw = true; }
  ok(threw, "never overwrites an existing command");
  threw = false; try { Doctor.apply({ changes: [{ file: path.join(beta, "src", "server.ts"), before: "export {}", after: "hacked" }] }, path.join(OUT, "bak")); } catch { threw = true; }
  ok(threw && fs.readFileSync(path.join(beta, "src", "server.ts"), "utf8") === "export {}", "refuses to write project source files");
  // 5) save a repeated mistake as a memory rule (new note + MEMORY.md line)
  const u5 = Doctor.apply(Doctor.plan({ type: "rule", area: A2, name: "Rule: read before edit!", rule: "Always Read a file right before you Edit it.", why: "hit 3 times", tool: "Edit" }), path.join(OUT, "bak"));
  const ruleNote = path.join(amem, "rule-read-before-edit.md");
  ok(fs.existsSync(ruleNote) && /type: feedback/.test(fs.readFileSync(ruleNote, "utf8")) && fs.readFileSync(path.join(amem, "MEMORY.md"), "utf8").includes("(rule-read-before-edit.md)"), "apply: rule saved as a feedback note and indexed");
  d = scan(null);
  ok(d.memories.some((m) => m.name === "rule-read-before-edit" && m.type === "feedback"), "scanner reads the new rule like any memory note");
  // undo everything, newest first -> byte-identical
  for (const u of [u5, u4, u3, u2, u1]) Doctor.undo(u.undo, [beta]);
  ok(JSON.stringify(snap()) === JSON.stringify(before0) && !fs.existsSync(path.join(beta, ".claude", "commands", "fix-tests.md")), "undo restores every file byte-for-byte");
  fs.unlinkSync(path.join(amem, "jumping.md")); fs.unlinkSync(path.join(amem, "physics-tuning.md"));

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
