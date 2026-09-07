// Pure graph helpers for the stack-map page (split out of stack-map.js,
// size ratchet, wave 3): name normalization for legacy references,
// semantic clustering of file paths, and the activity-glow curve.

export function normalize(name) {
  return name.replace(/^.*\//, '').replace(/\.[^.]+$/, '');
}

// Semantic clusters: filename-token families beat raw directories when a
// project keeps most files flat in src/ (helper: 20/29). A first-token family
// (routes-*, doc-*) needs ≥2 members in the same directory to count; otherwise
// the file falls back to its directory ('root' for top-level non-UI files).
export function buildGroupIndex(paths) {
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

// Does a tag's text name THIS file? (#1159) True for the full path
// (`src/data.ts`, either slash), or for the bare filename standing alone as
// a token — never a substring: `data.ts` must not light for «dashboard-data.js»
// or «metadata.ts», and `index.html` must not light every index.html in the
// tree. `ambiguous` = another node shares the filename; then only the path
// counts, because the bare name cannot say which one the tag meant.
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Whole-token occurrence: nothing path-ish right before, nothing word-ish after
// — so `src/data.ts` is not found inside `assets/src/data.ts`, nor `data.ts`
// inside `metadata.ts`.
const mentionsToken = (c, tok) => new RegExp(`(^|[^\\w./-])${escapeRe(tok)}(?=$|[^\\w-])`).test(c);
export function tagMentionsFile(content, path, ambiguous = false) {
  const c = String(content || '').toLowerCase().replace(/\\/g, '/');
  const p = String(path || '').toLowerCase().replace(/\\/g, '/');
  if (!p) return false;
  if (mentionsToken(c, p)) return true;
  if (ambiguous) return false;
  return mentionsToken(c, p.slice(p.lastIndexOf('/') + 1));
}

// Stamp `n.activity = { days, tag, content }` (or null) on every node from the
// newest built / bug fix / refactor tag that names its file — see
// tagMentionsFile for what «names» means. Nodes sharing a filename are
// ambiguous: only a full-path mention lights them.
export function computeActivity(nodes, tags, now = Date.now()) {
  const relevantTags = ['built', 'bug fix', 'refactor'];
  // TagEntry.timestamp is an ISO string — the old numeric arithmetic on it
  // produced NaN, so the glow never fired on real data (latent since launch).
  const ts = t => typeof t.timestamp === 'number' ? t.timestamp : Date.parse(t.timestamp) || 0;
  const filtered = (tags || []).filter(t => relevantTags.includes(t.tag));
  const nameCount = new Map();
  for (const n of nodes) nameCount.set(n.label.toLowerCase(), (nameCount.get(n.label.toLowerCase()) || 0) + 1);
  for (const n of nodes) {
    const ambiguous = nameCount.get(n.label.toLowerCase()) > 1;
    let best = null;
    for (const t of filtered) {
      if (tagMentionsFile(t.content, n.path, ambiguous) && (!best || ts(t) > ts(best))) best = t;
    }
    n.activity = best ? { days: Math.floor((now - ts(best)) / 86400000), tag: best.tag, content: best.content } : null;
  }
}

// Importance is encoded by size alone (three tiers, spread wide enough to
// read at a glance now that color no longer helps).
export function activityGlow(days) {
  if (days <= 1) return 1.0;
  if (days <= 3) return 0.8;
  if (days <= 7) return 0.55;
  if (days <= 14) return 0.3;
  return 0;
}
