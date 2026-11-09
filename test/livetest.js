// Live mode test on a temp folder: append lines to a fake session log, expect events.
const fs = require("fs"), path = require("path"), os = require("os");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "synapse-live-"));
process.env.SYNAPSE_CLAUDE_PROJECTS = root;
const { createLive } = require("../src/core/live");
const proj = path.join(root, "C--fake-project"); fs.mkdirSync(proj);
const log = path.join(proj, "abcdef12-0000.jsonl");
fs.writeFileSync(log, JSON.stringify({ type: "user", cwd: "C:/fake/project", timestamp: new Date().toISOString(), message: { content: "old prompt (must NOT be reported)" } }) + "\n");
const got = [];
const live = createLive((ev) => got.push(...ev));
console.log("watcher started:", live.start());
const line = (o) => fs.appendFileSync(log, JSON.stringify({ cwd: "C:/fake/project", timestamp: new Date().toISOString(), ...o }) + "\n");
setTimeout(() => {
  line({ type: "user", message: { content: "add a jump button" } });
  line({ type: "assistant", message: { content: [{ type: "tool_use", name: "Edit", input: { file_path: "C:/fake/project/src/jump.cs" } }] } });
  // a half-written line, finished later: must be parsed once complete
  fs.appendFileSync(log, '{"type":"assistant","cwd":"C:/fake/project","message":{"content":[{"type":"tool_use","name":"Read",');
}, 300);
setTimeout(() => fs.appendFileSync(log, '"input":{"file_path":"C:/fake/project/README.md"}}]}}\n'), 700);
setTimeout(() => {
  live.stop(); if (process.env.V) console.log(JSON.stringify(got, null, 0));
  const ok = (c, m) => console.log((c ? "  ✓ " : "  ✗ ") + m);
  ok(!got.some((e) => /old prompt/.test(e.text || "")), "history before start is not replayed");
  ok(got.some((e) => e.type === "prompt" && e.text === "add a jump button"), "new prompt reported");
  ok(got.some((e) => e.type === "touch" && e.k === "edit" && e.p.endsWith("/src/jump.cs")), "edit reported with normalized path");
  ok(got.some((e) => e.type === "touch" && e.k === "read" && e.p.endsWith("/readme.md")), "line split across writes reported once complete");
  ok(got.every((e) => e.session === "abcdef12"), "session id attached");
  fs.rmSync(root, { recursive: true, force: true });
}, 1500);
