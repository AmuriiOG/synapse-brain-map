// Live mode test on a temp folder: append lines to a fake session log, expect the right events.
const fs = require("fs"), path = require("path"), os = require("os");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "synapse-live-"));
process.env.SYNAPSE_CLAUDE_PROJECTS = root;
process.env.SYNAPSE_WAIT_MS = "1500";                         // short "may be waiting" delay for the test
const { createLive } = require("../src/core/live");
const proj = path.join(root, "C--fake-project"); fs.mkdirSync(proj);
const log = path.join(proj, "abcdef12-0000.jsonl");
const CWD = "C:/fake/project";
fs.writeFileSync(log, JSON.stringify({ type: "user", cwd: CWD, timestamp: new Date().toISOString(), message: { content: "old prompt (must NOT be reported)" } }) + "\n");

const got = [];
const live = createLive((ev) => got.push(...ev));
console.log("watcher started:", live.start());
const line = (o) => fs.appendFileSync(log, JSON.stringify({ cwd: CWD, timestamp: new Date().toISOString(), ...o }) + "\n");
const at = (ms, fn) => setTimeout(fn, ms);

at(300, () => {
  line({ type: "user", message: { content: "add a jump button" } });
  line({ type: "assistant", message: { content: [{ type: "tool_use", id: "t0", name: "Edit", input: { file_path: CWD + "/src/jump.cs" } }] } });
  line({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t0", content: "ok" }] } });
  // a line written in two parts must be parsed once it is complete
  fs.appendFileSync(log, JSON.stringify({ type: "assistant", cwd: CWD, message: { content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: CWD + "/README.md" } }] } }).slice(0, 60));
});
at(700, () => {
  const full = JSON.stringify({ type: "assistant", cwd: CWD, message: { content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: CWD + "/README.md" } }] } });
  fs.appendFileSync(log, full.slice(60) + "\n");
  line({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] } });
});
at(900, () => line({ type: "assistant", message: { stop_reason: "end_turn", content: [{ type: "text", text: "All done, tests pass." }] } }));
at(1100, () => {   // next turn: Bash never gets a result (permission prompt), Read does
  line({ type: "user", message: { content: "deploy it" } });
  line({ type: "assistant", message: { content: [{ type: "tool_use", id: "t2", name: "Bash", input: { command: "deploy" } }] } });
  line({ type: "assistant", message: { content: [{ type: "tool_use", id: "t3", name: "Read", input: { file_path: CWD + "/a.txt" } }] } });
});
at(1300, () => line({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t3", content: "ok" }] } }));

// a SECOND session (another log file) edits the same file -> conflict; then it gets stuck
const log2 = path.join(proj, "b2c3d4e5-0000.jsonl");
const line2 = (o) => fs.appendFileSync(log2, JSON.stringify({ cwd: CWD, timestamp: new Date().toISOString(), ...o }) + "\n");
at(1600, () => line2({ type: "assistant", message: { content: [{ type: "tool_use", id: "s0", name: "Edit", input: { file_path: CWD + "/src/jump.cs" } }] } }));
at(2000, () => {
  line2({ type: "cost-state", totalCostUSD: 3.0 });
  for (let i = 1; i <= 8; i++) line2({ type: "assistant", message: { content: [{ type: "tool_use", id: "e" + i, name: "Edit", input: { file_path: CWD + "/src/loop.cs" } }] } });
  for (let i = 1; i <= 4; i++) {
    line2({ type: "assistant", message: { content: [{ type: "tool_use", id: "b" + i, name: "Bash", input: { command: "npm test" } }] } });
    line2({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "b" + i, is_error: true, content: "Exit code 1\nError: Cannot find module './util" + i + ".js'" }] } });
  }
  line2({ type: "cost-state", totalCostUSD: 15.5 });
});

at(6500, () => {
  live.stop();
  if (process.env.V) console.log(JSON.stringify(got));
  let fail = 0; const ok = (c, m) => { if (!c) fail++; console.log((c ? "  ✓ " : "  ✗ ") + m); };
  ok(!got.some((e) => /old prompt/.test(e.text || "")), "history before start is not replayed");
  ok(got.some((e) => e.type === "prompt" && e.text === "add a jump button"), "new prompt reported");
  ok(got.some((e) => e.type === "touch" && e.k === "edit" && e.p.endsWith("/src/jump.cs")), "edit reported with normalized path");
  ok(got.some((e) => e.type === "touch" && e.k === "read" && e.p.endsWith("/readme.md")), "line split across writes reported once complete");
  ok(got.every((e) => ["abcdef12", "b2c3d4e5"].includes(e.session)), "session id attached");
  const conf = got.filter((e) => e.type === "conflict");
  ok(conf.length === 1 && conf[0].p.endsWith("/src/jump.cs") && conf[0].session === "b2c3d4e5" && conf[0].other === "abcdef12", "conflict: two sessions edited jump.cs (reported once)");
  const stuck = got.filter((e) => e.type === "stuck"), why = stuck.map((e) => e.reason).sort().join(",");
  ok(stuck.some((e) => e.reason === "edit-loop" && e.detail.p.endsWith("/src/loop.cs") && e.detail.times === 8), "stuck: same file edited 8 times");
  ok(stuck.some((e) => e.reason === "same-error" && e.detail.times === 4 && e.detail.tool === "Bash"), "stuck: same error 4 times (paths/numbers ignored)");
  ok(stuck.some((e) => e.reason === "cost-burn" && e.detail.usd >= 12), "stuck: cost rose $12.50 in minutes");
  ok(stuck.every((e) => e.session === "b2c3d4e5"), "only the stuck session is flagged (" + why + ")");
  ok(got.some((e) => e.type === "turn-end" && /All done/.test(e.text)), "Claude finishing its turn is reported (your turn)");
  const waits = got.filter((e) => e.type === "tool-waiting" && e.session === "abcdef12");
  ok(waits.length === 1 && waits[0].tool === "Bash", "an unanswered tool is reported once as waiting (Bash); answered ones are not");
  fs.rmSync(root, { recursive: true, force: true });
  console.log(fail ? `${fail} failed` : "all passed");
  process.exit(fail ? 1 : 0);
});
