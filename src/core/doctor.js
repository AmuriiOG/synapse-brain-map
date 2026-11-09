// Memory doctor: one-click fixes for memory health issues.
//
// Every fix is two-phase:  plan(fix) -> list of file changes (shown to the user as a diff)
//                          apply(plan) -> writes them, after backing up every file it touches
//                          undo(token) -> puts every touched file back exactly as it was
// Only files inside Claude's projects folder are ever written (memory notes + MEMORY.md).
// Creating a slash command writes ONE new file in <project>/.claude/commands (never overwrites).
const fs = require("node:fs");
const path = require("node:path");
const C = require("./claude");

const inside = (file, root) => { const r = path.relative(path.resolve(root), path.resolve(file)); return !!r && !r.startsWith("..") && !path.isAbsolute(r); };
const read = (f) => fs.existsSync(f) ? fs.readFileSync(f, "utf8") : null;
const eolOf = (t) => (t && t.includes("\r\n") ? "\r\n" : "\n");
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// closest note names for a broken [[link]] (same project first)
function suggestTargets(brokenName, notes) {
  const a = brokenName.toLowerCase();
  const sim = (b) => { b = b.toLowerCase(); if (a === b) return 1; const A = new Set(a.split(/[-_ ]+/)), B = new Set(b.split(/[-_ ]+/)); let n = 0; for (const x of A) if (B.has(x)) n++; return n / Math.max(A.size, B.size) + (b.includes(a) || a.includes(b) ? .3 : 0); };
  return notes.map((n) => ({ name: n.name, score: sim(n.name) })).filter((x) => x.score > .2).sort((x, y) => y.score - x.score).slice(0, 5).map((x) => x.name);
}

// ---------------------------------------------------------------- planning (no writes)
// fix = { type: "index", note }                      add a missing note to its MEMORY.md
//       { type: "link", note, broken, replacement }  repoint (or unlink, replacement=null) a broken [[link]]
//       { type: "merge", keep, drop, notes }         merge two notes of the same project
//       { type: "command", project, text, name }     save a repeated prompt as a slash command
// note objects come from the scan: { name, file, path, description, body, area } + area { path, memIndex }
function plan(fix) {
  const changes = [];
  const change = (file, after, label) => { const before = read(file); if (before !== after) changes.push({ file, label, before, after }); };

  if (fix.type === "index") {
    const { note, area } = fix, idx = area.memIndex;
    const before = read(idx) || "", eol = eolOf(before);
    const desc = (note.description || note.body.split(/\r?\n/).find((l) => l.trim()) || "").replace(/\s+/g, " ").slice(0, 160);
    const line = `- [${note.name}](${note.file}) — ${desc}`;
    change(idx, (before && !before.endsWith("\n") ? before + eol : before) + line + eol, "add the note to MEMORY.md");
  }

  if (fix.type === "link") {
    const { note, broken, replacement } = fix, before = read(note.path);
    const re = new RegExp("\\[\\[" + esc(broken) + "(\\|[^\\]]*)?\\]\\]", "g");
    change(note.path, before.replace(re, (_m, alias) => replacement ? `[[${replacement}${alias || ""}]]` : (alias ? alias.slice(1) : broken)),
      replacement ? `point [[${broken}]] to [[${replacement}]]` : `turn [[${broken}]] into plain text`);
  }

  if (fix.type === "merge") {
    const { keep, drop, area, notes } = fix;
    if (keep.area !== drop.area) throw new Error("only notes of the same project can be merged");
    const kb = read(keep.path), db = read(drop.path), eol = eolOf(kb);
    const dropBody = db.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim();
    change(keep.path, kb.replace(/\s*$/, "") + eol + eol + `## Merged from ${drop.name}` + eol + eol + dropBody + eol, `append "${drop.name}" to "${keep.name}"`);
    changes.push({ file: drop.path, label: `delete "${drop.name}" (kept in the backup)`, before: db, after: null });
    const idx = read(area.memIndex);
    if (idx !== null) {
      const ie = eolOf(idx), lines = idx.split(/\r?\n/);
      const kept = lines.filter((l) => !l.includes("(" + drop.file + ")"));
      if (kept.length !== lines.length) change(area.memIndex, kept.join(ie), `remove "${drop.name}" from MEMORY.md`);
    }
    for (const n of notes) {      // other notes that link to the dropped one now link to the kept one
      if (n.path === keep.path || n.path === drop.path || n.kind !== "memory") continue;
      const t = read(n.path); if (!t) continue;
      const re = new RegExp("\\[\\[" + esc(drop.name) + "(\\|[^\\]]*)?\\]\\]", "g");
      if (re.test(t)) change(n.path, t.replace(re, (_m, alias) => `[[${keep.name}${alias || ""}]]`), `relink [[${drop.name}]] → [[${keep.name}]] in "${n.name}"`);
    }
  }

  if (fix.type === "command") {
    const slug = String(fix.name || "").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
    if (!slug) throw new Error("give the command a name");
    const dir = fix.project ? path.join(fix.project.path, ".claude", "commands") : path.join(C.CLAUDE_HOME, "commands");
    const file = path.join(dir, slug + ".md");
    if (fs.existsSync(file)) throw new Error(`/${slug} already exists (${file})`);
    const desc = fix.text.replace(/\s+/g, " ").slice(0, 90);
    changes.push({ file, label: `create the slash command /${slug}`, before: null, after: `---\ndescription: ${desc}\n---\n\n${fix.text.trim()}\n` });
  }
  return { fix: fix.type, changes };
}

