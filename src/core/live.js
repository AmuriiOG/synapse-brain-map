// Live mode: watch Claude Code's session logs and emit an event for every new line that matters
// (a file read/edited by a tool, a new prompt). Only the newly appended bytes are read.
const fs = require("node:fs");
const path = require("node:path");
const C = require("./claude");

const EDIT_TOOLS = /^(Edit|Write|MultiEdit|NotebookEdit)$/;

function createLive(onEvents, log = () => {}) {
  const offsets = new Map(), tails = new Map(), timers = new Map();
  let watcher = null;

  // start from the current end of every log, so only NEW activity is reported
  const prime = () => {
    for (const pd of C.listProjectDirs()) for (const f of C.listSessionFiles(pd.dir)) { try { offsets.set(f, fs.statSync(f).size); } catch {} }
  };

  const readNew = (file) => {
    let st; try { st = fs.statSync(file); } catch { return; }
    const from = offsets.has(file) ? offsets.get(file) : 0;      // a brand-new session log is read from the start
    if (st.size <= from) { offsets.set(file, st.size); return; }
    const fd = fs.openSync(file, "r"), buf = Buffer.alloc(Math.min(st.size - from, 4 * 1024 * 1024));
    try { fs.readSync(fd, buf, 0, buf.length, from); } finally { fs.closeSync(fd); }
    offsets.set(file, from + buf.length);
    const text = (tails.get(file) || "") + buf.toString("utf8");
    const lines = text.split("\n"); tails.set(file, lines.pop());  // keep an incomplete last line for next time
    const session = path.basename(file, ".jsonl").slice(0, 8), events = [];
    for (const line of lines) {
      let j; try { j = JSON.parse(line); } catch { continue; }
      const t = j.timestamp ? Date.parse(j.timestamp) : Date.now(), cwd = j.cwd ? C.norm(j.cwd) : null;
      if (j.type === "user" && j.message && typeof j.message.content === "string" && !j.isMeta) events.push({ type: "prompt", session, cwd, t, text: j.message.content.slice(0, 140) });
      const content = j.message && Array.isArray(j.message.content) ? j.message.content : [];
      for (const c of content) {
        if (c.type === "tool_use" && c.input) {
          const p = c.input.file_path || c.input.notebook_path;
          if (p) events.push({ type: "touch", session, cwd, t, p: C.norm(p), k: EDIT_TOOLS.test(c.name) ? "edit" : "read", tool: c.name });
          else events.push({ type: "tool", session, cwd, t, tool: c.name });
        }
      }
    }
    if (events.length) onEvents(events);
  };

  const schedule = (file) => {            // coalesce bursts of writes
    clearTimeout(timers.get(file));
    timers.set(file, setTimeout(() => { timers.delete(file); try { readNew(file); } catch (e) { log("live read failed: " + e.message); } }, 120));
  };

  return {
    start() {
      if (watcher) return true;
      prime();
      try {
        watcher = fs.watch(C.PROJECTS, { recursive: true }, (_ev, rel) => { if (rel && String(rel).endsWith(".jsonl")) schedule(path.join(C.PROJECTS, String(rel))); });
        watcher.on("error", (e) => log("live watcher error: " + e.message));
        return true;
      } catch (e) { log("live mode unavailable: " + e.message); watcher = null; return false; }
    },
    stop() { if (watcher) watcher.close(); watcher = null; for (const t of timers.values()) clearTimeout(t); timers.clear(); },
    get running() { return !!watcher; },
  };
}

module.exports = { createLive };
