const params = new URLSearchParams(location.search);
const project = params.get('project');
const canvas = document.getElementById('map');
const ctx = canvas.getContext('2d');
const statusEl = document.getElementById('status');
const tooltip = document.getElementById('tooltip');
const titleEl = document.getElementById('title');

if (project) {
  titleEl.textContent = `Stack Map — ${project}`;
  document.title = `Stack Map — ${project}`;
}

// Visual channels are separated on purpose: hue = cluster, size = importance,
// glow = activity. CLUSTER_SLOTS is a fixed categorical order validated for
// CVD against the #161718 surface (worst adjacent ΔE 23.7); slots are assigned
// to cluster names alphabetically so colors survive rescans, extras fold into
// neutral gray. Activity is a state, not a series: status-green, deliberately
// far from every cluster hue (the old gold glow was byte-identical to the
// importance-3 border, so "important" and "recently active" looked the same).
const CLUSTER_SLOTS = ['#3987e5', '#199e70', '#c98500', '#9085e9', '#e66767', '#d55181', '#d95926'];
const CLUSTER_OTHER = '#6a6b6d';
const ACT_RGB = '12,163,12';
const ACT_HEX = '#0ca30c';

let nodes = [];
let edges = [];
let clusters = new Map();
let clusterColors = new Map();
let clusterCenters = new Map();
let adjacency = new Map();
let simNodes = [];
let railBox = null;
let graphDepths = new Map();
let dragging = null;
const dragOffset = { x: 0, y: 0 };
let dragMoved = false;
let hovered = null;
let simRunning = false;
let centered = false;
let settleTicks = 0;
let projectPath = null;
let savedPositions = null;
let saveTimer = null;
let entryPoints = [];
// ?mode= deep-links a layout (and skips any saved positions — an explicit
// mode in the URL means "show me that layout", not "show what I dragged").
const modeForced = ['radial', 'force', 'layered'].includes(params.get('mode'));
let layoutMode = modeForced ? params.get('mode') : 'radial';
let showActivity = true;
let projectTags = [];
const view = { x: 0, y: 0, k: 1 };
let panning = false;
let panStart = null;
let panScreen = null;
let panMoved = false;
// Click-to-isolate (#388): focusSet pins the clicked node's neighborhood and
// everything else dims. Esc or a click on empty space exits.
let focusRoot = null;
let focusSet = null;
// Header search (#390): matching nodes glow gold; Enter centers the best one.
let searchMatches = new Set();
// Mid-zoom labels (#389): top of the importance pyramid, capped so a flat
// project can't flood the dot view. Rebuilt with the graph.
let dotLabelSet = new Set();
// Semantic zoom (#389) thresholds on view.k: below DOTS_K nodes render as
// colored dots sized by importance; between the two, important files get
// screen-fixed labels under their dot; above NAMES_K, full boxes.
const DOTS_K = 0.35;
const NAMES_K = 0.65;

