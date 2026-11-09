// UI test for memory doctor + suggestions on a throwaway fixture (never your real memory):
// Fix button -> diff preview -> apply -> toast -> Undo, and the Suggestions tab.   npx electron test/doctor-ui.js
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const OUT = path.join(__dirname, "out", "doctor-ui-" + process.pid);
const CLAUDE = path.join(OUT, "claude", "projects"), proj = path.join(OUT, "work", "gamma_app");
process.env.SYNAPSE_CLAUDE_PROJECTS = CLAUDE;
process.env.SHOTS = process.env.SHOTS || "";
const C = require("../src/core/claude");
fs.mkdirSync(path.join(proj, "src"), { recursive: true });
fs.writeFileSync(path.join(proj, "src", "main.ts"), "export {}");
const mem = path.join(CLAUDE, C.encode(proj), "memory"); fs.mkdirSync(mem, { recursive: true });
fs.writeFileSync(path.join(mem, "MEMORY.md"), "- [Build](build.md) — how to build\n");
fs.writeFileSync(path.join(mem, "build.md"), "---\nname: build\ndescription: how to build\n---\nRun npm run build.\n");
fs.writeFileSync(path.join(mem, "orphan.md"), "---\nname: orphan\ndescription: a note nobody indexed\n---\nImportant fact.\n");
const sdir = path.join(CLAUDE, C.encode(proj)), ts = (m) => new Date(Date.now() - m * 60000).toISOString();
fs.writeFileSync(path.join(sdir, "aaaa1111.jsonl"), [1, 2, 3, 4].map((i) => [
  { type: "user", cwd: proj, timestamp: ts(i * 1500), message: { content: "run the tests and fix anything that fails" } },
  { type: "assistant", cwd: proj, timestamp: ts(i * 1500 - 1), message: { id: "m" + i, content: [{ type: "tool_use", id: "x" + i, name: "Read", input: { file_path: path.join(proj, "src", "main.ts") } }] } },
]).flat().map((o) => JSON.stringify(o)).join("\n") + "\n");
for (const sid of ["bbbb2222", "cccc3333"]) fs.writeFileSync(path.join(sdir, sid + ".jsonl"), JSON.stringify({ type: "user", cwd: proj, timestamp: ts(5), message: { content: "run the tests and fix anything that fails" } }) + "\n");
const sha = (f) => crypto.createHash("sha1").update(fs.readFileSync(f)).digest("hex");
const before = sha(path.join(mem, "MEMORY.md"));

const { app, BrowserWindow } = require("electron");
require("../src/main.js");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0; const ok = (c, m) => { if (!c) fails++; console.log((c ? "  ✓ " : "  ✗ ") + m); };
app.whenReady().then(async () => {
  const w = BrowserWindow.getAllWindows()[0], js = (c) => w.webContents.executeJavaScript(c);
  const errors = []; w.webContents.on("console-message", (e) => { if (e.level === "error") errors.push(String(e.message).slice(0, 200)); });
  for (let i = 0; i < 80; i++) { await wait(300); if (await js("!!window.__synapse").catch(() => false)) break; }
  await wait(2000);
  await js(`__synapse.showInsights('health')`); await wait(400);
  const fixLabel = await js(`(document.querySelector('#dbody [data-fix]') || {}).textContent || ''`);
  ok(/add to MEMORY\.md/.test(fixLabel), "health tab shows a Fix button: " + fixLabel.trim());
  await js(`document.querySelector('#dbody [data-fix]').click()`); await wait(800);
  const diff = await js(`document.getElementById('mBody').innerText`);
  ok(/orphan/.test(diff) && /\+ - \[orphan\]\(orphan\.md\)/.test(diff), "diff preview shows the line that will be added");
  ok(sha(path.join(mem, "MEMORY.md")) === before, "nothing written before Apply");
  await js(`document.getElementById('mYes').click()`); await wait(800);
  ok(fs.readFileSync(path.join(mem, "MEMORY.md"), "utf8").includes("(orphan.md)"), "Apply wrote MEMORY.md");
  const t = await js(`document.getElementById('toast').innerText`);
  ok(/done/.test(t) && /Undo/.test(t), "toast offers Undo: " + t.replace(/\s+/g, " "));
  await js(`document.getElementById('tAct').click()`); await wait(600);
  ok(sha(path.join(mem, "MEMORY.md")) === before, "Undo restored MEMORY.md byte-for-byte");
  await js(`__synapse.showInsights('suggest')`); await wait(400);
  const sug = await js(`document.getElementById('dbody').innerText`);
  ok(/run the tests and fix anything that fails/.test(sug), "Suggestions: repeated prompt found (3 sessions)");
  ok(/main\.ts/.test(sug), "Suggestions: re-read file found");
  await js(`document.querySelector('[data-cmd]').click()`); await wait(400);
  await js(`document.getElementById('fxName').value = 'fix-tests'; document.getElementById('mYes').click()`); await wait(700);
  ok(/create the slash command \/fix-tests/.test(await js(`document.getElementById('mBody').innerText`)), "slash command preview");
  await js(`document.getElementById('mYes').click()`); await wait(700);
  const cmd = path.join(proj, ".claude", "commands", "fix-tests.md");
  ok(fs.existsSync(cmd) && /run the tests/.test(fs.readFileSync(cmd, "utf8")), "slash command file created");
  await js(`document.getElementById('tAct').click()`); await wait(600);
  ok(!fs.existsSync(cmd), "Undo removed the new command");
  // waiting alert, as live mode would deliver it
  await js(`__synapse.onLiveEvents([{ type: 'turn-end', session: 'aaaa1111', cwd: __synapse.areas[0].key, t: Date.now(), text: 'done' }])`); await wait(300);
  ok(/your turn/.test(await js(`document.getElementById('ticker').innerText`)), "turn-end shows 'your turn' in the ticker");
  ok(!errors.length, "no renderer errors" + (errors.length ? ": " + errors.join(" | ") : ""));
  try { fs.rmSync(OUT, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch {}
  console.log(fails ? `${fails} failed` : "all passed");
  app.exit(fails ? 1 : 0);
});
