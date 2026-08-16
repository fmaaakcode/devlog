// The store: where DevLog's state lives on disk and how it is read and written.
// Everything else in the codebase gets its data through this module.
//
// The state is SPLIT across sibling files (tags.json, events.json, plans.json,
// projects.json, meta.json — the `F` map) rather than one data.json, because a
// single file meant every write rewrote the whole history. Saving is staged in
// WRITE_PHASES and each file is written atomically (temp + rename), so a crash
// mid-save can never leave a half-written store; DATA_DIR honors
// DEVLOG_DATA_DIR (and the test-isolation guard makes sure a test run can never
// point at the user's real data).
//
// Concurrency has exactly one rule: any handler that reads, mutates and writes
// back MUST go through withData(). It serializes the whole load → mutate → save
// cycle, and drops the shared cache if the mutation throws so a half-applied
// state can never be persisted later. Reading `data` directly and saving is the
// bug this module exists to prevent.
//
// Tag SEMANTICS (the closure vocabulary, the open-item resolvers, text
// normalization) live in ./open-items — pure rules with no I/O. They are
// re-exported below, so `from "./data"` keeps working for every existing
// caller.

import { existsSync, readdirSync } from "node:fs";
import { mkdir, open, rename } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { DevLogData, InjectionConfig } from "./types";
import { normalizeSlashes } from "./path-utils";
import { withLockRetry } from "./fs-retry";
import { assertTestDataDirIsolated } from "./data-guard";
import { isStepClosed, normalizeTagContent, NUMBERED_TAGS } from "./open-items";

// Tag semantics moved to ./open-items (file-size ratchet); re-exported so the
// ~40 existing `from "./data"` call sites stay valid.
export {
  normalizeTagContent, SECURITY_OPEN_TAGS, isReport, CLOSER_FOR, CLOSER_KINDS, OPENER_TO_CLOSER,
  NUMBERED_OPENABLE, NUMBERED_TAGS, CLOSURE_TAGS, leadingNums, singleHashNum, closedNums,
  latestCloserTs, openTodos, openBugs, openSecurity, isStepClosed, openPlanSteps,
  openOutdatedLibs, inflightClosures,
} from "./open-items";
export type { OpenItemOpts, OpenPlanStep, OutdatedLib, InflightClosures } from "./open-items";

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

/**
 * Reduce a stored global injection config to the keys that actually DIFFER from
 * the code defaults (#810).
 *
 * The store used to hold the fully-merged blob — every key, whether or not the
 * user ever touched it. Because `getEffectiveConfig` layers DEFAULT < stored <
 * per-project, a key frozen in the store outranks the default forever: flipping
 * a default in code then reached nobody who already had a config on disk. That
 * is how `preToolUseRead` stayed off everywhere after its default became `true`.
 *
 * Persisting only the deltas restores the intended precedence: an untouched key
 * is ABSENT, so it follows the default and picks up future changes; a key the
 * user deliberately set still differs, so it survives and keeps winning. Unknown
 * keys (renamed or removed settings) are dropped rather than carried forever.
 *
 * Applied on both load and save, so the invariant holds no matter which write
 * path ran — and an existing full-blob store is normalized the first time it is
 * read, not only after the next dashboard toggle.
 */
export function injectionOverrides(cfg: Partial<InjectionConfig> | undefined): Partial<InjectionConfig> {
  const out: Partial<InjectionConfig> = {};
  for (const key of Object.keys(DEFAULT_INJECTION_CONFIG) as (keyof InjectionConfig)[]) {
    const v = cfg?.[key];
    if (v === undefined) continue;
    if (v !== DEFAULT_INJECTION_CONFIG[key]) out[key] = v;
  }
  return out;
}

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
// Refuse a non-temporary DATA_DIR under bun test (#736) — see data-guard.ts.
assertTestDataDirIsolated(process.env.NODE_ENV, DATA_DIR, tmpdir());

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

/**
 * Drop the in-memory store cache so the next reader reloads from disk. For the
 * top-level uncaughtException/unhandledRejection handlers: an error that never
 * passed through withData's catch leaves the shared object half-mutated, and
 * the next successful save would persist that state with no trace.
 */