function resize() {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
window.addEventListener('resize', () => { resize(); render(); });
resize();

function normalize(name) {
  return name.replace(/^.*\//, '').replace(/\.[^.]+$/, '');
}

// Semantic clusters: filename-token families beat raw directories when a
// project keeps most files flat in src/ (helper: 20/29). A first-token family
// (routes-*, doc-*) needs ≥2 members in the same directory to count; otherwise
// the file falls back to its directory ('root' for top-level non-UI files).
function buildGroupIndex(paths) {
  const meta = paths.map(p => {
    const dir = p.includes('/') ? p.slice(0, p.indexOf('/')) : '';
    const base = p.slice(p.lastIndexOf('/') + 1);
    const ext = base.slice(base.lastIndexOf('.') + 1).toLowerCase();
    const token = base.includes('-') ? base.slice(0, base.indexOf('-')) : '';
    return { p, dir, ext, token };
  });
  const famCount = new Map();
  for (const m of meta) {
    if (!m.token) continue;
    const k = `${m.dir}|${m.token}`;
    famCount.set(k, (famCount.get(k) || 0) + 1);
  }
  const groups = new Map();
  for (const m of meta) {
    if (m.ext === 'html' || m.ext === 'css') groups.set(m.p, 'ui');
    else if (m.dir && m.dir !== 'src') groups.set(m.p, m.dir);
    else if (m.token && famCount.get(`${m.dir}|${m.token}`) >= 2) groups.set(m.p, m.token);
    else groups.set(m.p, m.dir || 'root');
  }
  return groups;
}

// Importance is encoded by size alone (three tiers, spread wide enough to
// read at a glance now that color no longer helps).
function sizeFor(importance) {
  if (importance >= 3) return { w: 150, h: 58, font: 13, sub: 11 };
  if (importance === 2) return { w: 116, h: 46, font: 12, sub: 10 };
  return { w: 92, h: 38, font: 11, sub: 10 };
}

function nodeColors(n, dim) {
  const alpha = dim ? '55' : 'ff';
  const hue = clusterColors.get(n.group) || CLUSTER_OTHER;
  return { border: hue + alpha, bg: `#1B1C1D${alpha}`, text: `#EEEEEE${alpha}` };
}

// BFS from the entry points; nodes the walk never reaches live in the side
// rail. Reachability is the predicate — NOT in-degree-zero, which happens to
// produce the same set today but breaks the first time one disconnected node
// points at another (reachability is transitive, the degree shortcut isn't).
function computeReach() {
  const outgoing = new Map(nodes.map(n => [n, []]));
  for (const e of edges) outgoing.get(e.source).push(e.target);
  const roots = nodes.filter(n => entryPoints.includes(n.id));
  const sources = nodes.filter(n => !edges.some(e => e.target === n) && edges.some(e => e.source === n));
  // No entry points AND no in-degree-0 sources → a cyclic "top" with no natural
  // start. Seeding from a single arbitrary node then strands every node the BFS
  // can't reach in the side rail — most of the graph (#403). In that degenerate
  // case only, keep the unreached nodes in the LAYOUT at maxD+1 instead of exiling
  // them; the normal case still rails genuine isolates.
  const degenerate = !roots.length && !sources.length;
  const seeds = roots.length ? roots : (sources.length ? sources : nodes.slice(0, 1));
  const depth = new Map();
  const queue = [];
  for (const s of seeds) {
    depth.set(s, 0);
    queue.push(s);
  }
  while (queue.length) {
    const n = queue.shift();
    const d = depth.get(n);
    for (const m of outgoing.get(n)) {
      if (!depth.has(m)) {
        depth.set(m, d + 1);
        queue.push(m);
      }
    }
  }
  if (degenerate) {
    // A cyclic top has no TRUE isolates — everything belongs in the diagram.
    // Park each still-unreached node one layer past the deepest reached one.
    let maxD = 0;
    for (const d of depth.values()) if (d > maxD) maxD = d;
    for (const n of nodes) if (!depth.has(n)) depth.set(n, maxD + 1);
  }
  return depth;
}

function layerize() {
  const byDepth = new Map();
  for (const n of simNodes) {
    const d = graphDepths.get(n) ?? 0;
    if (!byDepth.has(d)) byDepth.set(d, []);
    byDepth.get(d).push(n);
  }
  return [...byDepth.keys()].sort((a, b) => a - b).map(d => byDepth.get(d));
}

// Sugiyama's missing step: alternating down/up barycenter sweeps reorder each
// layer by the mean fractional position of its neighbors on the side the
// sweep came from. Nodes with no reference neighbor hold their slot; ties
// break on the previous index, so the whole pass is deterministic (the
// initial order is importance desc, then label).
function minimizeCrossings(layers) {
  const li = new Map();
  const idx = new Map();
  layers.forEach((layer, i) => {
    layer.sort((a, b) => b.importance - a.importance || a.label.localeCompare(b.label));
    layer.forEach((n, j) => { li.set(n, i); idx.set(n, j); });
  });
  const nbrs = new Map(simNodes.map(n => [n, []]));
  for (const e of edges) {
    if (!li.has(e.source) || !li.has(e.target)) continue;
    nbrs.get(e.source).push(e.target);
    nbrs.get(e.target).push(e.source);
  }
  const frac = n => layers[li.get(n)].length < 2 ? 0.5 : idx.get(n) / (layers[li.get(n)].length - 1);
  for (let s = 0; s < 8; s++) {
    const down = s % 2 === 0;
    for (let k = 0; k < layers.length; k++) {
      const i = down ? k : layers.length - 1 - k;
      const layer = layers[i];
      const bary = new Map(layer.map(n => {
        const ref = nbrs.get(n).filter(m => (down ? li.get(m) < i : li.get(m) > i));
        return [n, ref.length ? ref.reduce((sum, m) => sum + frac(m), 0) / ref.length : frac(n)];
      }));
      layer.sort((a, b) => bary.get(a) - bary.get(b) || idx.get(a) - idx.get(b));
      layer.forEach((n, j) => { idx.set(n, j); });
    }
  }
}

function layoutLayered() {
  const rect = canvas.getBoundingClientRect();
  const layers = layerize();
  minimizeCrossings(layers);
  const topPad = 70;
  const botPad = 40;
  const stepY = layers.length > 1 ? (rect.height - topPad - botPad) / (layers.length - 1) : 0;
  layers.forEach((layer, i) => {
    const y = topPad + i * stepY;
    // A row of boxes needs its own width: never squeeze below avg box + gap,
    // fitView zooms out to cover rows wider than the canvas.
    const avgW = layer.reduce((s, n) => s + n.w, 0) / layer.length;
    const stepX = Math.max(rect.width / (layer.length + 1), avgW + 34);
    const x0 = rect.width / 2 - (stepX * (layer.length + 1)) / 2;
    layer.forEach((n, j) => {
      n.tx = x0 + stepX * (j + 1);
      n.ty = y;
      n.x = n.tx;
      n.y = n.ty;
      n.vx = 0;
      n.vy = 0;
    });
  });
  placeRail();
  fitView();
  centered = false;
  settleTicks = 0;
}

// Radial: the hub answer. Entry points sit at the center, each BFS depth is a
// ring, so hub-and-spokes reads as a tree instead of a hairball. Within a
// ring, nodes sort by the circular mean angle of their already-placed inner
// neighbors (spokes stay short and crossings low); ring radius grows with
// both depth and occupancy so boxes never have to share arc they can't fit.
function layoutRadial() {
  const rect = canvas.getBoundingClientRect();
  const cx = rect.width / 2;
  const cy = rect.height / 2;
  const layers = layerize();
  const nbrs = new Map(simNodes.map(n => [n, []]));
  for (const e of edges) {
    if (e.source.rail || e.target.rail) continue;
    nbrs.get(e.source).push(e.target);
    nbrs.get(e.target).push(e.source);
  }
  const placedAngle = new Map();
  let rPrev = 0;
  layers.forEach((layer, d) => {
    if (d === 0 && layer.length === 1) {
      const n = layer[0];
      n.tx = cx;
      n.ty = cy;
      placedAngle.set(n, 0);
      return;
    }
    const desired = new Map(layer.map(n => {
      let sx = 0;
      let sy = 0;
      let cnt = 0;
      for (const m of nbrs.get(n)) {
        if (placedAngle.has(m) && (graphDepths.get(m) ?? 0) < d) {
          const a = placedAngle.get(m);
          sx += Math.cos(a);
          sy += Math.sin(a);
          cnt++;
        }
      }
      return [n, cnt ? Math.atan2(sy, sx) : null];
    }));
    layer.sort((a, b) => {
      const da = desired.get(a);
      const db = desired.get(b);
      if (da != null && db != null && da !== db) return da - db;
      if ((da == null) !== (db == null)) return da == null ? 1 : -1;
      return a.group.localeCompare(b.group) || a.label.localeCompare(b.label);
    });
    const avgW = layer.reduce((s, n) => s + n.w, 0) / layer.length;
    const r = Math.max(rPrev + 190, (layer.length * (avgW + 30)) / (2 * Math.PI));
    rPrev = r;
    const first = desired.get(layer[0]);
    const start = first != null ? first : -Math.PI / 2;
    layer.forEach((n, j) => {
      const a = start + (j / layer.length) * 2 * Math.PI;
      n.tx = cx + r * Math.cos(a);
      n.ty = cy + r * Math.sin(a);
      placedAngle.set(n, a);
    });
  });
  for (const n of simNodes) {
    n.x = n.tx;
    n.y = n.ty;
    n.vx = 0;
    n.vy = 0;
  }
  placeRail();
  fitView();
  centered = false;
  settleTicks = 0;
}

// Two-phase force: clusters are placed first as fixed anchors on a circle
// (phase 1), then members spiral inside their cluster disc (phase 2). step()
// adds a soft wall at each disc's radius, so groups relax internally but can
// no longer migrate into each other — the old drifting-centroid pull let the
// hub's springs drag whole groups across the map, which is what made the
// hulls overlap.
function layoutForce() {
  const rect = canvas.getBoundingClientRect();
  const cx = rect.width / 2;
  const cy = rect.height / 2;
  const groupsArr = [...clusters.keys()]
    .map(g => ({ g, members: clusters.get(g).filter(n => !n.rail) }))
    .filter(x => x.members.length)
    .sort((a, b) => b.members.length - a.members.length || a.g.localeCompare(b.g));
  clusterCenters = new Map();
  const nG = groupsArr.length;
  const discR = count => 70 + 40 * Math.sqrt(count);
  const ringNeed = groupsArr.reduce((s, x) => s + discR(x.members.length) * 2, 0) / (2 * Math.PI);
  const gRadius = nG <= 1 ? 0 : Math.max(Math.min(rect.width, rect.height) * 0.28, ringNeed * 1.15);
  groupsArr.forEach((x, gi) => {
    const a = nG <= 1 ? 0 : (gi / nG) * 2 * Math.PI - Math.PI / 2;
    const gx = cx + gRadius * Math.cos(a);
    const gy = cy + gRadius * Math.sin(a);
    clusterCenters.set(x.g, { x: gx, y: gy, r: discR(x.members.length) });
    const list = [...x.members].sort((m, n) => n.importance - m.importance || m.label.localeCompare(n.label));
    list.forEach((n, i) => {
      const angle = i * 2.399;
      const rr = 16 + Math.sqrt(i) * 34;
      n.x = gx + rr * Math.cos(angle);
      n.y = gy + rr * Math.sin(angle);
      n.vx = 0;
      n.vy = 0;
    });
  });
  placeRail();
  fitView();
  centered = false;
  settleTicks = 0;
}

// The side rail hosts BFS-unreachable nodes (standalone scripts, statically
// served pages, external hooks) as a labeled static column instead of letting
// layered mode dump them all in a meaningless bottom layer. Their edges still
// draw across the boundary (a rail script may feed a connected module).
function placeRail() {
  const railNodes = nodes.filter(n => n.rail)
    .sort((a, b) => b.importance - a.importance || a.label.localeCompare(b.label));
  if (!railNodes.length) {
    railBox = null;
    return;
  }
  const grid = simNodes;
  let minX = Infinity;
  let minY = Infinity;
  for (const n of grid) {
    minX = Math.min(minX, (n.tx ?? n.x) - n.w / 2);
    minY = Math.min(minY, (n.ty ?? n.y) - n.h / 2);
  }
  if (!grid.length) {
    minX = 300;
    minY = 80;
  }
  const colW = Math.max(...railNodes.map(n => n.w)) + 32;
  const railCx = minX - 80 - colW / 2;
  let y = minY + 38;
  for (const n of railNodes) {
    n.x = railCx;
    n.y = y + n.h / 2;
    n.vx = 0;
    n.vy = 0;
    y += n.h + 14;
  }
  railBox = { x: railCx - colW / 2, y: minY - 6, w: colW, h: y - minY + 12 };
}

function computeActivity() {
  const now = Date.now();
  const relevantTags = ['built', 'bug fix', 'refactor'];
  // TagEntry.timestamp is an ISO string — the old numeric arithmetic on it
  // produced NaN, so the glow never fired on real data (latent since launch).
  const ts = t => typeof t.timestamp === 'number' ? t.timestamp : Date.parse(t.timestamp) || 0;
  const filtered = projectTags.filter(t => relevantTags.includes(t.tag));
  for (const n of nodes) {
    const base = n.label;
    const baseNoExt = base.replace(/\.[^.]+$/, '');
    let best = null;
    for (const t of filtered) {
      const c = (t.content || '').toLowerCase();
      if (c.includes(base.toLowerCase()) || (baseNoExt.length >= 4 && c.includes(baseNoExt.toLowerCase()))) {
        if (!best || ts(t) > ts(best)) best = t;
      }
    }
    if (best) {
      const days = Math.floor((now - ts(best)) / (1000 * 60 * 60 * 24));
      n.activity = { days, tag: best.tag, content: best.content };
    } else {
      n.activity = null;
    }
  }
}

function activityGlow(days) {
  if (days <= 1) return 1.0;
  if (days <= 3) return 0.8;
  if (days <= 7) return 0.55;
  if (days <= 14) return 0.3;
  return 0;
}

function buildGraph(stack) {
  entryPoints = (stack.entryPoints || []).map(p => normalize(p));
  const groupIndex = buildGroupIndex(stack.files.map(f => f.path));
  nodes = stack.files.map(f => {
    const size = sizeFor(f.importance);
    return {
      id: normalize(f.path),
      path: f.path,
      group: groupIndex.get(f.path),
      label: f.path.split('/').pop(),
      lines: f.lines,
      importance: f.importance,
      description: f.description,
      exports: f.exports,
      w: size.w, h: size.h, font: size.font, sub: size.sub,
      x: 0, y: 0, vx: 0, vy: 0,
      tx: null, ty: null, rail: false,
    };
  });
  clusters = new Map();
  for (const n of nodes) {
    if (!clusters.has(n.group)) clusters.set(n.group, []);
    clusters.get(n.group).push(n);
  }
  const names = [...clusters.keys()].sort((a, b) => a.localeCompare(b));
  clusterColors = new Map(names.map((g, i) => [g, CLUSTER_SLOTS[i] || CLUSTER_OTHER]));
  const byId = new Map(nodes.map(n => [n.id, n]));

  const fnToFile = new Map();
  for (const fn of stack.functions || []) fnToFile.set(fn.name, fn.file);
  const strengthMap = new Map();
  for (const fn of stack.functions || []) {
    for (const c of fn.calls || []) {
      const tgt = fnToFile.get(c);
      if (!tgt || tgt === fn.file) continue;
      const k = `${fn.file}|${tgt}`;
      strengthMap.set(k, (strengthMap.get(k) || 0) + 1);
    }
  }
  let maxStrength = 1;
  for (const v of strengthMap.values()) if (v > maxStrength) maxStrength = v;

  edges = [];
  const seen = new Set();
  for (const r of stack.fileRelations) {
    const a = byId.get(normalize(r.from));
    const b = byId.get(normalize(r.to));
    if (!a || !b || a === b) continue;
    const key = `${a.id}|${b.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const strength = strengthMap.get(`${a.id}|${b.id}`) || 0;
    edges.push({ source: a, target: b, strength, strengthNorm: strength / maxStrength });
  }
  computeActivity();
  adjacency = new Map();
  for (const n of nodes) adjacency.set(n, new Set([n]));
  for (const e of edges) {
    adjacency.get(e.source).add(e.target);
    adjacency.get(e.target).add(e.source);
  }
  graphDepths = computeReach();
  for (const n of nodes) n.rail = !graphDepths.has(n);
  simNodes = nodes.filter(n => !n.rail);
  dotLabelSet = new Set([...nodes]
    .filter(n => n.importance >= 1)
    .sort((a, b) => b.importance - a.importance || b.lines - a.lines)
    .slice(0, 15));
  layoutInitial();
}

function layoutInitial() {
  for (const n of nodes) {
    n.tx = null;
    n.ty = null;
  }
  if (layoutMode === 'layered') layoutLayered();
  else if (layoutMode === 'radial') layoutRadial();
  else layoutForce();
}

const REPULSION = 16000;
const SPRING = 0.025;
const REST = 170;
const DAMPING = 0.82;
const GRAVITY = 0.004;
const CONTAIN = 0.06;
const COLLISION_PAD = 18;
const MAX_V = 14;

function resolveCollisions() {
  for (let iter = 0; iter < 5; iter++) {
    for (let i = 0; i < simNodes.length; i++) {
      for (let j = i + 1; j < simNodes.length; j++) {
        const a = simNodes[i], b = simNodes[j];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const minX = (a.w + b.w) / 2 + COLLISION_PAD;
        const minY = (a.h + b.h) / 2 + COLLISION_PAD / 2;
        const ox = minX - Math.abs(dx);
        const oy = minY - Math.abs(dy);
        if (ox > 0 && oy > 0) {
          if (ox < oy) {
            const push = ox / 2 * (dx < 0 ? -1 : 1) * 0.85;
            if (a !== dragging) a.x -= push;
            if (b !== dragging) b.x += push;
          } else {
            const push = oy / 2 * (dy < 0 ? -1 : 1) * 0.85;
            if (a !== dragging) a.y -= push;
            if (b !== dragging) b.y += push;
          }
        }
      }
    }
  }
}

function step() {
  const rect = canvas.getBoundingClientRect();
  const cx = rect.width / 2;
  const cy = rect.height / 2;

  for (const n of nodes) { n.fx = 0; n.fy = 0; }

  for (let i = 0; i < simNodes.length; i++) {
    for (let j = i + 1; j < simNodes.length; j++) {
      const a = simNodes[i], b = simNodes[j];
      const dx = a.x - b.x;
      const dy = a.y - b.y;
      const d2 = dx * dx + dy * dy + 0.01;
      const d = Math.sqrt(d2);
      const f = REPULSION / d2;
      const fx = (f * dx) / d;
      const fy = (f * dy) / d;
      a.fx += fx; a.fy += fy;
      b.fx -= fx; b.fy -= fy;
    }
  }

  for (const e of edges) {
    // Rail nodes are static: a spring into the rail would only smear the
    // grid toward it, so connected endpoints ignore rail springs entirely.
    if (e.source.rail || e.target.rail) continue;
    const dx = e.target.x - e.source.x;
    const dy = e.target.y - e.source.y;
    const d = Math.sqrt(dx * dx + dy * dy) + 0.01;
    const f = SPRING * (d - REST);
    const fx = (f * dx) / d;
    const fy = (f * dy) / d;
    e.source.fx += fx; e.source.fy += fy;
    e.target.fx -= fx; e.target.fy -= fy;
  }

  if (layoutMode === 'force') {
    for (const n of simNodes) {
      const c = clusterCenters.get(n.group);
      if (!c) continue;
      const dx = n.x - c.x;
      const dy = n.y - c.y;
      const dist = Math.sqrt(dx * dx + dy * dy) + 0.01;
      if (dist > c.r) {
        const f = (dist - c.r) * CONTAIN;
        n.fx -= (dx / dist) * f;
        n.fy -= (dy / dist) * f;
      }
    }
  }

  let energy = 0;
  for (const n of simNodes) {
    if (n.tx != null && layoutMode !== 'force') {
      n.fx += (n.tx - n.x) * (layoutMode === 'radial' ? 0.2 : 0.06);
      n.fy += (n.ty - n.y) * (layoutMode === 'radial' ? 0.2 : 0.35);
    } else {
      n.fx += (cx - n.x) * GRAVITY;
      n.fy += (cy - n.y) * GRAVITY;
    }
    if (n === dragging) continue;
    n.vx = (n.vx + n.fx) * DAMPING;
    n.vy = (n.vy + n.fy) * DAMPING;
    if (n.vx > MAX_V) n.vx = MAX_V; else if (n.vx < -MAX_V) n.vx = -MAX_V;
    if (n.vy > MAX_V) n.vy = MAX_V; else if (n.vy < -MAX_V) n.vy = -MAX_V;
    n.x += n.vx;
    n.y += n.vy;
    energy += Math.abs(n.vx) + Math.abs(n.vy);
  }

  resolveCollisions();

  return energy;
}

// Scale + center the view so the whole graph fits the canvas with padding.
// (Adjusts the view transform, not node coordinates, so saved layouts stay stable.)
function fitView() {
  if (!nodes.length) return;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of nodes) {
    minX = Math.min(minX, n.x - n.w / 2);
    maxX = Math.max(maxX, n.x + n.w / 2);
    minY = Math.min(minY, n.y - n.h / 2);
    maxY = Math.max(maxY, n.y + n.h / 2);
  }
  const rect = canvas.getBoundingClientRect();
  const pad = 50;
  const bw = maxX - minX, bh = maxY - minY;
  if (bw <= 0 || bh <= 0) return;
  const k = Math.min((rect.width - pad * 2) / bw, (rect.height - pad * 2) / bh, 1.4);
  view.k = k > 0.05 ? k : 1;
  view.x = rect.width / 2 - ((minX + maxX) / 2) * view.k;
  view.y = rect.height / 2 - ((minY + maxY) / 2) * view.k;
}

function clipToBox(cx, cy, dx, dy, w, h) {
  if (dx === 0 && dy === 0) return [cx, cy];
  const hw = w / 2, hh = h / 2;
  const tx = dx !== 0 ? hw / Math.abs(dx) : Infinity;
  const ty = dy !== 0 ? hh / Math.abs(dy) : Infinity;
  const t = Math.min(tx, ty);
  return [cx + dx * t, cy + dy * t];
}

function drawArrow(x, y, angle, dim) {
  const size = 10;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(-size, -size * 0.5);
  ctx.lineTo(-size * 0.6, 0);
  ctx.lineTo(-size, size * 0.5);
  ctx.closePath();
  ctx.fillStyle = dim ? '#303132' : '#8a8b8d';
  ctx.fill();
  ctx.restore();
}

function drawRail() {
  if (!railBox) return;
  ctx.fillStyle = 'rgba(27,28,29,0.55)';
  ctx.strokeStyle = 'rgba(255,255,255,0.08)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(railBox.x, railBox.y, railBox.w, railBox.h, 12);
  else ctx.rect(railBox.x, railBox.y, railBox.w, railBox.h);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = '#898781';
  ctx.font = '11px Segoe UI, Tahoma, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillText('أدوات ومعزولات', railBox.x + railBox.w / 2, railBox.y + 10);
}

function drawClusters() {
  // Hulls are only meaningful where clusters are spatial (force mode); in
  // layered/radial a cluster spans rows/rings and its hull would swallow the
  // whole canvas — there, the border hue alone carries cluster identity.
  if (layoutMode !== 'force') return;
  const pad = 26;
  for (const [group, list] of clusters) {
    // Rail residents keep their cluster hue but must not stretch the hull
    // across the canvas; singleton hulls are noise, skip them too.
    const vis = list.filter(n => !n.rail);
    if (vis.length < 2) continue;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of vis) {
      minX = Math.min(minX, n.x - n.w / 2);
      maxX = Math.max(maxX, n.x + n.w / 2);
      minY = Math.min(minY, n.y - n.h / 2);
      maxY = Math.max(maxY, n.y + n.h / 2);
    }
    const x = minX - pad, y = minY - pad - 14;
    const w = maxX - minX + pad * 2;
    const h = maxY - minY + pad * 2 + 14;
    const hue = clusterColors.get(group) || CLUSTER_OTHER;
    ctx.fillStyle = `${hue}14`;
    ctx.strokeStyle = `${hue}3a`;
    ctx.lineWidth = 1;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x, y, w, h, 14);
    else ctx.rect(x, y, w, h);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#898781';
    ctx.font = '11px Segoe UI, Tahoma, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(group, x + 12, y + 7);
  }
}

// Semantic-zoom dot (#389): screen-fixed radius by importance, cluster hue as
// fill. Between DOTS_K and NAMES_K, important files (and search matches) keep
// a screen-fixed label so the map stays navigable while zoomed out.
function drawNodeDot(n, dim) {
  const hue = clusterColors.get(n.group) || CLUSTER_OTHER;
  const r = (4 + n.importance * 2.5) / view.k;
  const isMatch = searchMatches.has(n);
  const glow = (showActivity && n.activity && !dim) ? activityGlow(n.activity.days) : 0;
  ctx.save();
  if (glow > 0) {
    ctx.shadowColor = `rgba(${ACT_RGB}, ${glow})`;
    ctx.shadowBlur = (10 * glow + 4) / view.k;
  }
  ctx.fillStyle = hue + (dim ? '40' : 'ff');
  ctx.beginPath();
  ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  if (isMatch || n === focusRoot || n === hovered) {
    ctx.strokeStyle = isMatch ? '#ffd166' : '#ffffff';
    ctx.lineWidth = 2 / view.k;
    ctx.beginPath();
    ctx.arc(n.x, n.y, r + 2 / view.k, 0, Math.PI * 2);
    ctx.stroke();
  }
  const named = view.k >= DOTS_K && dotLabelSet.has(n);
  if ((named || isMatch) && !dim) {
    ctx.fillStyle = isMatch ? '#ffd166' : '#c9c9c9';
    ctx.font = `${11 / view.k}px Segoe UI, Tahoma, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText(fitLabel(n.label, 190 / view.k), n.x, n.y + r + 3 / view.k);
  }
}

function render() {
  const rect = canvas.getBoundingClientRect();
  ctx.fillStyle = '#161718';
  ctx.fillRect(0, 0, rect.width, rect.height);

  ctx.save();
  ctx.translate(view.x, view.y);
  ctx.scale(view.k, view.k);

  drawRail();
  drawClusters();

  const neighbors = hovered ? adjacency.get(hovered) : null;
  const isDim = (n) => (focusSet && !focusSet.has(n)) ||
    (neighbors && !neighbors.has(n));
  const edgeDim = (e) => (focusSet && !(focusSet.has(e.source) && focusSet.has(e.target))) ||
    (neighbors && !(neighbors.has(e.source) && neighbors.has(e.target)));
  const dotsMode = view.k < NAMES_K;

  for (const e of edges) {
    const dim = edgeDim(e);
    const sx = e.source.x, sy = e.source.y;
    const tx = e.target.x, ty = e.target.y;
    const dx = tx - sx, dy = ty - sy;
    if (dx === 0 && dy === 0) continue;
    if (dotsMode) {
      // Dot zoom: center-to-center hairlines, no arrowheads — at this scale
      // they read as texture, direction comes back with the boxes.
      ctx.strokeStyle = dim ? '#242526' : '#3d3e40';
      ctx.lineWidth = 1 / view.k;
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.lineTo(tx, ty);
      ctx.stroke();
      continue;
    }
    const [x1, y1] = clipToBox(sx, sy, dx, dy, e.source.w, e.source.h);
    const [x2, y2] = clipToBox(tx, ty, -dx, -dy, e.target.w, e.target.h);
    const sNorm = e.strengthNorm || 0;
    ctx.strokeStyle = dim ? '#242526' : (sNorm > 0 ? `rgba(138,139,141,${0.45 + sNorm * 0.55})` : '#4a4b4d');
    ctx.lineWidth = dim ? 1 : (1 + sNorm * 2.8);
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
    drawArrow(x2, y2, Math.atan2(dy, dx), dim);
  }

  for (const n of nodes) {
    const dim = isDim(n);
    if (dotsMode) {
      drawNodeDot(n, dim);
      continue;
    }
    const c = nodeColors(n, dim);
    const isHover = n === hovered;
    const isMatch = searchMatches.has(n);
    const w = n.w, h = n.h;
    const x = n.x - w / 2;
    const y = n.y - h / 2;
    const glow = (showActivity && n.activity && !dim) ? activityGlow(n.activity.days) : 0;
    if (glow > 0) {
      ctx.save();
      ctx.shadowColor = `rgba(${ACT_RGB}, ${glow})`;
      ctx.shadowBlur = 18 * glow + 6;
      ctx.fillStyle = c.bg;
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(x, y, w, h, 7);
      else ctx.rect(x, y, w, h);
      ctx.fill();
      ctx.restore();
    }
    ctx.save();
    if (isMatch) {
      // Search glow (#390) — gold, distinct from the green activity glow and
      // every cluster hue.
      ctx.shadowColor = '#ffd166';
      ctx.shadowBlur = 16;
    }
    ctx.fillStyle = isHover ? '#242526' : c.bg;
    ctx.strokeStyle = (isHover || n === focusRoot) ? '#ffffff' : (isMatch ? '#ffd166' : c.border);
    ctx.lineWidth = (isHover || n === focusRoot || isMatch) ? 1.8 : 1.2;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x, y, w, h, 7);
    else ctx.rect(x, y, w, h);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
    ctx.fillStyle = c.text;
    ctx.font = `${n.font}px Segoe UI, Tahoma, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(fitLabel(n.label, n.w - 12), n.x, n.y - 8);
    ctx.fillStyle = dim ? '#55555580' : '#888';
    ctx.font = `${n.sub}px Segoe UI, Tahoma, sans-serif`;
    ctx.fillText(`${n.lines} سطر`, n.x, n.y + 10);

    if (showActivity && n.activity && !dim && activityGlow(n.activity.days) > 0) {
      const d = n.activity.days;
      const txt = d === 0 ? 'اليوم' : d === 1 ? 'أمس' : `قبل ${d} يوم`;
      ctx.font = '10px Segoe UI, Tahoma, sans-serif';
      const tw = ctx.measureText(txt).width + 10;
      const bx = n.x - tw / 2;
      const by = y - 16;
      ctx.fillStyle = `rgba(${ACT_RGB}, 0.95)`;
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(bx, by, tw, 14, 7);
      else ctx.rect(bx, by, tw, 14);
      ctx.fill();
      ctx.fillStyle = '#161718';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(txt, n.x, by + 7);
    }
  }
  ctx.restore();
}

function pickNode(mx, my) {
  for (let i = nodes.length - 1; i >= 0; i--) {
    const n = nodes[i];
    if (mx >= n.x - n.w / 2 && mx <= n.x + n.w / 2 &&
        my >= n.y - n.h / 2 && my <= n.y + n.h / 2) {
      return n;
    }
  }
  return null;
}

function getMouse(e) {
  const rect = canvas.getBoundingClientRect();
  return { x: e.clientX - rect.left, y: e.clientY - rect.top };
}

// HTML-escape untrusted strings before innerHTML. DEVLOG_STACK.md is
// project-controlled, so a malicious repo could ship an <img onerror> payload
// in a file path/description (security audit R2 #1 / defense D2).
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// Screen (CSS px) → world coordinates, accounting for pan/zoom.
function toWorld(p) {
  return { x: (p.x - view.x) / view.k, y: (p.y - view.y) / view.k };
}

// Truncate a label with … so it fits inside maxW (font must be set on ctx first).
function fitLabel(text, maxW) {
  if (ctx.measureText(text).width <= maxW) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(`${t}…`).width > maxW) t = t.slice(0, -1);
  return `${t}…`;
}

// Focus = the clicked node, everything it transitively depends on (outgoing
// BFS) and its direct callers — "what does this file drive, and who uses it".
// Direct callers only: transitive ancestors of a hub would light up most of
// the map and defeat the isolation.
function computeFocus(root) {
  const outgoing = new Map(nodes.map(n => [n, []]));
  for (const e of edges) outgoing.get(e.source).push(e.target);
  const set = new Set([root]);
  const queue = [root];
  while (queue.length) {
    const n = queue.shift();
    for (const m of outgoing.get(n)) {
      if (!set.has(m)) {
        set.add(m);
        queue.push(m);
      }
    }
  }
  for (const e of edges) if (e.target === root) set.add(e.source);
  return set;
}

function setFocus(node) {
  focusRoot = node;
  focusSet = computeFocus(node);
  if (!simRunning) render();
}

function clearFocus() {
  focusRoot = null;
  focusSet = null;
  if (!simRunning) render();
}

// Center the view on a node at zoom k without touching node coordinates.
function centerOn(n, k) {
  const rect = canvas.getBoundingClientRect();
  view.k = k;
  view.x = rect.width / 2 - n.x * k;
  view.y = rect.height / 2 - n.y * k;
}

canvas.addEventListener('mousedown', e => {
  const s = getMouse(e);
  const { x, y } = toWorld(s);
  const node = pickNode(x, y);
  if (node) {
    dragging = node;
    dragOffset.x = node.x - x;
    dragOffset.y = node.y - y;
    dragMoved = false;
    canvas.classList.add('dragging');
  } else {
    panning = true;
    panMoved = false;
    panStart = { x: s.x - view.x, y: s.y - view.y };
    panScreen = { x: s.x, y: s.y };
    canvas.classList.add('dragging');
  }
});

canvas.addEventListener('mousemove', e => {
  const s = getMouse(e);
  if (panning) {
    if (Math.abs(s.x - panScreen.x) > 3 || Math.abs(s.y - panScreen.y) > 3) panMoved = true;
    view.x = s.x - panStart.x;
    view.y = s.y - panStart.y;
    render();
    return;
  }
  const { x, y } = toWorld(s);
  if (dragging) {
    const nx = x + dragOffset.x;
    const ny = y + dragOffset.y;
    if (Math.abs(nx - dragging.x) > 2 || Math.abs(ny - dragging.y) > 2) dragMoved = true;
    dragging.x = nx;
    dragging.y = ny;
    dragging.vx = 0;
    dragging.vy = 0;
    if (!simRunning) { render(); loop(); }
  } else {
    const node = pickNode(x, y);
    if (node !== hovered) {
      hovered = node;
      if (node) {
        tooltip.style.display = 'block';
        tooltip.innerHTML =
          `<div><strong>${esc(node.label)}</strong></div>` +
          `<div class="t-path">${esc(node.path)}</div>` +
          (node.description ? `<div class="t-desc">${esc(node.description)}</div>` : '') +
          `<div class="t-path">${node.lines} سطر · أهمية ${node.importance}/3 · ${esc(node.group)}</div>` +
          (node.rail ? `<div class="t-path">غير موصول من نقاط الدخول</div>` : '') +
          (node.activity ? `<div class="t-desc" style="color:${ACT_HEX}">● ${esc(node.activity.tag)} — ${node.activity.days === 0 ? 'اليوم' : node.activity.days === 1 ? 'أمس' : `قبل ${node.activity.days} يوم`}</div>` : '') +
          `<div class="t-path" style="opacity:.55;margin-top:4px">اضغط: عزل الجوار · اضغط مرتين: فتح في VS Code · اسحب: تثبيت المكان</div>`;
      } else {
        tooltip.style.display = 'none';
      }
      if (!simRunning) render();
    }
    if (hovered) {
      tooltip.style.left = `${e.clientX + 12}px`;
      tooltip.style.top = `${e.clientY + 12}px`;
    }
  }
});

canvas.addEventListener('mouseup', () => {
  if (panning) {
    panning = false;
    canvas.classList.remove('dragging');
    // A motionless click on empty space exits isolation (#388).
    if (!panMoved) clearFocus();
    return;
  }
  if (dragging) {
    if (dragMoved) {
      schedulePositionSave();
    } else {
      // Click isolates the neighborhood (#388); opening the file moved to
      // double-click. Re-clicking the same root just re-pins it — the exits
      // are Esc and empty space, so a fast double-click never flickers.
      setFocus(dragging);
    }
  }
  dragging = null;
  canvas.classList.remove('dragging');
});
canvas.addEventListener('mouseleave', () => {
  if (dragging && dragMoved) schedulePositionSave();
  dragging = null;
  panning = false;
  hovered = null;
  tooltip.style.display = 'none';
  canvas.classList.remove('dragging');
  if (!simRunning) render();
});

// Wheel zoom around the cursor.
canvas.addEventListener('wheel', e => {
  e.preventDefault();
  const s = getMouse(e);
  const factor = e.deltaY < 0 ? 1.1 : 0.9;
  const nk = Math.max(0.1, Math.min(3, view.k * factor));
  view.x = s.x - (s.x - view.x) * (nk / view.k);
  view.y = s.y - (s.y - view.y) * (nk / view.k);
  view.k = nk;
  render();
}, { passive: false });

// Double-click: on a node opens it in VS Code, on empty space re-fits the graph.
canvas.addEventListener('dblclick', e => {
  const { x, y } = toWorld(getMouse(e));
  const node = pickNode(x, y);
  if (node) openFile(node);
  else { fitView(); render(); }
});

window.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  const box = document.getElementById('searchBox');
  if (document.activeElement === box && box.value) {
    box.value = '';
    updateSearch(false);
    box.blur();
    return;
  }
  clearFocus();
});

function schedulePositionSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    const positions = {};
    for (const n of nodes) positions[n.id] = { x: n.x, y: n.y };
    try {
      await fetch(`/api/stack/${encodeURIComponent(project)}/layout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ positions }),
      });
    } catch {
      // Layout save is best-effort; the next drag retries.
    }
  }, 500);
}

