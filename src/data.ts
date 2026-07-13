import { existsSync, readdirSync } from "node:fs";
import { mkdir, open, rename } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { DevLogData, InjectionConfig, PlanStep, ProjectProfile, TagEntry } from "./types";
import { normalizeSlashes } from "./path-utils";

export const DEFAULT_INJECTION_CONFIG: InjectionConfig = {
  sessionStart: true,
  // Conditional injection: returns empty unless Claude closed something
  // since last inject (siblings reminder) OR user typed `?open`. Cheap by
  // default — see inject.ts buildContext for the gating.
  userPromptSubmit: true,
  // Position memory (#486): inject a file's tag history the first time a
  // session opens it. On by default — fires only when the file HAS a story,
  // at most once per file per session; opt out per project via the dashboard.
  preToolUseRead: true,
  outdatedLibs: true, // surface outdated libs at SessionStart; opt out per project
  describeNudge: true, // nudge for missing desc/about; survives sessionStart off
  upcomingItems: true, // show the «قادمة» awareness line in the open summaries
  claudeMd: false,
  contextMd: false,
  standardsEnforce: true, // standards enforcement ON by default; opt out per project
};

// Base dir for data + static files. In a compiled single-file binary,
// import.meta.dir points into Bun's virtual fs ("$bunfs" / "~BUN"), which is
// read-only — so data must live next to the executable instead. In dev it is
// the repo root (parent of src/). DEVLOG_DATA_DIR always overrides.
const COMPILED = import.meta.dir.includes("$bunfs") || import.meta.dir.includes("~BUN");
const DIR = COMPILED ? dirname(process.execPath) : import.meta.dir.replace(/[\\/]src$/, "");
export const DATA_FILE = `${DIR}/data.json`;            // legacy (kept for migration)
// When DevLog runs as a Claude Code plugin, its code lives in the plugin cache,
// which Claude Code REPLACES wholesale on every `/plugin update` — writing data
// under DIR there would wipe the user's entire history on the first update. The
// hook that spawns the server (ensure-server.sh, invoked as a plugin hook) has
// CLAUDE_PLUGIN_ROOT in its env, which the detached server inherits, so we use it
// to detect plugin mode and store data in a stable per-user dir that survives
// updates. DEVLOG_DATA_DIR always overrides; a manual `bun start` from the repo
// (no CLAUDE_PLUGIN_ROOT) keeps the in-repo .devlog-data as before.
export const PLUGIN_MODE = !!process.env.CLAUDE_PLUGIN_ROOT;
export const DATA_DIR = process.env.DEVLOG_DATA_DIR
  || (PLUGIN_MODE ? join(homedir(), ".devlog", "data") : `${DIR}/.devlog-data`);
const F = {
  projects: `${DATA_DIR}/projects.json`,
  tags:     `${DATA_DIR}/tags.json`,
  events:   `${DATA_DIR}/events.json`,
  plans:    `${DATA_DIR}/plans.json`,
  meta:     `${DATA_DIR}/meta.json`,
} as const;
// R3 #6: a garbled DEVLOG_PORT used to flow NaN into Bun.serve (opaque boot
// failure) and into every list derived from PORT (e.g. allowed hosts). Fall
// back to the default with a loud line instead — a wrong-but-running port is
// diagnosable, a NaN boot crash is not. Exported for unit tests.
export function resolvePort(raw: string | undefined, fallback = 7777): number {
  const p = parseInt(raw ?? "", 10);
  if (Number.isInteger(p) && p > 0 && p < 65536) return p;
  if (raw !== undefined) console.error(`[config] DEVLOG_PORT=${JSON.stringify(raw)} is not a valid TCP port — using ${fallback}`);
  return fallback;
}
export const PORT = resolvePort(process.env.DEVLOG_PORT);

let cache: DevLogData | null = null;
let loadPromise: Promise<DevLogData> | null = null;

