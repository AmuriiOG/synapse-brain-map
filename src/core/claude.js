// Claude Code on-disk format adapter.
//
// Everything Synapse knows about how Claude Code stores its data lives in THIS file, so if a
// Claude Code update changes a format, this is the only place to fix. Nothing here writes.
//
//   ~/.claude/projects/<encoded project path>/<session id>.jsonl   one line per event
//   ~/.claude/projects/<encoded project path>/memory/MEMORY.md     memory index (+ <note>.md files)
//   <project>/CLAUDE.md, <project>/.claude/CLAUDE.md, ~/.claude/CLAUDE.md   instructions
//
// Encoded project path = absolute path with every non-alphanumeric character replaced by "-":
//   Windows  C:\Users\me\game   ->  C--Users-me-game
//   macOS    /Users/me/game     ->  -Users-me-game
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const CLAUDE_HOME = process.env.SYNAPSE_CLAUDE_HOME || path.join(os.homedir(), ".claude");
const PROJECTS = process.env.SYNAPSE_CLAUDE_PROJECTS || path.join(CLAUDE_HOME, "projects");

const encode = (p) => path.resolve(p).replace(/[^a-zA-Z0-9]/g, "-");
const norm = (p) => path.resolve(p).replace(/\\/g, "/").toLowerCase();
const memDirFor = (projectPath) => path.join(PROJECTS, encode(projectPath), "memory");
const isTempPath = (p) => /scratch-workspaces|appdata\/local\/temp|^\/tmp\/|\/var\/folders\//i.test(p.replace(/\\/g, "/"));

