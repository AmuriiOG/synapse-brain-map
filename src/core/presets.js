// Folders skipped while walking a project, grouped by ecosystem. Users pick presets in Settings
// and can add their own names. Hidden folders (".git", ".idea", ...) are always skipped.
const PRESETS = {
  general: { label: "General", dirs: ["node_modules", "dist", "build", "out", "bin", "obj", "tmp", "temp", "logs", "coverage", "vendor"] },
  unity:   { label: "Unity", dirs: ["Library", "Temp", "Logs", "obj", "Build", "Builds", "UserSettings", "MemoryCaptures", "Captures", "Packages", "Plugins",
             "StorePackages", "TextMesh Pro", "Editor Default Resources", "ExternalDependencyManager", "AppsFlyer", "Firebase", "GoogleMobileAds"] },
  node:    { label: "Node / Web", dirs: ["node_modules", "dist", "build", ".next", ".nuxt", ".svelte-kit", ".turbo", ".cache", "coverage", "storybook-static"] },
  python:  { label: "Python", dirs: ["__pycache__", "venv", ".venv", "env", ".tox", ".mypy_cache", ".pytest_cache", "site-packages", "build", "dist", "*.egg-info"] },
  mobile:  { label: "Android / iOS", dirs: ["build", ".gradle", "Pods", "DerivedData", "intermediates", "generated"] },
  rust_go: { label: "Rust / Go / Java", dirs: ["target", "vendor", ".gradle", "out"] },
  unreal:  { label: "Unreal / Godot", dirs: ["Binaries", "Intermediate", "Saved", "DerivedDataCache", ".godot", ".import"] },
};
const SKIP_EXT = [".meta", ".csproj", ".sln", ".DotSettings", ".tmp", ".log", ".pyc", ".class", ".o", ".obj"];

const DEFAULT_CONFIG = {
  days: 60,                     // how far back sessions, files and commits are shown
  presets: ["general", "unity", "node", "python"],
  skipDirs: [],                 // extra folder names to skip
  extraRoots: [],               // folders to show even without Claude sessions
  skipRoots: [],                // project names to hide
  maxFilesPerProject: 4000,
  alerts: true,                 // desktop notification when a session needs you (live mode)
};

function skipDirsFor(cfg) {
  const set = new Set(cfg.skipDirs || []);
  for (const p of cfg.presets || []) for (const d of (PRESETS[p] || { dirs: [] }).dirs) set.add(d);
  const globs = [...set].filter((d) => d.includes("*")).map((d) => new RegExp("^" + d.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$", "i"));
  return { has: (name) => set.has(name) || globs.some((r) => r.test(name)) };
}

module.exports = { PRESETS, SKIP_EXT, DEFAULT_CONFIG, skipDirsFor };