async function readJsonOr<T>(path: string, fallback: T): Promise<T> {
  const f = Bun.file(path);
  if (!(await f.exists())) return fallback;
  // Read and parse SEPARATELY: only a parse failure means corruption. Lumping
  // them (the old `f.json()` catch) meant a transient Windows read error —
  // AV/backup briefly holding the file (EBUSY/EACCES) — took the quarantine
  // path too: a healthy store renamed away and the server booting an empty
  // registry that the next save persists (R3 review). Reads get a short retry
  // for exactly those locks, then PROPAGATE — a loud failed boot with the
  // store intact beats a quiet boot with the store gone.
  let text: string;
  for (let attempt = 1; ; attempt++) {
    try { text = await f.text(); break; }
    catch (e) {
      if (attempt >= 3) {
        console.error(`[store] ${path} unreadable after ${attempt} attempts (${(e as Error)?.message}) — NOT quarantining; failing this load so the on-disk store stays authoritative.`);
        throw e;
      }
      await Bun.sleep(150 * attempt);
    }
  }
  try { return JSON.parse(text) as T; }
  catch (e) {
    // A PRESENT-but-unparseable store is not a soft failure: silently returning
    // the fallback meant the next save rewrote the file and buried the history
    // for good (#432). Quarantine the corrupt original under a dated name — the
    // next save then writes a fresh file while the evidence stays on disk for
    // manual recovery (`.corrupt-*` never matches the `.bak` pruning) — and say
    // so loudly; this is the one read failure that must never pass unnoticed.
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const dest = `${path}.corrupt-${stamp}`;
    try { await rename(path, dest); } catch { /* rename failed → leave it; next save overwrites */ }
    // Name the actual newest .bak instead of promising one exists — meta.json
    // had no backups at all while this line told the user to restore from one.
    let bakHint = "none — this store has no .bak backups";
    try {
      const base = path.split(/[\\/]/).pop()?.replace(/\.json$/, "") ?? "";
      const baks = readdirSync(dirname(path)).filter(f => f.startsWith(`${base}.`) && f.endsWith(".bak")).sort();
      if (baks.length) bakHint = baks[baks.length - 1];
    } catch { /* unreadable dir — keep the "none" hint */ }
    console.error(`[store] ${path} is corrupt (${(e as Error)?.message}) — quarantined to ${dest}; continuing with an empty store. Newest backup: ${bakHint}.`);
    return fallback;
  }
}

async function readFromDisk(): Promise<DevLogData> {
  // Prefer split layout if projects.json exists.
  if (existsSync(F.projects)) {
    const projects = await readJsonOr<DevLogData["projects"]>(F.projects, {});
    const tags = await readJsonOr<DevLogData["tags"]>(F.tags, []);
    const events = await readJsonOr<DevLogData["events"]>(F.events, []);
    const plans = await readJsonOr<DevLogData["plans"]>(F.plans, []);
    const meta = await readJsonOr<Partial<DevLogData>>(F.meta, {});
    return {
      projects,
      tags,
      events,
      plans,
      worklog: meta.worklog || [],
      injections: meta.injections || [],
      injectionConfig: { ...DEFAULT_INJECTION_CONFIG, ...(meta.injectionConfig || {}) },
      projectInjectionConfigs: meta.projectInjectionConfigs || {},
      descendants: meta.descendants || [],
      rejections: meta.rejections || [],
      migrations: meta.migrations || {},
      processedBatches: meta.processedBatches || [],
    };
  }
  // Legacy fallback + migration.
  const legacy = Bun.file(DATA_FILE);
  if (await legacy.exists()) {
    const raw = await legacy.json();
    const data: DevLogData = {
      projects: raw.projects || {},
      events: raw.events || raw.changes || [],
      tags: raw.tags || [],
      plans: raw.plans || [],
      worklog: raw.worklog || [],
      injections: raw.injections || [],
      injectionConfig: { ...DEFAULT_INJECTION_CONFIG, ...(raw.injectionConfig || {}) },
      projectInjectionConfigs: raw.projectInjectionConfigs || {},
      descendants: raw.descendants || [],
      rejections: raw.rejections || [],
      migrations: raw.migrations || {},
      processedBatches: raw.processedBatches || [],
    };
    await migrateToSplit(data);
    return data;
  }
  return {
    projects: {}, events: [], tags: [], plans: [], worklog: [],
    injections: [], injectionConfig: { ...DEFAULT_INJECTION_CONFIG }, projectInjectionConfigs: {},
    descendants: [],
    rejections: [],
    migrations: {},
    processedBatches: [],
  };
}