function openFile(node) {
  if (!projectPath || !node?.path) return;
  // node.path comes from .devlog/DEVLOG_STACK.md, which an audited repo controls.
  // Reject traversal and confirm the resolved path stays inside the project
  // before handing it to the vscode:// handler, so a malicious node can't point
  // the editor at an arbitrary file (R4 sec L2).
  if (node.path.includes('..')) return;
  const sep = projectPath.includes('\\') ? '\\' : '/';
  const abs = (projectPath + sep + node.path.replace(/\//g, sep)).replace(/\\/g, '/');
  const root = projectPath.replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '');
  const norm = abs.toLowerCase();
  if (norm !== root && !norm.startsWith(`${root}/`)) return;
  window.location.href = `vscode://file/${encodeURI(abs)}`;
}

document.getElementById('reLayout').onclick = async () => {
  try {
    await fetch(`/api/stack/${encodeURIComponent(project)}/layout`, { method: 'DELETE' });
  } catch {
    // Server-side reset failed — still re-layout locally.
  }
  savedPositions = null;
  layoutInitial();
  if (!simRunning) loop();
};

document.getElementById('layoutMode').onchange = (e) => {
  layoutMode = e.target.value;
  layoutInitial();
  if (!simRunning) loop();
};

// Header search (#390): live gold highlight while typing pans to the best
// match; Enter also zooms in on it. Ranking: label prefix > label substring >
// path substring, then importance, then name — deterministic.
function searchRank(n, q) {
  const label = n.label.toLowerCase();
  if (label.startsWith(q)) return 0;
  if (label.includes(q)) return 1;
  return 2;
}

function bestMatch(q) {
  return [...searchMatches].sort((a, b) =>
    searchRank(a, q) - searchRank(b, q) ||
    b.importance - a.importance ||
    a.label.localeCompare(b.label))[0];
}

function updateSearch(jump) {
  const box = document.getElementById('searchBox');
  const q = box.value.trim().toLowerCase();
  searchMatches = new Set(q ? nodes.filter(n =>
    n.label.toLowerCase().includes(q) || n.path.toLowerCase().includes(q)) : []);
  if (q && jump && searchMatches.size) centerOn(bestMatch(q), view.k);
  if (!simRunning) render();
}

document.getElementById('searchBox').addEventListener('input', () => { updateSearch(true); });
document.getElementById('searchBox').addEventListener('keydown', e => {
  if (e.key !== 'Enter') return;
  const q = e.target.value.trim().toLowerCase();
  if (!q || !searchMatches.size) return;
  centerOn(bestMatch(q), Math.max(view.k, 1));
  if (!simRunning) render();
});

document.getElementById('toggleActivity').onclick = () => {
  showActivity = !showActivity;
  document.getElementById('toggleActivity').textContent = `نشاط: ${showActivity ? 'ON' : 'OFF'}`;
  render();
};

// Freshness banner + explicit regeneration. DEVLOG_STACK.md is generated once
// and never refreshed automatically (it may carry manual enrichment), so the
// header shows the scan's age — amber past 30 days — and the button is the
// user's opt-in to overwrite it from the current code.
function showStackAge(mtime) {
  const el = document.getElementById('stackAge');
  const btn = document.getElementById('regenStack');
  btn.style.display = '';
  if (!mtime) { el.textContent = ''; return; }
  const days = Math.floor((Date.now() - mtime) / (1000 * 60 * 60 * 24));
  el.textContent = days === 0 ? 'آخر مسح: اليوم' : days === 1 ? 'آخر مسح: أمس' : `آخر مسح: قبل ${days} يوم`;
  if (days > 30) el.style.color = '#c98500';
}

document.getElementById('regenStack').onclick = async () => {
  const btn = document.getElementById('regenStack');
  btn.disabled = true;
  btn.textContent = 'يولّد…';
  try {
    const r = await fetch(`/api/stack/${encodeURIComponent(project)}/regenerate`, { method: 'POST' });
    if (r.ok) { location.reload(); return; }
    btn.textContent = 'فشل التحديث';
  } catch {
    btn.textContent = 'فشل التحديث';
  }
  btn.disabled = false;
};

function loop() {
  simRunning = true;
  const energy = step();
  if (!centered) {
    // Relative threshold: strong target pulls + collisions can hold a small
    // constant jitter per node, so an absolute cutoff may never be reached.
    if (energy < Math.max(2.0, simNodes.length * 0.12)) settleTicks++; else settleTicks = 0;
    if (settleTicks > 8) {
      // Final de-overlap pass: forces have cooled, so push any still-overlapping
      // boxes fully apart before freezing the layout.
      for (let i = 0; i < 40; i++) resolveCollisions();
      fitView();
      centered = true;
    }
  }
  render();
  if (energy > Math.max(0.4, simNodes.length * 0.03) || dragging || !centered) {
    requestAnimationFrame(loop);
  } else {
    simRunning = false;
  }
}

function applySavedPositions() {
  if (!savedPositions) return 0;
  let applied = 0;
  for (const n of nodes) {
    const p = savedPositions[n.id];
    if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) {
      n.x = p.x;
      n.y = p.y;
      n.vx = 0;
      n.vy = 0;
      applied++;
    }
  }
  return applied;
}

