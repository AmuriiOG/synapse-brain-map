// Claude Code memory: where it lives, how to read it, and how the app links it between projects.
//
// Memory is per project folder: ~/.claude/projects/<encoded project path>/memory/
//   MEMORY.md      index, loaded into every new session in that project
//   <note>.md      one fact per file (frontmatter: name, description, metadata.type)
//
// Linking = the app appends ONE marked line to the target project's MEMORY.md that points at
// the other project's MEMORY.md (or at a single note). New sessions in the target project see the
// pointer and can read it. Unlinking removes exactly the lines carrying the marker; nothing else
// in the file is touched. Every write is preceded by a timestamped backup.
const fs = require("node:fs");
const path = require("node:path");

const C = require("./claude");
const { encode, memDirFor, norm, decodeProjectDir, parseNote } = C;
const CLAUDE_PROJECTS = C.PROJECTS;
const fwd = (p) => path.resolve(p).replace(/\\/g, "/");

// lines written by the app carry a marker so they can be found and removed again.
// "aios:" is the marker of early builds; it is still recognised so old links keep working.
const MARK_LINK = "<!-- synapse:link -->";
const MARK_SHARE = "<!-- synapse:share -->";
const isLink = (l) => l.includes(MARK_LINK) || l.includes("<!-- aios:link -->");
const isShare = (l) => l.includes(MARK_SHARE) || l.includes("<!-- aios:share -->");

// Read the marked lines the app wrote into a MEMORY.md
function parseMarks(indexFile) {
  let txt; try { txt = fs.readFileSync(indexFile, "utf8"); } catch { return []; }
  const out = [];
  for (const line of txt.split(/\r?\n/)) {
    const kind = isLink(line) ? "link" : isShare(line) ? "share" : null;
    if (!kind) continue;
    const m = /\]\(([^)]+)\)/.exec(line);
    if (m) out.push({ kind, target: norm(m[1]) });
  }
  return out;
}

// ---------- write side (used by the Electron main process) ----------
const inside = (file, root) => { const rel = path.relative(path.resolve(root), path.resolve(file)); return !!rel && !rel.startsWith("..") && !path.isAbsolute(rel); };
function assertInside(file, root) { if (!inside(file, root)) throw new Error("refusing to touch a file outside " + root); }
// link SOURCES may also live in a team memory folder the user configured; WRITES never leave ~/.claude/projects
function assertReadable(file, teamRoots = []) {
  if (inside(file, CLAUDE_PROJECTS) || teamRoots.some((r) => inside(file, r))) return;
  throw new Error("refusing to link a file outside Claude's projects folder or your team memory folders");
}

function backup(file, backupDir) {
  if (!fs.existsSync(file)) return null;
  fs.mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dest = path.join(backupDir, path.basename(path.dirname(path.dirname(file))) + "--MEMORY--" + stamp + ".md");
  fs.copyFileSync(file, dest);
  return dest;
}

function appendLine(projectPath, line, target, backupDir) {
  const dir = memDirFor(projectPath), index = path.join(dir, "MEMORY.md");
  assertInside(index, CLAUDE_PROJECTS);
  if (parseMarks(index).some((m) => m.target === norm(target))) return { ok: true, already: true, index };
  const bak = backup(index, backupDir);
  fs.mkdirSync(dir, { recursive: true });
  let txt = fs.existsSync(index) ? fs.readFileSync(index, "utf8") : "";
  const eol = txt.includes("\r\n") ? "\r\n" : "\n";
  if (txt && !txt.endsWith("\n")) txt += eol;
  fs.writeFileSync(index, txt + line + eol);
  return { ok: true, index, backup: bak };
}

// Let project `toPath` read the whole memory of `from` (a project, or a team memory folder)
//   from = { name, path, memIndex, team }
function linkProjects(from, toPath, backupDir, teamRoots = []) {
  const target = from.memIndex || path.join(memDirFor(from.path), "MEMORY.md");
  assertReadable(target, teamRoots);
  if (!fs.existsSync(target)) throw new Error(from.name + " has no memory yet (no MEMORY.md)");
  const what = from.team ? `shared team memory "${from.name}"` : `memory index of the ${from.name} project (${fwd(from.path)})`;
  const line = `- [Linked memory: ${from.name}](${fwd(target)}) — ${what}; read it when the task touches ${from.name} or code shared with it ${MARK_LINK}`;
  return appendLine(toPath, line, target, backupDir);
}

// Share ONE note with project `toPath`
function shareNote(notePath, fromName, toPath, backupDir, teamRoots = []) {
  assertReadable(notePath, teamRoots);
  if (!fs.existsSync(notePath) || !notePath.endsWith(".md")) throw new Error("note not found");
  const n = parseNote(notePath);
  const desc = (n.description || n.body.split("\n")[0] || "").replace(/\s+/g, " ").slice(0, 160);
  const line = `- [${n.name} (from ${fromName})](${fwd(notePath)}) — ${desc} ${MARK_SHARE}`;
  return appendLine(toPath, line, notePath, backupDir);
}

// Remove the marked line(s) in `toPath`'s MEMORY.md that point at `target`
function unlink(toPath, target, backupDir) {
  const index = path.join(memDirFor(toPath), "MEMORY.md");
  assertInside(index, CLAUDE_PROJECTS);
  if (!fs.existsSync(index)) return { ok: true, removed: 0 };
  const txt = fs.readFileSync(index, "utf8"), t = norm(target);
  const eol = txt.includes("\r\n") ? "\r\n" : "\n";
  const lines = txt.split(/\r?\n/);
  const keep = lines.filter((l) => {
    if (!isLink(l) && !isShare(l)) return true;
    const m = /\]\(([^)]+)\)/.exec(l);
    return !(m && norm(m[1]) === t);
  });
  const removed = lines.length - keep.length;
  if (!removed) return { ok: true, removed: 0 };
  const bak = backup(index, backupDir);
  fs.writeFileSync(index, keep.join(eol));
  return { ok: true, removed, backup: bak };
}

module.exports = { CLAUDE_PROJECTS, MARK_LINK, MARK_SHARE, encode, memDirFor, norm, decodeProjectDir, parseNote, parseMarks, linkProjects, shareNote, unlink };