async function migrateToSplit(data: DevLogData) {
  await mkdir(DATA_DIR, { recursive: true });
  await writeAllSplit(data);
  // Keep data.json as backup so we never lose original; suffix with timestamp.
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    await rename(DATA_FILE, `${DATA_FILE}.${stamp}.bak`);
    console.log(`[migrate] split layout written; legacy data.json moved to data.json.${stamp}.bak`);
  } catch (e) {
    console.error("[migrate] backup rename failed:", (e as Error)?.message);
  }
}

// Write to a sibling .tmp file then atomically rename over the target.
// Crash mid-write leaves an orphan .tmp; the canonical file stays intact.
// fsync before the rename: without it the content can sit in the page cache
// while the rename's metadata hits the journal first — a power cut then leaves
// a truncated/empty canonical file. ~1-5ms per store write; the lastWritten
// hash-skip keeps the hook path well under 10ms.
async function atomicWrite(path: string, body: string): Promise<void> {
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  const fh = await open(tmp, "w");
  try {
    await fh.writeFile(body);
    await fh.sync();
  } finally {
    await fh.close();
  }
  await rename(tmp, path);
}

// Hash of the last body written to each section file, so an append that only
// touches `events` doesn't rewrite the (much larger) `tags`+`events`+rest blob
// every time — write amplification was ~5MB per single-event hook (R4 devops F2).
const lastWritten = new Map<string, string>();

// #596: no transaction spans the five split stores, so ORDER is the consistency
// bound — row streams (tags/events/plans) land before the files that count or
// summarize them (projects' nextItemNum, meta's flags/batch fingerprints). A
// mid-group death then only leaves counters BEHIND rows, the direction assignNum
// and the idempotent migrations already self-heal; the reverse tear is not.
export const WRITE_PHASES: ReadonlyArray<ReadonlyArray<keyof typeof F>> =
  [["tags", "events", "plans"], ["projects", "meta"]];

async function writeAllSplit(data: DevLogData) {
  await mkdir(DATA_DIR, { recursive: true });
  // Compact (no `null, 2`): these are machine-read data files, not human-edited;
  // pretty-printing inflated every write ~30-40% for no benefit (R4 devops F2).
  const bodies: Record<keyof typeof F, string> = {
    projects: JSON.stringify(data.projects),
    tags:     JSON.stringify(data.tags),
    events:   JSON.stringify(data.events),
    plans:    JSON.stringify(data.plans),
    meta:     JSON.stringify({
      worklog: data.worklog,
      injections: data.injections,
      injectionConfig: data.injectionConfig,
      projectInjectionConfigs: data.projectInjectionConfigs,
      descendants: data.descendants,
      rejections: data.rejections || [], // was dropped on every write → lost on reload (#32)
      migrations: data.migrations || {},
      processedBatches: data.processedBatches || [],
    }),
  };
  for (const phase of WRITE_PHASES) {
    await Promise.all(phase.map(async (k) => {
      const p = F[k];
      const h = String(Bun.hash(bodies[k]));
      // Skip the I/O only when this section is byte-identical to our last write
      // AND the file is actually on disk (guards against external deletion / a
      // test that wiped DATA_DIR but kept this in-process cache).
      if (lastWritten.get(p) === h && existsSync(p)) return;
      await atomicWrite(p, bodies[k]);
      lastWritten.set(p, h);
    }));
  }
}

export async function loadData(): Promise<DevLogData> {
  if (cache) return cache;
  if (!loadPromise) {
    loadPromise = readFromDisk().then(
      d => { cache = d; loadPromise = null; return d; },
      // readJsonOr now propagates unreadable-file errors (transient locks)
      // instead of quarantining. Clear the in-flight slot so the NEXT call
      // retries from disk — caching the rejection would wedge every future
      // loadData behind one transient failure.
      err => { loadPromise = null; throw err; },
    );
  }
  return loadPromise;
}

let lastCleanup = 0;
const CLEANUP_INTERVAL = 3600000; // 1 hour

// Backup housekeeping (cleanupOldBackups / backupStores) moved to
// ./maintenance.ts with the upcoming feature — file-size budget.