async function load() {
  document.getElementById('layoutMode').value = layoutMode;
  if (!project) {
    statusEl.textContent = 'لا يوجد مشروع محدد في ?project=';
    return;
  }
  try {
    const [stackRes, layoutRes, tagsRes] = await Promise.all([
      fetch(`/api/stack/${encodeURIComponent(project)}`),
      fetch(`/api/stack/${encodeURIComponent(project)}/layout`),
      // Per-project endpoint: the old code pulled the full /api/data store
      // (~MBs) to read a few dozen tags of one project.
      fetch(`/api/tags/${encodeURIComponent(project)}?limit=1000`),
    ]);
    if (tagsRes.ok) {
      try {
        projectTags = (await tagsRes.json()).tags || [];
      } catch { projectTags = []; }
    }
    if (!stackRes.ok) throw new Error(`HTTP ${stackRes.status}`);
    const data = await stackRes.json();
    if (!data.parsed?.files?.length) {
      statusEl.textContent = 'STACK.md غير موجود — شغّل مسح المشروع أولاً';
      return;
    }
    projectPath = data.projectPath || null;
    showStackAge(data.mtime || null);
    if (!modeForced && layoutRes.ok) {
      try {
        const layout = await layoutRes.json();
        savedPositions = layout.positions || null;
      } catch { savedPositions = null; }
    }
    buildGraph(data.parsed);
    const applied = applySavedPositions();
    statusEl.style.display = 'none';
    if (applied === nodes.length && applied > 0) {
      centered = true;
      fitView();
      render();
    } else {
      loop();
    }
  } catch (e) {
    statusEl.textContent = `خطأ: ${e.message}`;
  }
}

load();