// ---------------------------------------------------------------- apply + undo
function allowed(file, extraRoots = []) {
  if (inside(file, C.PROJECTS)) return true;                                          // memory notes, MEMORY.md
  if (/[\\/]\.claude[\\/]commands[\\/][^\\/]+\.md$/.test(file) && extraRoots.some((r) => inside(file, r))) return true;   // new slash commands
  if (inside(file, path.join(C.CLAUDE_HOME, "commands"))) return true;
  return false;
}

function apply(p, backupDir, extraRoots = []) {
  if (!p.changes.length) return { applied: 0, undo: [] };
  for (const ch of p.changes) if (!allowed(ch.file, extraRoots)) throw new Error("refusing to write outside Claude's folders: " + ch.file);
  // check nothing changed since the preview
  for (const ch of p.changes) if (read(ch.file) !== ch.before) throw new Error(path.basename(ch.file) + " changed since the preview — open the fix again");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-"), dir = path.join(backupDir, "doctor-" + stamp);
  fs.mkdirSync(dir, { recursive: true });
  const undo = [];
  p.changes.forEach((ch, i) => {
    const bak = ch.before === null ? null : path.join(dir, i + "-" + path.basename(ch.file));
    if (bak) fs.writeFileSync(bak, ch.before);
    undo.push({ file: ch.file, backup: bak });
    if (ch.after === null) fs.unlinkSync(ch.file);
    else { fs.mkdirSync(path.dirname(ch.file), { recursive: true }); fs.writeFileSync(ch.file, ch.after); }
  });
  fs.writeFileSync(path.join(dir, "undo.json"), JSON.stringify(undo, null, 2));
  return { applied: p.changes.length, undo, backupDir: dir };
}

function undo(list, extraRoots = []) {
  for (const u of list) if (!allowed(u.file, extraRoots)) throw new Error("refusing to touch " + u.file);
  for (const u of list) {
    if (u.backup) { fs.mkdirSync(path.dirname(u.file), { recursive: true }); fs.copyFileSync(u.backup, u.file); }
    else if (fs.existsSync(u.file)) fs.unlinkSync(u.file);              // the fix created it
  }
  return { restored: list.length };
}

module.exports = { plan, apply, undo, suggestTargets };