export async function cleanupMissingProjects(data: DevLogData): Promise<boolean> {
  if (Date.now() - lastCleanup < CLEANUP_INTERVAL) return false;
  lastCleanup = Date.now();
  // P1.1: never auto-delete. A missing path may be a temporarily disconnected
  // external drive, WSL mount, or network share — silent deletion of all tags
  // + plans is unrecoverable. Mark instead; a manual cleanup endpoint can
  // delete tombstones older than e.g. 30 days when the user opts in.
  let changed = false;
  for (const [_name, project] of Object.entries(data.projects)) {
    if (!project.path) continue;
    const present = existsSync(project.path);
    if (!present && !project.disconnectedSince) {
      project.disconnectedSince = new Date().toISOString();
      changed = true;
    } else if (present && project.disconnectedSince) {
      delete project.disconnectedSince;
      changed = true;
    }
  }
  if (changed) await saveData(data);
  return changed;
}

// Maintenance verdicts (orphans / tombstones / purge / untagged sessions) live
// in ./maintenance — extracted for the file-size budget; pure functions only.

// Write lock to prevent concurrent writes corrupting data.json
let writing = false;
let pendingWrite: DevLogData | null = null;

export async function saveData(data: DevLogData) {
  cache = data;
  if (writing) {
    pendingWrite = data;
    return;
  }
  writing = true;
  try {
    await writeAllSplit(data);
  } finally {
    writing = false;
    if (pendingWrite) {
      const next = pendingWrite;
      pendingWrite = null;
      await saveData(next);
    }
  }
}

/**
 * Serialize a load → mutate → save cycle. Use this for any handler that
 * reads `data`, mutates it, and writes back — without it, two concurrent
 * handlers can read the same snapshot, both push, and produce duplicates
 * (typical race in dedup logic). Returns whatever the inner function returns.
 *
 * The lock is process-wide and FIFO; throughput is bounded by serialized
 * writes, which is acceptable for a single-user localhost server.
 */
let mutationLock: Promise<unknown> = Promise.resolve();

export async function withData<T>(fn: (data: DevLogData) => Promise<T> | T): Promise<T> {
  const prev = mutationLock;
  let release: () => void = () => { /* replaced with the real resolver on the next line */ };
  mutationLock = new Promise<void>(r => { release = r; });
  try {
    await prev.catch(() => { /* wait for previous holder; its error is not ours */ });
    const data = await loadData();
    try {
      const result = await fn(data);
      await saveData(data);
      return result;
    } catch (err) {
      // #449: fn mutates the SHARED cache object in place. If it throws after
      // a partial mutation, nothing is saved (good) — but the cache would keep
      // the half-applied state, and the next successful save would persist it
      // to disk with no trace. Drop the cache so the next reader reloads the
      // last consistent state from disk. Cheaper than structuredClone-ing the
      // whole store on every mutation just to guard the rare failure path.
      cache = null;
      throw err;
    }
  } finally {
    release();
  }
}

/**
 * One-time cleanup: delete malformed `security` tags created by older
 * Vuln API versions (pre-v0.5.1-beta) that returned bogus results for
 * unscannable inputs (vendored / undefined / null / unknown packages).
 *
 * These were never real vulnerabilities — they were scanner artifacts.
 * We splice them out entirely (rather than emitting `security fix`) so
 * the project's security record stays clean: a phantom incident shouldn't
 * appear in release notes as "vulnerability resolved".
 *
 * Strict pattern: name AND/OR version is one of `undefined`, `null`,
 * `unknown`, `system`, `bundled`, or starts with `vendored-`. Only `tag`
 * === "security" is touched (not `security:own` / `security:dep` — those
 * are user-authored and more sensitive).
 *
 * Idempotent via `data.migrations.cleanup_malformed_security_v1`. Returns
 * the number of tags removed.
 */
/**
 * Normalize tag content for closure matching. Strips inline-code backticks,
 * collapses runs of whitespace, lowercases, and trims. Used by every
 * `text === text` comparison that backs todo↔done, bug found↔fix,
 * security↔security fix, dedup, and plan-step sync.
 *
 * Without this, a one-byte difference (extra space, backtick, hidden zero-
 * width space) leaves an item permanently open. Closure-by-`#N` avoids the
 * issue entirely; this helper is the safety net for the legacy text path.
 */
export function normalizeTagContent(s: string): string {
  return s
    .replace(/`[^`\n]*`/g, " ") // strip inline-code (` `code` ` → ` `)
    .replace(/`/g, "")           // any stray backticks
    .replace(/\s+/g, " ")        // collapse whitespace
    .trim()
    .toLowerCase();
}

