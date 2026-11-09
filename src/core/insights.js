// Suggestions from how you actually work with Claude:
//   - prompts you keep repeating      -> make them a slash command
//   - files Claude keeps re-reading  -> summarize them in a memory note (saves tokens and time)
//   - files edited over and over      -> refactor candidates
// Repetition is counted in times AND distinct days, because one session can run for days.
// Pure functions over scan() data; used by the real scanner and by demo mode.

const TRIVIAL = /^(y|yes|no|ok|okay|go|continue|cont|do it|do it now|yes do it|proceed|thanks|thank you|next|done|fix it|again|retry|try again|go on)[.! ]*$/i;
const normPrompt = (t) => String(t || "").toLowerCase().replace(/<[^>]+>/g, " ").replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
const wordSet = (t) => new Set(t.split(" ").filter((w) => w.length > 2));
const jaccard = (a, b) => { if (!a.size || !b.size) return 0; let n = 0; for (const x of a) if (b.has(x)) n++; return n / (a.size + b.size - n); };

function repeatedPrompts(sessions, { minSessions = 3, max = 12 } = {}) {
  const clusters = [];
  sessions.forEach((s, si) => (s.promptList || []).forEach((p) => {
    const raw = String(p.text || "").trim();
    if (raw.startsWith("<") || /<command-name>|<local-command|\[Request interrupted|^Caveat:/.test(raw)) return;   // slash commands, system text
    const n = normPrompt(raw);
    if (n.length < 12 || n.split(" ").length < 3 || TRIVIAL.test(n) || n.length > 300) return;   // skip "yes", huge pastes, etc.
    const w = wordSet(n);
    let c = clusters.find((c) => c.norm === n || jaccard(c.words, w) >= .75);
    if (!c) clusters.push(c = { norm: n, words: w, text: p.text.trim(), sessions: new Set(), areas: new Set(), count: 0, last: 0 });
    c.count++; c.sessions.add(si); c.areas.add(s.cwd); c.last = Math.max(c.last, p.t || 0);
  }));
  return clusters.filter((c) => c.sessions.size >= minSessions)
    .sort((a, b) => b.sessions.size - a.sessions.size || b.count - a.count).slice(0, max)
    .map((c) => ({ text: c.text.slice(0, 300), count: c.count, sessions: c.sessions.size, areas: [...c.areas], last: c.last }));
}

// per file: how many times, and on how many different days, Claude read / edited it
function fileActivity(sessions, kind) {
  const per = new Map();
  sessions.forEach((s, si) => (s.events || []).forEach((e) => {
    if (e.k !== kind || e.f === undefined) return;
    const o = per.get(e.f) || { n: 0, days: new Set(), sessions: new Set() };
    o.n++; o.days.add(new Date(e.t).toDateString()); o.sessions.add(si); per.set(e.f, o);
  }));
  return per;
}
const shape = (files, sessions) => ([f, o]) => ({ f, area: files[f].area, rel: files[f].rel, times: o.n, days: o.days.size, sessions: o.sessions.size,
  cost: [...o.sessions].reduce((x, si) => x + ((sessions[si].cost || {}).usd || 0), 0) });

// files Claude keeps re-reading (5+ times on 2+ days, or on 3+ days)
function rereadFiles(sessions, files, { max = 10 } = {}) {
  return [...fileActivity(sessions, "read")].filter(([, o]) => (o.n >= 5 && o.days.size >= 2) || o.days.size >= 3)
    .sort((a, b) => b[1].n - a[1].n).slice(0, max).map(shape(files, sessions));
}
// files edited over and over (10+ times, or on 3+ days)
function churnFiles(sessions, files, { max = 10 } = {}) {
  return [...fileActivity(sessions, "edit")].filter(([, o]) => o.n >= 10 || o.days.size >= 3)
    .sort((a, b) => b[1].n - a[1].n).slice(0, max).map(shape(files, sessions));
}

// Mistakes Claude keeps making: the same tool error (same signature) 3+ times in one project,
// and tool calls you keep rejecting. Claude can't see this — each session starts fresh.
function repeatedMistakes(sessions, { minTimes = 3, max = 12 } = {}) {
  const groups = new Map();
  sessions.forEach((s, si) => (s.errors || []).forEach((e) => {
    if (!e.sig || (!e.denied && (e.sig.match(/[a-z]/gi) || []).length < 8)) return;   // "#:#:#" says nothing
    const key = s.cwd + "|" + e.tool + "|" + (e.denied ? "denied:" + e.input.split(/\s+/).slice(0, 2).join(" ") : e.sig);
    let g = groups.get(key);
    if (!g) groups.set(key, g = { area: s.cwd, tool: e.tool, sig: e.sig, denied: e.denied, count: 0, sessions: new Set(), days: new Set(), last: 0, example: e });
    g.count++; g.sessions.add(si); g.days.add(new Date(e.t || 0).toDateString());
    if ((e.t || 0) >= g.last) { g.last = e.t || 0; g.example = e; }
  }));
  return [...groups.values()].filter((g) => g.count >= minTimes)
    .sort((a, b) => b.count - a.count).slice(0, max)
    .map((g) => ({ area: g.area, tool: g.tool, sig: g.sig, denied: g.denied, count: g.count, sessions: g.sessions.size, days: g.days.size, last: g.last,
      input: g.example.input, text: g.example.text }));
}

function suggestions(data) {
  return {
    prompts: repeatedPrompts(data.sessions),
    rereads: rereadFiles(data.sessions, data.files),
    churn: churnFiles(data.sessions, data.files),
    mistakes: repeatedMistakes(data.sessions),
  };
}

module.exports = { suggestions, repeatedPrompts, rereadFiles, churnFiles, repeatedMistakes, normPrompt };
