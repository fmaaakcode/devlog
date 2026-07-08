// Shared mutable dashboard state (R3 #3 — ES modules conversion).
//
// These used to be bare `let`s in whichever classic script declared them,
// silently shared through the page's single global scope; a load-order slip
// or a renamed identifier failed as a swallowed TypeError. As module exports
// the reads are live bindings (importers always see the latest value), and
// because imported bindings are read-only, every WRITE from another module
// must go through the setter next to the variable — which is exactly the
// explicit contract this refactor exists to create.
export let data = { projects: {}, events: [], tags: [], plans: [], worklog: [] };
export function setData(v) { data = v; }

export let activeProject = null;
export function setActiveProject(v) { activeProject = v; }

// Header DOM built once per selected project; false forces a rebuild.
export let headerBuilt = false;
export function setHeaderBuilt(v) { headerBuilt = v; }

// Last rendered file tree; null forces a re-render on the next paint.
export let cachedTree = null;
export function setCachedTree(v) { cachedTree = v; }

export let logFilter = "all";
export function setLogFilterValue(v) { logFilter = v; }

export let showCompletedPlans = false;
export function setShowCompletedPlans(v) { showCompletedPlans = v; }

// الحالية/القادمة tabs on the tasks + plans cards ('current' | 'upcoming').
export let todosTab = "current";
export function setTodosTab(v) { todosTab = v; }
export let plansTab = "current";
export function setPlansTab(v) { plansTab = v; }

// One full render is pending (project switch / WS reset); cleared after paint.
export let fullRenderNeeded = true;
export function setFullRenderNeeded(v) { fullRenderNeeded = v; }

// Hash of the last /api/data payload — skips no-op re-renders.
export let lastDataHash = "";
export function setLastDataHash(v) { lastDataHash = v; }

// File-tree context-menu target (set on right-click, read by the actions).
export let ctxTargetPath = "";
export let ctxTargetFile = "";
export function setCtxTarget(path, file) { ctxTargetPath = path; ctxTargetFile = file; }