// ─── Open-item resolution (single source of truth) ──────────────────────
// One question — "which items are still open?" — must be answered identically
// for the SessionStart summary (inject.ts), the DEVLOG_STATUS.md export
// (export.ts), the doctor audit (doctor.ts), and the /api/open-items
// release-guard (server.ts). Each used to carry its own copy and they diverged:
// export ignored `#N` closures and `security:own/:dep` entirely (so a `-(done)
// #5` item stayed open forever in DEVLOG_STATUS.md), and doctor's `#N` closure
// was not type-matched. Centralizing here is remediation round-3 P1.

/** Open security tags — `security`, `security:own`, `security:dep` all count. */
export const SECURITY_OPEN_TAGS = new Set(["security", "security:own", "security:dep"]);

// ─── Closure vocabulary (single source of truth, #409) ──────────────────────
// The entire closure grammar derives from ONE table: each OPENER tag → the
// closer verb(s) that legitimately close it (type-matched). tags-service and
// closed-items used to keep their own copies (CLOSER_KINDS, OPENER_TO_CLOSER,
// NUMBERED_OPENABLE, CLOSER_FOR) which could silently drift; they now import
// these derived views so there is exactly one place to change the vocabulary.

/** Opener tag → closer verb(s) that close it (type-matched). */
export const CLOSER_FOR: Record<string, string[]> = {
  "todo": ["done", "dropped"],
  "bug found": ["bug fix"],
  "security": ["security fix"],
  "security:own": ["security fix"],
  "security:dep": ["security fix"],
};

/** Closer verb → opener tag(s) it can close (inverse of CLOSER_FOR), so a
 *  `-(bug fix) #5` never closes a todo #5. */
export const CLOSER_KINDS: Record<string, string[]> = (() => {
  const inv: Record<string, string[]> = {};
  for (const [opener, closers] of Object.entries(CLOSER_FOR)) {
    for (const c of closers) {
      if (!inv[c]) inv[c] = [];
      inv[c].push(opener);
    }
  }
  return inv;
})();

/** Opener tag → the single verb to SUGGEST when the wrong closer was used (the
 *  first/primary closer; `dropped` is an alternate for todo, not the suggestion). */
export const OPENER_TO_CLOSER: Record<string, string> =
  Object.fromEntries(Object.entries(CLOSER_FOR).map(([o, cs]) => [o, cs[0]]));

/** All numbered openable tags (keys of CLOSER_FOR). */
export const NUMBERED_OPENABLE = new Set(Object.keys(CLOSER_FOR));

/** Tags that close an open item (keys of CLOSER_KINDS). */
export const CLOSURE_TAGS = new Set(Object.keys(CLOSER_KINDS));

/**
 * The LEADING `#N #M …` run of a closer's content, as numbers. Matching stops at
 * the first token that isn't a `#N`, so `-(done) #5 #6` yields [5, 6] while a
 * `#N` in trailing prose (`-(done) #5 — same root as bug #11, see PR #312`) does
 * NOT include #11/#312 — that would silently lose an unrelated open item (R4
 * code-quality F3). Shared by closedNums (below) and closed-items (#409).
 */
