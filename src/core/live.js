// Live mode: watch Claude Code's session logs and emit an event for every new line that matters
// (a file read/edited by a tool, a new prompt). Only the newly appended bytes are read.
//
// It also notices things a single Claude session can't see:
//   "turn-end"      Claude finished its turn (assistant stop_reason "end_turn")  -> reliable
//   "tool-waiting"  a tool call has had no result for WAIT_MS. Usually a permission prompt,
//                   sometimes just a long-running command -> worded as "may be waiting"
//   "conflict"      two different sessions edited the same file within CONFLICT_MS
//   "stuck"         one session looks stuck: the same file edited over and over, the same error
//                   again and again, many errors, or cost rising fast
const fs = require("node:fs");
const path = require("node:path");
const C = require("./claude");

const EDIT_TOOLS = /^(Edit|Write|MultiEdit|NotebookEdit)$/;
const num = (k, d) => Number(process.env[k] || d);
const WAIT_MS = num("SYNAPSE_WAIT_MS", 25000);
const CONFLICT_MS = num("SYNAPSE_CONFLICT_MS", 15 * 60e3);
const STUCK_WINDOW = num("SYNAPSE_STUCK_WINDOW_MS", 10 * 60e3);
const DEFAULTS = { stuckEdits: 8, stuckSameError: 4, stuckErrors: 8, stuckUsd: 10 };

