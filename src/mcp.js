#!/usr/bin/env node
// Synapse MCP server — lets Claude Code query your project map and memory, and link memory.
// Transport: MCP over stdio (newline-delimited JSON-RPC 2.0). No dependencies.
//
//   claude mcp add synapse --scope user -- node /path/to/synapse/src/mcp.js
//
// Read tools never write. link_memory / unlink_memory only add/remove one marked line in a
// project's MEMORY.md (backup first), exactly like the app; Claude Code asks you before using them.
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { scan } = require("./core/scan");
const M = require("./core/memory");

const CONFIG = process.env.SYNAPSE_CONFIG || null;
const DATA_DIR = CONFIG ? path.dirname(CONFIG) : path.join(os.homedir(), ".synapse");
const BACKUPS = path.join(DATA_DIR, "memory-backups");
const CACHE = path.join(DATA_DIR, "cache.json");
const DAY = 864e5;

let data = null, dataAt = 0;
function getData(forceFresh = false) {
  if (!forceFresh && data && Date.now() - dataAt < 2 * 60 * 1000) return data;
  if (!forceFresh) try { const c = JSON.parse(fs.readFileSync(CACHE, "utf8")); if (Date.now() - c.generated < 10 * 60 * 1000) { data = c; dataAt = Date.now(); return data; } } catch {}
  data = scan(CONFIG); dataAt = Date.now();
  return data;
}
const findArea = (d, name) => {
  const n = String(name || "").toLowerCase();
  const a = d.areas.find((x) => x.name.toLowerCase() === n) || d.areas.find((x) => x.name.toLowerCase().includes(n) || x.path.toLowerCase() === n);
  if (!a) throw new Error(`no project matching "${name}". Known: ${d.areas.map((x) => x.name).join(", ")}`);
  return a;
};
const fmt = (t) => t ? new Date(t).toISOString().slice(0, 16).replace("T", " ") : "never";
const teamRoots = (d) => d.areas.filter((a) => a.team).map((a) => a.path);

const TOOLS = [
  { name: "list_projects", description: "List the projects Claude Code has worked on (plus team memory folders), with memory size, last activity and API-equivalent cost.",
    inputSchema: { type: "object", properties: {} },
    run: () => { const d = getData(); return d.areas.map((a) => {
      const s = d.sessions.filter((x) => x.cwd === a.key), mem = d.memories.filter((m) => m.area === a.key);
      const lastT = Math.max(0, ...s.map((x) => x.end || 0));
      return `- ${a.name}${a.team ? " (team memory)" : ""} — ${a.path}\n  ${mem.length} memory notes · ${s.length} sessions · last activity ${fmt(lastT)} · $${s.reduce((x, y) => x + (y.cost ? y.cost.usd : 0), 0).toFixed(2)}`;
    }).join("\n"); } },
  { name: "search_memory", description: "Search Claude's memory notes and CLAUDE.md files across ALL projects. Use to find knowledge another project already learned.",
    inputSchema: { type: "object", properties: { query: { type: "string", description: "words to look for" }, project: { type: "string", description: "optional: limit to one project" } }, required: ["query"] },
    run: ({ query, project }) => {
      const d = getData(), words = String(query).toLowerCase().split(/\s+/).filter(Boolean);
      const only = project ? findArea(d, project).key : null;
      const hits = d.memories.map((m, i) => {
        if (only && m.area !== only) return null;
        const hay = (m.name + " " + m.description + " " + m.body).toLowerCase();
        const score = words.reduce((x, w) => x + (hay.includes(w) ? 1 : 0) + ((m.name + m.description).toLowerCase().includes(w) ? 2 : 0), 0);
        return score ? { m, score } : null;
      }).filter(Boolean).sort((a, b) => b.score - a.score).slice(0, 12);
      if (!hits.length) return `No memory matches "${query}".`;
      return hits.map(({ m }) => { const a = d.areas.find((x) => x.key === m.area);
        return `- ${m.name} [${a ? a.name : "global"}] — ${m.description || m.body.split("\n")[0].slice(0, 160)}\n  file: ${m.path}`; }).join("\n");
    } },
  { name: "read_memory", description: "Read one memory note (or CLAUDE.md) in full.",
    inputSchema: { type: "object", properties: { project: { type: "string" }, note: { type: "string", description: "note name or file name" } }, required: ["project", "note"] },
    run: ({ project, note }) => {
      const d = getData(), a = findArea(d, project), n = String(note).toLowerCase().replace(/\.md$/, "");
      const m = d.memories.find((x) => x.area === a.key && (x.name.toLowerCase() === n || x.file.toLowerCase().replace(/\.md$/, "") === n));
      if (!m) throw new Error(`no note "${note}" in ${a.name}. Notes: ${d.memories.filter((x) => x.area === a.key).map((x) => x.name).join(", ")}`);
      return `# ${m.name} (${a.name})\n${m.path}\n\n` + fs.readFileSync(m.path, "utf8");
    } },
  { name: "project_activity", description: "What happened recently in a project: Claude sessions (titles, cost), most edited files, and git commits.",
    inputSchema: { type: "object", properties: { project: { type: "string" }, days: { type: "number", description: "default 14" } }, required: ["project"] },
    run: ({ project, days = 14 }) => {
      const d = getData(), a = findArea(d, project), since = Date.now() - days * DAY;
      const s = d.sessions.filter((x) => x.cwd === a.key && x.end >= since).sort((x, y) => y.start - x.start);
      const edits = {}; d.links.filter((l) => l.k === "edit" && l.f !== undefined && s.includes(d.sessions[l.s])).forEach((l) => { const f = d.files[l.f].rel; edits[f] = (edits[f] || 0) + 1; });
      const c = d.commits.filter((x) => x.area === a.key && x.t >= since).sort((x, y) => y.t - x.t);
      return [`## ${a.name} — last ${days} days`,
        `Sessions (${s.length}):`, ...s.slice(0, 15).map((x) => `- ${fmt(x.start)} "${x.title}" · ${x.prompts} prompts${x.cost ? ` · $${x.cost.usd.toFixed(2)} · +${x.cost.linesAdded}/-${x.cost.linesRemoved} lines` : ""}`),
        `Most edited files:`, ...Object.entries(edits).sort((x, y) => y[1] - x[1]).slice(0, 12).map(([f, n]) => `- ${f} (${n} sessions)`),
        `Commits (${c.length}):`, ...c.slice(0, 15).map((x) => `- ${x.h} ${fmt(x.t)} ${x.msg}`)].join("\n");
    } },
  { name: "memory_health", description: "Find memory problems: notes missing from MEMORY.md, stale notes, broken [[links]], near-duplicates.",
    inputSchema: { type: "object", properties: { project: { type: "string", description: "optional" } } },
    run: ({ project }) => {
      const d = getData(), only = project ? findArea(d, project).key : null;
      const rows = d.memories.filter((m) => (!only || m.area === only) && m.health && m.health.issues.length)
        .map((m) => `- ${m.name} [${(d.areas.find((x) => x.key === m.area) || { name: "global" }).name}]: ` + m.health.issues.map((i) => i.text).join("; "));
      return rows.length ? rows.join("\n") : "No memory issues found.";
    } },
  { name: "link_memory", description: "Let project `to` read the whole memory of project `from` (adds one marked pointer line to `to`'s MEMORY.md, backup saved first). Only new sessions see it.",
    inputSchema: { type: "object", properties: { from: { type: "string" }, to: { type: "string" }, both_ways: { type: "boolean" } }, required: ["from", "to"] },
    run: ({ from, to, both_ways }) => {
      const d = getData(true), A = findArea(d, from), B = findArea(d, to);
      if (A.key === B.key) throw new Error("pick two different projects");
      if (B.team) throw new Error("team folders are read-only sources");
      const r = [M.linkProjects(A, B.path, BACKUPS, teamRoots(d))];
      if (both_ways && !A.team) r.push(M.linkProjects(B, A.path, BACKUPS, teamRoots(d)));
      data = null;
      return r.map((x, i) => x.already ? "already linked" : `linked (${i ? A.name + " now reads " + B.name : B.name + " now reads " + A.name}) — ${x.index}`).join("\n");
    } },
  { name: "unlink_memory", description: "Remove a memory link previously added by Synapse (only the marked line is removed; backup first).",
    inputSchema: { type: "object", properties: { from: { type: "string" }, to: { type: "string" } }, required: ["from", "to"] },
    run: ({ from, to }) => {
      const d = getData(true), A = findArea(d, from), B = findArea(d, to);
      const r = M.unlink(B.path, A.memIndex, BACKUPS); data = null;
      return r.removed ? `removed: ${B.name} no longer reads ${A.name}` : "no such link";
    } },
];

