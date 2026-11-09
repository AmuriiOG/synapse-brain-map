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

at(6500, () => {
  live.stop();
  if (process.env.V) console.log(JSON.stringify(got));
  let fail = 0; const ok = (c, m) => { if (!c) fail++; console.log((c ? "  ✓ " : "  ✗ ") + m); };
  ok(!got.some((e) => /old prompt/.test(e.text || "")), "history before start is not replayed");
  ok(got.some((e) => e.type === "prompt" && e.text === "add a jump button"), "new prompt reported");
  ok(got.some((e) => e.type === "touch" && e.k === "edit" && e.p.endsWith("/src/jump.cs")), "edit reported with normalized path");
  ok(got.some((e) => e.type === "touch" && e.k === "read" && e.p.endsWith("/readme.md")), "line split across writes reported once complete");
  ok(got.every((e) => e.session === "abcdef12"), "session id attached");
  ok(got.some((e) => e.type === "turn-end" && /All done/.test(e.text)), "Claude finishing its turn is reported (your turn)");
  const waits = got.filter((e) => e.type === "tool-waiting");
  ok(waits.length === 1 && waits[0].tool === "Bash", "an unanswered tool is reported once as waiting (Bash); answered ones are not");
  fs.rmSync(root, { recursive: true, force: true });
  console.log(fail ? `${fail} failed` : "all passed");
  process.exit(fail ? 1 : 0);
});