export function dropCache(): void {
  cache = null;
}
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
  // Split layout wins when ANY of its five stores exists — not projects.json
  // alone (#761): a missing projects.json with intact tags/events fell through
  // to legacy/empty, and the first save overwrote the survivors with [].
  if (Object.values(F).some(p => existsSync(p))) {
    if (!existsSync(F.projects)) console.error("[store] projects.json missing while sibling split stores exist — booting an empty registry; tags/events/plans load intact and projects re-register on their next hook event.");
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
      prompts: meta.prompts || [],
      injections: meta.injections || [],
      injectionConfig: injectionOverrides(meta.injectionConfig),
      projectInjectionConfigs: meta.projectInjectionConfigs || {},
      descendants: meta.descendants || [],
      rejections: meta.rejections || [],
      migrations: meta.migrations || {},
      processedBatches: meta.processedBatches || [],
    };
  }
  // Legacy fallback + migration. Same armored read as the split stores: a
  // corrupt data.json quarantines (with retry on transient locks) instead of
  // throwing the whole boot — the split path already got this care, the
  // migration path never did.
  const legacy = Bun.file(DATA_FILE);
  if (await legacy.exists()) {
    const raw = await readJsonOr<Partial<DevLogData> & { changes?: DevLogData["events"] }>(DATA_FILE, {});
    const data: DevLogData = {
      projects: raw.projects || {},
      events: raw.events || raw.changes || [],
      tags: raw.tags || [],
      plans: raw.plans || [],
      worklog: raw.worklog || [],
      prompts: raw.prompts || [],
      injections: raw.injections || [],
      injectionConfig: injectionOverrides(raw.injectionConfig),
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
    projects: {}, events: [], tags: [], plans: [], worklog: [], prompts: [],
    injections: [], injectionConfig: {}, projectInjectionConfigs: {},
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
  // #781: the rename is where a transient AV lock lands; canonical stays intact.
  await withLockRetry(() => rename(tmp, path));
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
      prompts: data.prompts || [],
      injections: data.injections,
      injectionConfig: injectionOverrides(data.injectionConfig),
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

// NOT exported (audit 2026-08-13, هـ‑2): when a write is in flight this
// coalesces into pendingWrite and returns BEFORE anything hits the disk — an
// awaiting caller that then reads the file sees old bytes. Every caller must go
// through withData, whose FIFO lock is what actually upholds the
// "awaited means persisted" contract; exporting this left the trap open to the
// first new caller.
async function saveData(data: DevLogData) {
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

// Shared engine of the two one-time cleanups below: splice out every tag of
// one kind whose content is a malformed package descriptor, gated on v1/v2
// migration flags (both flags are stamped so a store that never ran v1 skips
// straight past it). Splicing rather than emitting a fix tag keeps the record
// clean: these were scanner artifacts, and a phantom incident shouldn't appear
// in release notes as "vulnerability resolved". Idempotent; returns the number
// of tags removed.
function cleanupMalformedTags(data: DevLogData, tag: string, v1Key: string, v2Key: string): number {
  if (!data.migrations) data.migrations = {};
  if (data.migrations[v2Key]) return 0;
  const before = data.tags.length;
  data.tags = data.tags.filter(t => !(t.tag === tag && isMalformedPkgDescriptor(t.content)));
  const removed = before - data.tags.length;
  data.migrations[v1Key] = true;
  data.migrations[v2Key] = true;
  return removed;
}

/**
 * One-time cleanup: delete malformed `security` tags created by older
 * Vuln API versions (pre-v0.5.1-beta) that returned bogus results for
 * unscannable inputs (vendored / undefined / null / unknown packages).
 *
 * Strict pattern: name AND/OR version is one of `undefined`, `null`,
 * `unknown`, `system`, `bundled`, or starts with `vendored-`. Only `tag`
 * === "security" is touched (not `security:own` / `security:dep` — those
 * are user-authored and more sensitive).
 *
 * v2 re-runs to catch a second source of the same content shape: a runtime
 * check that hit a 4xx response and produced `undefined  — undefined`. The
 * root cause is fixed at the call site, so this is purely retrospective.
 */
export function cleanupMalformedSecurityTags(data: DevLogData): number {
  return cleanupMalformedTags(data, "security", "cleanup_malformed_security_v1", "cleanup_malformed_security_v2");
}

/**
 * One-time cleanup: delete malformed `outdated` tags created when older
 * Vuln API versions cross-matched a vendored/undefined package against an
 * unrelated registry entry and reported a bogus latest version (e.g.
 * `rnnoise@vendored-unknown — احدث: 0.1.8`). Same shape detection as the
 * security cleanup.
 *
 * v2 re-runs because the regex was fixed to keep hyphens inside the version
 * capture (so `vendored-unknown` isn't truncated to `vendored` and skipped).
 */
export function cleanupMalformedOutdatedTags(data: DevLogData): number {
  return cleanupMalformedTags(data, "outdated", "cleanup_malformed_outdated_v1", "cleanup_malformed_outdated_v2");
}

/**
 * Backfill `num` on tags + plan steps for items that pre-date the numbering
 * feature. Idempotent: skips items already numbered. Touches `nextItemNum`
 * on each project profile so future allocations continue cleanly.
 *
 * Returns true if anything changed (caller may want to persist).
 */
export function backfillNums(data: DevLogData): boolean {
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
  // Throw, never a plausible-looking number: every silent `return 1` hands two
  // items the same #N, and closure matches by number alone — one -(done) #1
  // would close both. All callers guard on data.projects[project] first.
  if (!profile) throw new Error(`assignNum: unknown project "${project}"`);

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
