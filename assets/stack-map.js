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

let nodes = [];
let edges = [];
let clusters = new Map();
let adjacency = new Map();
let dragging = null;
let dragOffset = { x: 0, y: 0 };
let dragMoved = false;
let hovered = null;
let simRunning = false;
let centered = false;
let settleTicks = 0;
let projectPath = null;
let savedPositions = null;
let saveTimer = null;
let entryPoints = [];
let layoutMode = 'force';
let showActivity = true;
let projectTags = [];
let view = { x: 0, y: 0, k: 1 };
let panning = false;
let panStart = null;

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

function groupOf(path) {
  const i = path.lastIndexOf('/');
  return i < 0 ? '·' : path.slice(0, i);
}

function clusterHue(group) {
  let h = 0;
  for (let i = 0; i < group.length; i++) h = (h * 31 + group.charCodeAt(i)) | 0;
  return Math.abs(h) % 360;
}

function sizeFor(importance) {
  if (importance >= 3) return { w: 134, h: 54, font: 13, sub: 11 };
  if (importance === 2) return { w: 118, h: 48, font: 12, sub: 10 };
  return { w: 100, h: 42, font: 12, sub: 10 };
}

function colorFor(importance, dim) {
  const alpha = dim ? '55' : 'ff';
  if (importance >= 3) return { border: '#ffd166' + alpha, bg: '#211d12' + alpha, text: '#EEEEEE' + alpha };
  if (importance === 2) return { border: '#118ab2' + alpha, bg: '#0e1c22' + alpha, text: '#EEEEEE' + alpha };
  return { border: '#474848' + alpha, bg: '#1B1C1D' + alpha, text: '#EEEEEE' + alpha };
}

function computeDepths() {
  const depth = new Map();
  const outgoing = new Map();
  for (const n of nodes) outgoing.set(n, []);
  for (const e of edges) outgoing.get(e.source).push(e.target);
  const roots = nodes.filter(n => entryPoints.includes(n.id) || entryPoints.some(ep => normalize(ep) === n.id));
  const seeds = roots.length ? roots : nodes.filter(n => !edges.some(e => e.target === n));
  const queue = [];
  for (const s of (seeds.length ? seeds : nodes.slice(0, 1))) {
    depth.set(s, 0);
    queue.push(s);
  }
  while (queue.length) {
    const n = queue.shift();
    const d = depth.get(n);
    for (const m of outgoing.get(n) || []) {
      if (!depth.has(m) || depth.get(m) > d + 1) {
        depth.set(m, d + 1);
        queue.push(m);
      }
    }
  }
  let maxD = 0;
  for (const d of depth.values()) if (d > maxD) maxD = d;
  for (const n of nodes) {
    if (!depth.has(n)) depth.set(n, maxD + 1);
  }
  return depth;
}

function layoutLayered() {
  const w = canvas.getBoundingClientRect().width;
  const h = canvas.getBoundingClientRect().height;
  const depth = computeDepths();
  const layers = new Map();
  let maxD = 0;
  for (const [n, d] of depth) {
    if (!layers.has(d)) layers.set(d, []);
    layers.get(d).push(n);
    if (d > maxD) maxD = d;
  }
  const sortedDepths = [...layers.keys()].sort((a, b) => a - b);
  const nLayers = sortedDepths.length;
  const topPad = 60, botPad = 40;
  const stepY = nLayers > 1 ? (h - topPad - botPad) / (nLayers - 1) : 0;
  sortedDepths.forEach((d, i) => {
    const list = layers.get(d).sort((a, b) => {
      if (a.group !== b.group) return a.group.localeCompare(b.group);
      return b.importance - a.importance;
    });
    const y = topPad + i * stepY;
    const stepX = w / (list.length + 1);
    list.forEach((n, j) => {
      n.x = stepX * (j + 1);
      n.y = y;
      n.targetY = y;
      n.vx = 0;
      n.vy = 0;
    });
  });
  centered = false;
  settleTicks = 0;
}

function layoutInitial() {
  for (const n of nodes) n.targetY = null;
  if (layoutMode === 'layered') {
    layoutLayered();
    return;
  }
  const w = canvas.getBoundingClientRect().width;
  const h = canvas.getBoundingClientRect().height;
  const cx = w / 2, cy = h / 2;
  const groupKeys = [...clusters.keys()];
  const nGroups = groupKeys.length;
  const gRadius = nGroups <= 1 ? 0 : Math.min(w, h) * 0.22;
  groupKeys.forEach((g, gi) => {
    const gAngle = nGroups <= 1 ? 0 : (gi / nGroups) * Math.PI * 2 - Math.PI / 2;
    const gcx = cx + gRadius * Math.cos(gAngle);
    const gcy = cy + gRadius * Math.sin(gAngle);
    const list = [...clusters.get(g)].sort((a, b) => b.importance - a.importance);
    list.forEach((n, i) => {
      const angle = i * 2.399;
      const r = 20 + Math.sqrt(i) * 42;
      n.x = gcx + r * Math.cos(angle);
      n.y = gcy + r * Math.sin(angle);
      n.vx = 0;
      n.vy = 0;
    });
  });
  centered = false;
  settleTicks = 0;
}