export function leadingNums(content: string): number[] {
  const prefix = (content || "").match(/^(?:\s*#\d+)+/);
  return prefix ? [...prefix[0].matchAll(/#(\d+)/g)].map(m => parseInt(m[1], 10)) : [];
}

/**
 * A closer whose content is a SINGLE bare `#N` (whole content, optional `#`,
 * surrounding whitespace) → N, else null. Distinct from the leading-run parser:
 * used by closure resolution / diagnosis / undo, which act on one number only.
 */
export function singleHashNum(content: string): number | null {
  const m = (content || "").match(/^#?\s*(\d+)\s*$/);
  return m ? parseInt(m[1], 10) : null;
}

/**
 * Numbers closed via `-(kind) #N`. Pass ONLY the closure kinds that legitimately
 * close the item type ("type-matched"), so a `-(bug fix) #5` never closes a
 * todo #5. Uses leadingNums, so trailing non-`#N` prose is ignored.
 */
export function closedNums(tags: TagEntry[], kinds: string[]): Set<number> {
  const nums = new Set<number>();
  for (const t of tags) {
    if (!kinds.includes(t.tag)) continue;
    for (const n of leadingNums(t.content || "")) nums.add(n);
  }
  return nums;
}

// Orphan closure GC (#230) lives in ./orphan-closures — extracted under the
// file-size budget; pure over the tags array, consumed by server startup only.

export interface OpenItemOpts {
  /**
   * When true, drop items that lack a `num`. The release-guard (/api/open-items)
   * and doctor only track numbered items; the inject summary and the export
   * list everything. This is the ONE axis on which the four consumers legitimately
   * differ — closure semantics stay identical across all of them.
   */
  numberedOnly?: boolean;
}

function passesNum(t: { num?: number }, opts: OpenItemOpts): boolean {
  return !opts.numberedOnly || typeof t.num === "number";
}

/** Todos with no matching `-(done)`/`-(dropped)` closure (by text or by `#N`). */
export function openTodos(tags: TagEntry[], opts: OpenItemOpts = {}): TagEntry[] {
  const done = new Set(tags.filter(t => t.tag === "done").map(t => normalizeTagContent(t.content)));
  const dropped = new Set(tags.filter(t => t.tag === "dropped").map(t => normalizeTagContent(t.content)));
  const byNum = closedNums(tags, ["done", "dropped"]);
  return tags.filter(t => t.tag === "todo"
    && passesNum(t, opts)
    && !done.has(normalizeTagContent(t.content))
    && !dropped.has(normalizeTagContent(t.content))
    && !(typeof t.num === "number" && byNum.has(t.num)));
}

/** Bugs with no matching `-(bug fix)` closure (by text or by `#N`). */
export function openBugs(tags: TagEntry[], opts: OpenItemOpts = {}): TagEntry[] {
  const fixed = new Set(tags.filter(t => t.tag === "bug fix").map(t => normalizeTagContent(t.content)));
  const byNum = closedNums(tags, ["bug fix"]);
  return tags.filter(t => t.tag === "bug found"
    && passesNum(t, opts)
    && !fixed.has(normalizeTagContent(t.content))
    && !(typeof t.num === "number" && byNum.has(t.num)));
}

/** Security items (`security`/`security:own`/`security:dep`) with no matching
 *  `-(security fix)` closure (by text or by `#N`). */
export function openSecurity(tags: TagEntry[], opts: OpenItemOpts = {}): TagEntry[] {
  const fixed = new Set(tags.filter(t => t.tag === "security fix").map(t => normalizeTagContent(t.content)));
  const byNum = closedNums(tags, ["security fix"]);
  return tags.filter(t => SECURITY_OPEN_TAGS.has(t.tag)
    && passesNum(t, opts)
    && !fixed.has(normalizeTagContent(t.content))
    && !(typeof t.num === "number" && byNum.has(t.num)));
}

export interface OpenPlanStep {
  num?: number;
  text: string;
  phase?: string;
  planTitle: string;
  planFile: string;
  /** The owning plan is marked «قادمة» — the step stays open (and closable by
   *  `#N`) but guards/summaries must not count it as tracked debt. */
  planUpcoming?: boolean;
  /** ISO creation time of the owning plan — the best available "opened at"
   *  for a step (steps carry no per-step timestamp). */
  openedAt?: string;
}

/**
 * A plan step no longer open. Completed (`[x]` / `-(done)`) OR archived by
 * `-(dropped)`. Dropped steps stay in `plan.steps` (not spliced) so
 * already-closed detection and `-(ask:closed)` can still find them (#410); every
 * "is this step open?" check must go through here so the two closure states
 * can't drift apart the way `s.completed` alone did.
 */
export function isStepClosed(s: PlanStep): boolean {
  return s.completed || !!s.dropped;
}

/** Plan steps not yet completed and not closed by a `-(done)/-(dropped) #N`. */
export function openPlanSteps(data: DevLogData, project: string, opts: OpenItemOpts = {}): OpenPlanStep[] {
  const tags = data.tags.filter(t => t.project === project);
  const closedByDone = closedNums(tags, ["done", "dropped"]);
  const out: OpenPlanStep[] = [];
  for (const plan of data.plans) {
    if (plan.project !== project) continue;
    for (const s of plan.steps) {
      if (isStepClosed(s)) continue;
      if (opts.numberedOnly && typeof s.num !== "number") continue;
      if (typeof s.num === "number" && closedByDone.has(s.num)) continue;
      out.push({
        num: s.num, text: s.text, phase: s.phase, planTitle: plan.title, planFile: plan.file_path,
        ...(plan.upcoming ? { planUpcoming: true } : {}), openedAt: plan.timestamp,
      });
    }
  }
  return out;
}

export interface OutdatedLib {
  name: string;
  current: string;      // installed version, "" if unknown
  latest: string;       // latest available version
  daysSinceLatest: number;
}

/**
 * Libraries with a newer version that has been published longer than
 * `minAgeDays` days ago. Reads the latest vuln-scan snapshot (`vulnResults`),
 * the source of truth for version-behind (`isLatest`) + release age
 * (`daysSinceLatest`). The age gate excludes versions released <1 week ago so a
 * just-cut (possibly unstable) release doesn't immediately read as "open work".
 * Current version comes from `libraries` since VulnResult doesn't carry it.
 */
export function openOutdatedLibs(profile: ProjectProfile, minAgeDays = 7): OutdatedLib[] {
  const results = profile.vulnResults;
  if (!results) return [];
  const versionByName = new Map((profile.libraries || []).map(l => [l.name, l.version]));
  const out: OutdatedLib[] = [];
  for (const [name, r] of Object.entries(results)) {
    if (r.isLatest !== false) continue;                 // up to date or unknown
    if (!r.latestVersion) continue;
    if (typeof r.daysSinceLatest !== "number") continue;
    if (r.daysSinceLatest <= minAgeDays) continue;      // newer version too fresh
    out.push({
      name,
      current: versionByName.get(name) || "",
      latest: r.latestVersion,
      daysSinceLatest: r.daysSinceLatest,
    });
  }
  out.sort((a, b) => b.daysSinceLatest - a.daysSinceLatest);
  return out;
}

const BAD_TOKENS = new Set(["undefined", "null", "unknown", "system", "bundled", ""]);
// Match `name@version — message`. Version may contain hyphens (e.g.
// `vendored-unknown`) so the version-stop class only excludes whitespace
// and the em-dash separator, NOT the hyphen.
const MALFORMED_PARSE_RE = /^([^@\s]*)@([^\s—]*?)\s*[—-]\s/;

export function isMalformedPkgDescriptor(content: string): boolean {
  const m = content.match(MALFORMED_PARSE_RE);
  if (!m) {
    // Fallback shape: `<word> <dash> <word>` with both sides being a bad token
    // (catches `undefined  — undefined` style without `@`).
    const m2 = content.trim().match(/^(\S+)\s*[—-]+\s*(\S+)/);
    if (!m2) return false;
    return BAD_TOKENS.has(m2[1].toLowerCase()) && BAD_TOKENS.has(m2[2].toLowerCase());
  }
  const name = m[1].toLowerCase();
  const version = m[2].toLowerCase();
  if (BAD_TOKENS.has(name) || BAD_TOKENS.has(version)) return true;
  if (version.startsWith("vendored-") || name.startsWith("vendored-")) return true;
  return false;
}

export function cleanupMalformedSecurityTags(data: DevLogData): number {
  if (!data.migrations) data.migrations = {};
  // v2 re-runs to catch a second source of the same content shape: a runtime
  // check that hit a 4xx response and produced `undefined  — undefined`. The
  // root cause is fixed at the call site, so this is purely retrospective.
  if (data.migrations.cleanup_malformed_security_v2) return 0;

  const before = data.tags.length;
  data.tags = data.tags.filter(t => !(t.tag === "security" && isMalformedPkgDescriptor(t.content)));
  const removed = before - data.tags.length;
  data.migrations.cleanup_malformed_security_v1 = true;
  data.migrations.cleanup_malformed_security_v2 = true;
  return removed;
}

/**
 * One-time cleanup: delete malformed `outdated` tags created when older
 * Vuln API versions cross-matched a vendored/undefined package against an
 * unrelated registry entry and reported a bogus latest version (e.g.
 * `rnnoise@vendored-unknown — احدث: 0.1.8`). Same shape detection as the
 * security cleanup. Idempotent via `cleanup_malformed_outdated_v1` flag.
 */
export function cleanupMalformedOutdatedTags(data: DevLogData): number {
  if (!data.migrations) data.migrations = {};
  // v2: regex was fixed to keep hyphens inside the version capture (so
  // `vendored-unknown` isn't truncated to `vendored` and skipped). Re-run
  // once more to catch entries the v1 regex missed.
  if (data.migrations.cleanup_malformed_outdated_v2) return 0;

  const before = data.tags.length;
  data.tags = data.tags.filter(t => !(t.tag === "outdated" && isMalformedPkgDescriptor(t.content)));
  const removed = before - data.tags.length;
  data.migrations.cleanup_malformed_outdated_v1 = true;
  data.migrations.cleanup_malformed_outdated_v2 = true;
  return removed;
}

/**
 * Backfill `num` on tags + plan steps for items that pre-date the numbering
 * feature. Idempotent: skips items already numbered. Touches `nextItemNum`
 * on each project profile so future allocations continue cleanly.
 *
 * Returns true if anything changed (caller may want to persist).
 */
export function backfillNums(data: DevLogData): boolean {
  const NUMBERED_TAGS = new Set(["todo", "bug found", "security", "security:own", "security:dep"]);
  let changed = false;
  for (const [name, profile] of Object.entries(data.projects)) {
    let next = profile.nextItemNum ?? 0;
    if (!next) {
      let max = 0;
      for (const t of data.tags) {
        if (t.project === name && typeof t.num === "number" && t.num > max) max = t.num;
      }
      for (const p of data.plans) {
        if (p.project !== name) continue;
        for (const s of p.steps) {
          if (typeof s.num === "number" && s.num > max) max = s.num;
        }
      }
      next = max + 1;
    }
    // Number any open openable tags that lack a num
    const fixedDone = new Set(data.tags.filter(t => t.project === name && t.tag === "done").map(t => normalizeTagContent(t.content)));
    const fixedBug = new Set(data.tags.filter(t => t.project === name && t.tag === "bug fix").map(t => normalizeTagContent(t.content)));
    const fixedSec = new Set(data.tags.filter(t => t.project === name && t.tag === "security fix").map(t => normalizeTagContent(t.content)));
    for (const t of data.tags) {
      if (t.project !== name) continue;
      if (typeof t.num === "number") continue;
      if (!NUMBERED_TAGS.has(t.tag)) continue;
      const low = normalizeTagContent(t.content);
      const closed =
        (t.tag === "todo" && fixedDone.has(low)) ||
        (t.tag === "bug found" && fixedBug.has(low)) ||
        (t.tag.startsWith("security") && fixedSec.has(low));
      if (closed) continue;
      t.num = next++;
      changed = true;
    }
    // Number plan steps that lack a num (only open ones — closed steps don't
    // need a number because nobody will close them again)
    for (const p of data.plans) {
      if (p.project !== name) continue;
      for (const s of p.steps) {
        if (typeof s.num === "number") continue;
        if (isStepClosed(s)) continue;
        s.num = next++;
        changed = true;
      }
    }
    if (profile.nextItemNum !== next) {
      profile.nextItemNum = next;
      changed = true;
    }
  }
  return changed;
}

/**
 * Allocate the next monotonic item number for a project. Used to tag open
 * items (todo / bug found / security / plan step) so Claude can close them
 * by `#N` instead of verbatim text. Numbers are never reused — closed items
 * keep their number for history.
 *
 * Self-heals if `nextItemNum` is missing or behind: scans existing nums on
 * tags + plan steps for this project and starts above the max.
 */
export function assignNum(data: DevLogData, project: string): number {
  const profile = data.projects[project];
  if (!profile) return 1;

  // The persisted counter is untrustworthy on its own: applyPreservedScan used
  // to drop it, and restoring projects.json from a .bak rewinds it while
  // tags.json keeps the higher numbers — the counter and the numbered items
  // live in two files with no consistency boundary. Always take the max of the
  // persisted counter and the live high-water mark, so a behind counter can
  // never hand out a number an open item already carries (closure matches by
  // number alone — one -(done) #N would silently close both).
  let max = 0;
  for (const t of data.tags) {
    if (t.project === project && typeof t.num === "number" && t.num > max) max = t.num;
  }
  for (const p of data.plans) {
    if (p.project !== project) continue;
    for (const s of p.steps) {
      if (typeof s.num === "number" && s.num > max) max = s.num;
    }
  }

  const next = Math.max(profile.nextItemNum ?? 0, max + 1);
  profile.nextItemNum = next + 1;
  return next;
}

export function projectName(cwd: string): string {
  return normalizeSlashes(cwd).split("/").filter(Boolean).pop() || "unknown";
}
