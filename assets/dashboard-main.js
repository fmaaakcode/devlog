// Dashboard entry point (R3 #3). The five topical files are ES modules now —
// import order here is only a hint; the real order is the dependency graph,
// and every cross-file reference is an explicit import that fails LOUDLY at
// load instead of a swallowed TypeError at click time (the old classic-script
// failure mode). Shared mutable state lives in dashboard-state.js.
import "./dashboard-core.js";
import "./dashboard-data.js";
import "./dashboard-project.js";
import "./dashboard-panels.js";
import { initDashboard } from "./dashboard-tree-ws.js";

// Startup (initial fetch + WS connect + polling timers) runs only after the
// entire module graph has evaluated — inside the graph a cycle-order call can
// hit another module's `const` in its TDZ (that exact bug shipped and died
// during this conversion: a blank page with a clean console).
initDashboard();