function computeActivity() {
  const now = Date.now();
  const relevantTags = ['built', 'bug fix', 'refactor'];
  const filtered = projectTags.filter(t => relevantTags.includes(t.tag));
  for (const n of nodes) {
    const base = n.label;
    const baseNoExt = base.replace(/\.[^.]+$/, '');
    let best = null;
    for (const t of filtered) {
      const c = (t.content || '').toLowerCase();
      if (c.includes(base.toLowerCase()) || (baseNoExt.length >= 4 && c.includes(baseNoExt.toLowerCase()))) {
        if (!best || t.timestamp > best.timestamp) best = t;
      }
    }
    if (best) {
      const days = Math.floor((now - best.timestamp) / (1000 * 60 * 60 * 24));
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
  nodes = stack.files.map(f => {
    const size = sizeFor(f.importance);
    return {
      id: normalize(f.path),
      path: f.path,
      group: groupOf(f.path),
      label: f.path.split('/').pop(),
      lines: f.lines,
      importance: f.importance,
      description: f.description,
      exports: f.exports,
      w: size.w, h: size.h, font: size.font, sub: size.sub,
      x: 0, y: 0, vx: 0, vy: 0,
    };
  });
  clusters = new Map();
  for (const n of nodes) {
    if (!clusters.has(n.group)) clusters.set(n.group, []);
    clusters.get(n.group).push(n);
  }
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
  layoutInitial();
}

const REPULSION = 16000;
const SPRING = 0.025;
const REST = 170;
const DAMPING = 0.82;
const GRAVITY = 0.004;
const CLUSTER_PULL = 0.010;
const COLLISION_PAD = 18;
const MAX_V = 14;

function resolveCollisions() {
  for (let iter = 0; iter < 5; iter++) {
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i], b = nodes[j];
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
  const w = canvas.getBoundingClientRect().width;
  const h = canvas.getBoundingClientRect().height;
  const cx = w / 2, cy = h / 2;

  for (const n of nodes) { n.fx = 0; n.fy = 0; }

  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i], b = nodes[j];
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
    const dx = e.target.x - e.source.x;
    const dy = e.target.y - e.source.y;
    const d = Math.sqrt(dx * dx + dy * dy) + 0.01;
    const f = SPRING * (d - REST);
    const fx = (f * dx) / d;
    const fy = (f * dy) / d;
    e.source.fx += fx; e.source.fy += fy;
    e.target.fx -= fx; e.target.fy -= fy;
  }

  for (const [group, list] of clusters) {
    if (list.length < 2) continue;
    let sx = 0, sy = 0;
    for (const n of list) { sx += n.x; sy += n.y; }
    const ccx = sx / list.length, ccy = sy / list.length;
    for (const n of list) {
      n.fx += (ccx - n.x) * CLUSTER_PULL;
      n.fy += (ccy - n.y) * CLUSTER_PULL;
    }
  }

  let energy = 0;
  for (const n of nodes) {
    if (layoutMode === 'layered' && n.targetY != null) {
      n.fx += (cx - n.x) * (GRAVITY * 0.3);
      n.fy += (n.targetY - n.y) * 0.25;
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

function drawClusters() {
  const pad = 26;
  for (const [group, list] of clusters) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of list) {
      minX = Math.min(minX, n.x - n.w / 2);
      maxX = Math.max(maxX, n.x + n.w / 2);
      minY = Math.min(minY, n.y - n.h / 2);
      maxY = Math.max(maxY, n.y + n.h / 2);
    }
    const x = minX - pad, y = minY - pad - 14;
    const w = maxX - minX + pad * 2;
    const h = maxY - minY + pad * 2 + 14;
    const hue = clusterHue(group);
    ctx.fillStyle = `hsla(${hue}, 35%, 28%, 0.09)`;
    ctx.strokeStyle = `hsla(${hue}, 35%, 55%, 0.22)`;
    ctx.lineWidth = 1;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x, y, w, h, 14);
    else ctx.rect(x, y, w, h);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = `hsla(${hue}, 30%, 62%, 0.55)`;
    ctx.font = '11px Segoe UI, Tahoma, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(group, x + 12, y + 7);
  }
}