// ---------------------------------------------------------------- JSON-RPC over stdio
const send = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");
const VERSION = (() => { try { return require("../package.json").version; } catch { return "0"; } })();

// Heartbeat: the Synapse app reads this file to show "connected · used 3 min ago".
// Only times, counts and tool names — never arguments or results.
const STATUS = path.join(DATA_DIR, "mcp-status.json");
const hb = { version: VERSION, pid: process.pid, startedAt: Date.now(), lastSeen: Date.now(), calls: 0, lastTool: null, lastCall: null, client: null };
function beat(extra) {
  Object.assign(hb, extra, { lastSeen: Date.now() });
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(STATUS, JSON.stringify(hb)); } catch {}
}

function handle(req) {
  const { id, method, params } = req;
  if (method === "initialize") {
    beat({ client: params && params.clientInfo ? `${params.clientInfo.name || ""} ${params.clientInfo.version || ""}`.trim() : null });
    return send({ id, result: { protocolVersion: (params && params.protocolVersion) || "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "synapse", version: VERSION } } });
  }
  if (method === "tools/call") beat({ calls: hb.calls + 1, lastTool: params && params.name, lastCall: Date.now() });
  if (method === "ping") return send({ id, result: {} });
  if (method === "tools/list") return send({ id, result: { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) } });
  if (method === "tools/call") {
    const tool = TOOLS.find((t) => t.name === (params && params.name));
    if (!tool) return send({ id, error: { code: -32602, message: "unknown tool" } });
    try { return send({ id, result: { content: [{ type: "text", text: String(tool.run((params && params.arguments) || {})) }] } }); }
    catch (e) { return send({ id, result: { content: [{ type: "text", text: "Error: " + e.message }], isError: true } }); }
  }
  if (id !== undefined && id !== null && !String(method || "").startsWith("notifications/")) send({ id, error: { code: -32601, message: "method not found: " + method } });
}
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk; let i;
  while ((i = buf.indexOf("\n")) >= 0) { const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (!line) continue;
    let req; try { req = JSON.parse(line); } catch { send({ id: null, error: { code: -32700, message: "parse error" } }); continue; }
    handle(req); }
});