function createLive(onEvents, log = () => {}, opts = {}) {
  const limits = { ...DEFAULTS, ...opts };
  const offsets = new Map(), tails = new Map(), timers = new Map();
  const pending = new Map();          // session -> Map(tool_use_id -> { t, tool, cwd, alerted })
  const S = new Map();                // session -> { tools, edits: [{p,t}], errors: [{sig,t,tool}], costs: [{usd,t}] }
  const fileEdits = new Map();        // file -> [{ session, cwd, t }]
  const throttle = new Map();         // key -> last time emitted
  let watcher = null, checker = null;
  const pendingFor = (sid) => { let m = pending.get(sid); if (!m) pending.set(sid, m = new Map()); return m; };
  const state = (sid) => { let s = S.get(sid); if (!s) S.set(sid, s = { tools: new Map(), edits: [], errors: [], costs: [] }); return s; };
  const once = (key, ms) => { const now = Date.now(); if (now - (throttle.get(key) || 0) < ms) return false; throttle.set(key, now); return true; };
  const recent = (arr, ms, now) => { while (arr.length && now - arr[0].t > ms) arr.shift(); return arr; };

  // start from the current end of every log, so only NEW activity is reported
  const prime = () => {
    for (const pd of C.listProjectDirs()) for (const f of C.listSessionFiles(pd.dir)) { try { offsets.set(f, fs.statSync(f).size); } catch {} }
  };

  function analyse(session, cwd, events) {
    const now = Date.now(), st = state(session);
    // conflict: another session edited the same file recently
    for (const e of events) {
      if (e.type !== "touch" || e.k !== "edit") continue;
      const list = recent(fileEdits.get(e.p) || [], CONFLICT_MS, now);
      const other = list.filter((x) => x.session !== session).pop();
      list.push({ session, cwd, t: now }); fileEdits.set(e.p, list);
      if (other && once("conflict|" + e.p + "|" + [session, other.session].sort().join(), CONFLICT_MS))
        events.push({ type: "conflict", session, cwd, t: now, p: e.p, other: other.session, otherCwd: other.cwd, ago: now - other.t });
    }
    // stuck: look at this session's last few minutes
    const edits = recent(st.edits, STUCK_WINDOW, now), errors = recent(st.errors, STUCK_WINDOW, now), costs = recent(st.costs, STUCK_WINDOW * 1.5, now);
    const stuck = (reason, detail) => { if (once("stuck|" + session + "|" + reason, 20 * 60e3)) events.push({ type: "stuck", session, cwd, t: now, reason, detail }); };
    const perFile = {}; for (const x of edits) perFile[x.p] = (perFile[x.p] || 0) + 1;
    const hot = Object.entries(perFile).sort((a, b) => b[1] - a[1])[0];
    if (hot && hot[1] >= limits.stuckEdits) stuck("edit-loop", { p: hot[0], times: hot[1], minutes: Math.round(STUCK_WINDOW / 60e3) });
    const perSig = {}; for (const x of errors) perSig[x.sig] = (perSig[x.sig] || 0) + 1;
    const rep = Object.entries(perSig).sort((a, b) => b[1] - a[1])[0];
    if (rep && rep[1] >= limits.stuckSameError) stuck("same-error", { sig: rep[0], times: rep[1], tool: (errors.find((x) => x.sig === rep[0]) || {}).tool });
    else if (errors.length >= limits.stuckErrors) stuck("many-errors", { times: errors.length });
    if (costs.length >= 2 && costs[costs.length - 1].usd - costs[0].usd >= limits.stuckUsd)
      stuck("cost-burn", { usd: costs[costs.length - 1].usd - costs[0].usd, minutes: Math.round((costs[costs.length - 1].t - costs[0].t) / 60e3) || 1 });
  }

  const readNew = (file) => {
    let st; try { st = fs.statSync(file); } catch { return; }
    const from = offsets.has(file) ? offsets.get(file) : 0;      // a brand-new session log is read from the start
    if (st.size <= from) { offsets.set(file, st.size); return; }
    const fd = fs.openSync(file, "r"), buf = Buffer.alloc(Math.min(st.size - from, 4 * 1024 * 1024));
    try { fs.readSync(fd, buf, 0, buf.length, from); } finally { fs.closeSync(fd); }
    offsets.set(file, from + buf.length);
    const text = (tails.get(file) || "") + buf.toString("utf8");
    const lines = text.split("\n"); tails.set(file, lines.pop());  // keep an incomplete last line for next time
    const session = path.basename(file, ".jsonl").slice(0, 8), events = [], s = state(session);
    let cwdSeen = null;
    for (const line of lines) {
      let j; try { j = JSON.parse(line); } catch { continue; }
      const t = j.timestamp ? Date.parse(j.timestamp) : Date.now(), cwd = j.cwd ? C.norm(j.cwd) : null;
      if (cwd) cwdSeen = cwd;
      if (j.type === "cost-state" && typeof j.totalCostUSD === "number") s.costs.push({ usd: j.totalCostUSD, t: Date.now() });
      if (j.type === "user" && j.message && typeof j.message.content === "string" && !j.isMeta) { events.push({ type: "prompt", session, cwd, t, text: j.message.content.slice(0, 140) }); pendingFor(session).clear(); }
      const content = j.message && Array.isArray(j.message.content) ? j.message.content : [];
      if (j.type === "assistant" && j.message && j.message.stop_reason === "end_turn") {
        const said = content.filter((c) => c.type === "text").map((c) => c.text).join(" ").replace(/\s+/g, " ").trim();
        events.push({ type: "turn-end", session, cwd, t, text: said.slice(0, 160) }); pendingFor(session).clear();
      }
      for (const c of content) {
        if (c.type === "tool_result" && c.tool_use_id) {
          pendingFor(session).delete(c.tool_use_id);
          if (c.is_error) { const txt = C.resultText(c); s.errors.push({ sig: C.errorSignature(txt), tool: (s.tools.get(c.tool_use_id) || "?"), t: Date.now(), denied: C.isDenied(txt) }); }
        }
        if (c.type === "tool_use" && c.id) { pendingFor(session).set(c.id, { t: Date.now(), tool: c.name, cwd, alerted: false }); s.tools.set(c.id, c.name); }
        if (c.type === "tool_use" && c.input) {
          const p = c.input.file_path || c.input.notebook_path;
          if (p) {
            const k = EDIT_TOOLS.test(c.name) ? "edit" : "read";
            events.push({ type: "touch", session, cwd, t, p: C.norm(p), k, tool: c.name });
            if (k === "edit") s.edits.push({ p: C.norm(p), t: Date.now() });
          } else events.push({ type: "tool", session, cwd, t, tool: c.name });
        }
      }
    }
    if (s.tools.size > 2000) s.tools.clear();
    analyse(session, cwdSeen, events);
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
        // tool calls without a result for a while -> the session may be waiting for a permission
        checker = setInterval(() => {
          const out = [], now = Date.now();
          for (const [session, m] of pending) for (const [id, p] of m) {
            if (!p.alerted && now - p.t > WAIT_MS) { p.alerted = true; out.push({ type: "tool-waiting", session, cwd: p.cwd, t: now, tool: p.tool, since: p.t }); }
            if (now - p.t > 6 * 3600e3) m.delete(id);
          }
          if (out.length) onEvents(out);
        }, 3000);
        return true;
      } catch (e) { log("live mode unavailable: " + e.message); watcher = null; return false; }
    },
    stop() { if (watcher) watcher.close(); watcher = null; clearInterval(checker); checker = null; for (const t of timers.values()) clearTimeout(t); timers.clear(); },
    setLimits(o) { Object.assign(limits, o || {}); },
    get running() { return !!watcher; },
  };
}

module.exports = { createLive, DEFAULTS };