function render() {
  const rect = canvas.getBoundingClientRect();
  ctx.fillStyle = '#161718';
  ctx.fillRect(0, 0, rect.width, rect.height);

  ctx.save();
  ctx.translate(view.x, view.y);
  ctx.scale(view.k, view.k);

  drawClusters();

  const neighbors = hovered ? adjacency.get(hovered) : null;
  const isDim = (n) => neighbors && !neighbors.has(n);
  const edgeDim = (e) => neighbors && !(neighbors.has(e.source) && neighbors.has(e.target));

  for (const e of edges) {
    const dim = edgeDim(e);
    const sx = e.source.x, sy = e.source.y;
    const tx = e.target.x, ty = e.target.y;
    const dx = tx - sx, dy = ty - sy;
    if (dx === 0 && dy === 0) continue;
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
    const c = colorFor(n.importance, dim);
    const isHover = n === hovered;
    const w = n.w, h = n.h;
    const x = n.x - w / 2;
    const y = n.y - h / 2;
    const glow = (showActivity && n.activity && !dim) ? activityGlow(n.activity.days) : 0;
    if (glow > 0) {
      ctx.save();
      ctx.shadowColor = `rgba(255, 209, 102, ${glow})`;
      ctx.shadowBlur = 18 * glow + 6;
      ctx.fillStyle = c.bg;
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(x, y, w, h, 7);
      else ctx.rect(x, y, w, h);
      ctx.fill();
      ctx.restore();
    }
    ctx.fillStyle = isHover ? '#242526' : c.bg;
    ctx.strokeStyle = isHover ? '#ffffff' : (glow > 0 ? `rgba(255, 209, 102, ${0.5 + glow * 0.5})` : c.border);
    ctx.lineWidth = isHover ? 1.8 : (glow > 0 ? 1.6 : 1.2);
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x, y, w, h, 7);
    else ctx.rect(x, y, w, h);
    ctx.fill();
    ctx.stroke();
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
      ctx.fillStyle = 'rgba(255, 209, 102, 0.92)';
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
  while (t.length > 1 && ctx.measureText(t + '…').width > maxW) t = t.slice(0, -1);
  return t + '…';
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
    panStart = { x: s.x - view.x, y: s.y - view.y };
    canvas.classList.add('dragging');
  }
});

canvas.addEventListener('mousemove', e => {
  const s = getMouse(e);
  if (panning) {
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
          `<div class="t-path">${node.lines} سطر · أهمية ${node.importance}/3</div>` +
          (node.activity ? `<div class="t-desc" style="color:#ffd166">● ${esc(node.activity.tag)} — ${node.activity.days === 0 ? 'اليوم' : node.activity.days === 1 ? 'أمس' : 'قبل ' + node.activity.days + ' يوم'}</div>` : '') +
          `<div class="t-path" style="opacity:.55;margin-top:4px">اضغط: فتح في VS Code · اسحب: تثبيت المكان</div>`;
      } else {
        tooltip.style.display = 'none';
      }
      if (!simRunning) render();
    }
    if (hovered) {
      tooltip.style.left = (e.clientX + 12) + 'px';
      tooltip.style.top = (e.clientY + 12) + 'px';
    }
  }
});

canvas.addEventListener('mouseup', () => {
  if (panning) {
    panning = false;
    canvas.classList.remove('dragging');
    return;
  }
  if (dragging) {
    if (dragMoved) {
      schedulePositionSave();
    } else {
      openFile(dragging);
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

// Double-click empty space to re-fit the whole graph.
canvas.addEventListener('dblclick', e => {
  const { x, y } = toWorld(getMouse(e));
  if (!pickNode(x, y)) { fitView(); render(); }
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
    } catch {}
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
  if (norm !== root && !norm.startsWith(root + '/')) return;
  window.location.href = `vscode://file/${encodeURI(abs)}`;
}

document.getElementById('reLayout').onclick = async () => {
  try {
    await fetch(`/api/stack/${encodeURIComponent(project)}/layout`, { method: 'DELETE' });
  } catch {}
  savedPositions = null;
  layoutInitial();
  if (!simRunning) loop();
};

document.getElementById('layoutMode').onchange = (e) => {
  layoutMode = e.target.value;
  layoutInitial();
  if (!simRunning) loop();
};

document.getElementById('toggleActivity').onclick = () => {
  showActivity = !showActivity;
  document.getElementById('toggleActivity').textContent = `نشاط: ${showActivity ? 'ON' : 'OFF'}`;
  render();
};

function loop() {
  simRunning = true;
  const energy = step();
  if (!centered) {
    if (energy < 2.0) settleTicks++; else settleTicks = 0;
    if (settleTicks > 8) {
      // Final de-overlap pass: forces have cooled, so push any still-overlapping
      // boxes fully apart before freezing the layout.
      for (let i = 0; i < 40; i++) resolveCollisions();
      fitView();
      centered = true;
    }
  }
  render();
  if (energy > 0.4 || dragging || !centered) {
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
    if (p && isFinite(p.x) && isFinite(p.y)) {
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
  if (!project) {
    statusEl.textContent = 'لا يوجد مشروع محدد في ?project=';
    return;
  }
  try {
    const [stackRes, layoutRes, dataRes] = await Promise.all([
      fetch(`/api/stack/${encodeURIComponent(project)}`),
      fetch(`/api/stack/${encodeURIComponent(project)}/layout`),
      fetch('/api/data'),
    ]);
    if (dataRes.ok) {
      try {
        const d = await dataRes.json();
        projectTags = (d.tags || []).filter(t => t.project === project);
      } catch { projectTags = []; }
    }
    if (!stackRes.ok) throw new Error(`HTTP ${stackRes.status}`);
    const data = await stackRes.json();
    if (!data.parsed || !data.parsed.files?.length) {
      statusEl.textContent = 'STACK.md غير موجود — شغّل مسح المشروع أولاً';
      return;
    }
    projectPath = data.projectPath || null;
    if (layoutRes.ok) {
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