// The encoding is lossy (every "-", "_", ".", " " becomes "-"), so walk the disk and match names.
function decodeProjectDir(enc) {
  let root, rest;
  const win = /^([A-Za-z])--(.*)$/.exec(enc);
  if (win && process.platform === "win32") { root = win[1] + ":\\"; rest = win[2]; }
  else if (enc.startsWith("-")) { root = "/"; rest = enc.slice(1); }
  else return null;
  const search = (dir, rest, depth) => {
    if (!rest) return dir;
    if (depth > 14) return null;
    let kids; try { kids = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
    const r = rest.toLowerCase();
    for (const k of kids) {
      if (!k.isDirectory()) continue;
      const e = k.name.replace(/[^a-zA-Z0-9]/g, "-").toLowerCase();
      if (r === e) return path.join(dir, k.name);
      if (r.startsWith(e + "-")) { const hit = search(path.join(dir, k.name), rest.slice(e.length + 1), depth + 1); if (hit) return hit; }
    }
    return null;
  };
  return search(root, rest, 0);
}

function listProjectDirs() {
  try { return fs.readdirSync(PROJECTS, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => ({ name: d.name, dir: path.join(PROJECTS, d.name) })); }
  catch { return []; }
}
const listSessionFiles = (projectDir) => { try { return fs.readdirSync(projectDir).filter((f) => f.endsWith(".jsonl")).map((f) => path.join(projectDir, f)); } catch { return []; } };

const EDIT_TOOLS = /^(Edit|Write|MultiEdit|NotebookEdit)$/;

// A tool error's "signature": its meaningful first line with paths, quoted text and numbers blanked,
// so the same mistake made twice gets the same signature.
const DENIED = /doesn.t want to proceed|tool use was rejected|was denied by|permission for this action was denied|user denied/i;
function errorSignature(text) {
  const lines = String(text || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const line = lines.find((l) => !/^exit code \d+$/i.test(l) && !/^<\/?tool_use_error>$/.test(l)) || lines[0] || "";
  return line.replace(/<\/?tool_use_error>/g, "")
    .replace(/([A-Za-z]:)?[\\/][^\s'"`]+/g, "<path>")
    .replace(/(["'`])[^"'`]{0,200}\1/g, '"…"')
    .replace(/0x[0-9a-f]+|\d+(\.\d+)?/gi, "#")
    .replace(/\s+/g, " ").trim().slice(0, 140);
}
const isDenied = (text) => DENIED.test(String(text || ""));
const resultText = (c) => typeof c.content === "string" ? c.content : Array.isArray(c.content) ? c.content.map((x) => x.text || "").join(" ") : "";
// what a tool call was about, in a few words (command, file, url, pattern)
const toolInput = (input) => input ? String(input.command || input.file_path || input.url || input.pattern || input.path || "").slice(0, 160) : "";

// Parse one session log. Returns null if it has no usable content.
function readSession(file) {
  let cwd = null, start = null, end = null, prompts = 0, firstPrompt = "", title = "", model = "", cost = null;
  const promptList = [];
  const touched = new Map(), events = [], seenMsg = new Set(), toolById = new Map(), errors = [];
  const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let text; try { text = fs.readFileSync(file, "utf8"); } catch { return null; }
  for (const line of text.split("\n")) {
    if (!line) continue;
    let j; try { j = JSON.parse(line); } catch { continue; }
    if (j.cwd && !cwd) cwd = j.cwd;
    const t = j.timestamp ? Date.parse(j.timestamp) : null;
    if (t) { if (!start || t < start) start = t; if (!end || t > end) end = t; }
    if (j.type === "custom-title" && j.customTitle) title = j.customTitle;
    if (j.type === "cost-state") cost = { usd: j.totalCostUSD || 0, linesAdded: j.totalLinesAdded || 0, linesRemoved: j.totalLinesRemoved || 0, apiMs: j.totalAPIDuration || 0, unknownModel: !!j.hasUnknownModelCost };
    if (j.type === "user" && j.message && typeof j.message.content === "string" && !j.isMeta) {
      prompts++; if (!firstPrompt) firstPrompt = j.message.content.slice(0, 140);
      if (promptList.length < 300) promptList.push({ t, text: j.message.content.slice(0, 400) });
    }
    const msg = j.message;
    if (j.type === "assistant" && msg && msg.usage && msg.id && !seenMsg.has(msg.id)) {   // one API reply can span several lines
      seenMsg.add(msg.id); if (msg.model) model = msg.model;
      tokens.input += msg.usage.input_tokens || 0; tokens.output += msg.usage.output_tokens || 0;
      tokens.cacheRead += msg.usage.cache_read_input_tokens || 0; tokens.cacheWrite += msg.usage.cache_creation_input_tokens || 0;
    }
    const content = msg && Array.isArray(msg.content) ? msg.content : [];
    for (const c of content) {
      if (c.type === "tool_use" && c.id) toolById.set(c.id, { name: c.name, input: toolInput(c.input) });
      if (c.type === "tool_result" && c.is_error && errors.length < 400) {
        const tool = toolById.get(c.tool_use_id) || { name: "?", input: "" }, txt = resultText(c);
        errors.push({ t, tool: tool.name, input: tool.input, sig: errorSignature(txt), text: txt.replace(/\s+/g, " ").slice(0, 240), denied: isDenied(txt) });
      }
      if (c.type !== "tool_use" || !c.input) continue;
      const p = c.input.file_path || c.input.notebook_path;
      if (!p) continue;
      const kind = EDIT_TOOLS.test(c.name) ? "edit" : "read";
      if (touched.get(p) !== "edit") touched.set(p, kind);
      if (t && events.length < 600) events.push({ t, p: norm(p), k: kind });
    }
  }
  if (!cwd || !start) return null;
  return { id: path.basename(file, ".jsonl").slice(0, 8), file, cwd, start, end, prompts, promptList, title: title || firstPrompt, model, tokens, cost,
    touched: [...touched].map(([p, k]) => ({ p: norm(p), k })), events, errors };
}

// Memory note: optional frontmatter (name, description, type) + body with [[wiki links]]
function parseNote(file) {
  const raw = fs.readFileSync(file, "utf8");
  const st = fs.statSync(file);
  let name = path.basename(file, ".md"), description = "", type = "", body = raw;
  const fm = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  if (fm) {
    body = raw.slice(fm[0].length);
    const get = (k) => { const r = new RegExp("^\\s*" + k + ":\\s*(.*)$", "m").exec(fm[1]); return r ? r[1].trim().replace(/^["']|["']$/g, "") : ""; };
    name = get("name") || name; description = get("description"); type = get("type");
  }
  const links = [...body.matchAll(/\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g)].map((x) => x[1].trim());
  return { name, description, type, body: body.trim().slice(0, 2500), links, t: st.mtimeMs, size: st.size };
}

const projectInstructionFiles = (projectPath) => ["CLAUDE.md", ".claude/CLAUDE.md", "CLAUDE.local.md"].map((rel) => ({ rel, path: path.join(projectPath, rel) }));
const globalInstructionFile = () => path.join(CLAUDE_HOME, "CLAUDE.md");

module.exports = { errorSignature, isDenied, resultText, toolInput, CLAUDE_HOME, PROJECTS, encode, norm, memDirFor, isTempPath, decodeProjectDir, listProjectDirs, listSessionFiles, readSession, parseNote, projectInstructionFiles, globalInstructionFile };
